// Facet translation: lowers `$ = { k1: $$.filter(p1), k2: $$.filter(p2), … }`
// into a `$facet` aggregation stage.
//
// The user pattern: an object-literal RHS of `$ = …` where every value is a
// `$$.filter(<predicate>)` call. Each entry's predicate lambda becomes the
// sub-pipeline body for that facet key:
//
//   $ = {
//     topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }),
//     recent:     $$.filter(o => o.createdAt >= new Date("2026-01-01")),
//     byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); }),
//   };
//
//   → [{ $facet: {
//         topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
//         recent:     [{ $match: { createdAt: { $gte: <Date> } } }],
//         byStatus:   [{ $group: { _id: "$status", n: { $sum: 1 } } }]
//       } }]
//
// Sister to lookup-translation (which handles `$$$.<coll>.find/filter` →
// `$lookup`) and union-translation (which handles `$$.push` → `$unionWith`).
// All three lower their predicate lambda through `lowerLambdaPredicate` (shared
// from lookup-translation); facet's twist is rejecting any `$.<field>`
// reference, because inside a facet sub-pipeline the lambda param IS the current
// document — there's no separate outer-doc concept.

import type { Expr } from "./ast.ts";
import { CodegenError, freshFacetCtx, type GenerateCtx } from "./codegen.ts";
import {
  localRefInPredicateMessage,
  lowerLambdaPredicate,
  requireStreamPredicate,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
import { collectStreamChain, type MethodCallNode } from "./stream-methods.ts";

type LambdaNode = Extract<Expr, { type: "Lambda" }>;

/**
 * One facet branch. `.filter(<lambda>)` keeps its dedicated predicate lowering
 * (it rejects `$.<field>` in favour of the param spelling). Any other `$$`
 * chain — a stage link (`$$.$match({ … })`), a registry method, or a mix —
 * lowers through the shared stream-chain engine, so a facet branch accepts the
 * same vocabulary as every other container.
 */
export type FacetEntry = { key: string; pos: number } & (
  | { kind: "filter"; lambda: LambdaNode }
  | { kind: "chain"; methods: MethodCallNode[] }
);

/** Lower a `$$`-rooted chain into a facet branch body. Supplied by pipeline.ts. */
export type FacetChainLowerer = (methods: MethodCallNode[], outerCtx: GenerateCtx, rhs: Expr) => object[];

/**
 * Recognise an object-literal RHS where every value is a `$$.filter(<lambda>)`.
 * Returns the parsed facets, or `null` when no entry has the filter shape (so
 * the caller falls back to `$replaceWith`).
 *
 * If *any* entry is a `$$.filter(...)` but others are not, throws a precise
 * mixed-shape error — the user clearly meant a facet, so silently falling
 * through to `$replaceWith` would surface a confusing "$$ is statement-only"
 * downstream.
 */
export function detectFacetShape(value: Expr): FacetEntry[] | null {
  if (value.type !== "ObjectLiteral") return null;
  if (value.entries.length === 0) return null;

  let hasBranch = false;
  for (const entry of value.entries) {
    if (entry.type !== "KeyValueEntry") continue;
    if (asFacetBranch(entry.value) !== null) {
      hasBranch = true;
      break;
    }
  }
  if (!hasBranch) return null;

  const facets: FacetEntry[] = [];
  for (const entry of value.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: spread entries are not allowed. Every value must be \`$$.filter(<predicate>)\`.`,
        entry.pos,
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: computed keys are not allowed. Facet names are stage output keys and must be static identifiers.`,
        entry.pos,
      );
    }
    const branch = asFacetBranch(entry.value);
    if (branch === null) {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: every value must be a \`$$\` chain — \`$$.filter(<predicate>)\`, a stage call (\`$$.$match({ … })\`), or any chain of them. Entry '${entry.key.name}' is something else. Either convert it to a \`$$\` chain or move it out of the object.`,
        entry.value.pos,
      );
    }
    facets.push({ key: entry.key.name, pos: entry.pos, ...branch });
  }
  return facets;
}

/**
 * Classify a facet branch value. A lone `$$.filter(<arrow>)` keeps the dedicated
 * predicate path (its `$.<field>` rejection is facet-specific); everything else
 * rooted at `$$` is a stream chain.
 */
function asFacetBranch(
  expr: Expr,
): { kind: "filter"; lambda: LambdaNode } | { kind: "chain"; methods: MethodCallNode[] } | null {
  if (expr.type !== "MethodCall") return null;
  if (
    expr.method === "filter" &&
    expr.object.type === "CollectionRef" &&
    expr.args.length === 1 &&
    expr.args[0].type === "Lambda"
  ) {
    return { kind: "filter", lambda: expr.args[0] as LambdaNode };
  }
  const chain = collectStreamChain(expr);
  if (chain.root.type !== "CollectionRef" || chain.methods.length === 0) return null;
  return { kind: "chain", methods: chain.methods };
}

/**
 * Lower the detected facets to a single `$facet` stage. Each entry's lambda
 * becomes one sub-pipeline (one `$match` for expression-body predicates;
 * the block's stages for block-body predicates).
 */
export function lowerFacet(
  facets: FacetEntry[],
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  lowerChain: FacetChainLowerer,
  rhs: Expr,
): object[] {
  const body: Record<string, object[]> = {};
  const seen = new Set<string>();
  for (const f of facets) {
    if (seen.has(f.key)) {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: duplicate key '${f.key}'. Facet names must be unique.`,
        f.pos,
      );
    }
    seen.add(f.key);
    body[f.key] =
      f.kind === "filter" ? lowerFacetEntry(f.lambda, outerCtx, lowerBlock) : lowerChain(f.methods, outerCtx, rhs);
  }
  return [{ $facet: body }];
}

/**
 * Translate one `$$.filter(<lambda>)` predicate into the sub-pipeline body
 * for its facet key. Requires exactly one lambda parameter — the user has
 * to name the doc explicitly (`o => …`) so the rejection message for
 * `$.<field>` references can point at the right replacement (`o.<field>`).
 *
 * `$.<field>` references inside the predicate are rejected with an
 * actionable error: inside a facet sub-pipeline, the lambda param IS the
 * current document, so the two notations would mean the same thing — we
 * force one canonical spelling rather than supporting both.
 */
function lowerFacetEntry(lambda: LambdaNode, outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object[] {
  // Arity via the shared gate, so all three `$$.filter` positions reject the same
  // shapes with the same wording. (`asFacetBranch` only routes arrows here; the other
  // predicate spellings reach the chain lowerer, which calls the same gate.)
  requireStreamPredicate(lambda, { method: "filter", position: FACET_PREDICATE_POSITION, pos: lambda.pos });
  // Shared expr-or-block predicate lowering (see `lowerLambdaPredicate`). Inside
  // a facet sub-pipeline the lambda param IS the current document, so a
  // `$.<field>` reference (captured as a non-empty `letVars`) is rejected in
  // favour of the param spelling.
  return lowerLambdaPredicate(lambda, outerCtx, lowerBlock, {
    freshCtx: freshFacetCtx,
    onLocalRef: rejectLocalRef,
    missingBody: () => {
      throw new CodegenError(
        `\`$$.filter(p)\` predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression — \`function (x) { return <expr> }\` / \`(x) => <expr>\` — and fold any bindings into <expr>.`,
        lambda.pos,
      );
    },
  });
}

function rejectLocalRef(letVars: Record<string, string>, param: string, pos: number): never {
  throw new CodegenError(
    localRefInPredicateMessage({ letVars, param, method: "filter", position: FACET_PREDICATE_POSITION }),
    pos,
  );
}

/** Where a `$facet` branch's predicate sits, for the shared gate's messages. */
const FACET_PREDICATE_POSITION = "in a `$ = { ... }` $facet branch";
