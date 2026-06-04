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
import { lowerLambdaPredicate, type SubPipelineLowerer } from "./lookup-translation.ts";

type LambdaNode = Extract<Expr, { type: "Lambda" }>;

export type FacetEntry = { key: string; lambda: LambdaNode; pos: number };

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

  let hasFilter = false;
  for (const entry of value.entries) {
    if (entry.type !== "KeyValueEntry") continue;
    if (asCollectionFilterLambda(entry.value) !== null) {
      hasFilter = true;
      break;
    }
  }
  if (!hasFilter) return null;

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
    const lambda = asCollectionFilterLambda(entry.value);
    if (lambda === null) {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: every value must be \`$$.filter(<predicate>)\`. Entry '${entry.key.name}' is something else. Either convert it to \`$$.filter(<predicate>)\` or move it out of the object.`,
        entry.value.pos,
      );
    }
    facets.push({ key: entry.key.name, lambda, pos: entry.pos });
  }
  return facets;
}

function asCollectionFilterLambda(expr: Expr): LambdaNode | null {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "filter") return null;
  if (expr.object.type !== "CollectionRef") return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type !== "Lambda") return null;
  return arg as LambdaNode;
}

/**
 * Lower the detected facets to a single `$facet` stage. Each entry's lambda
 * becomes one sub-pipeline (one `$match` for expression-body predicates;
 * the block's stages for block-body predicates).
 */
export function lowerFacet(facets: FacetEntry[], outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object[] {
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
    body[f.key] = lowerFacetEntry(f.lambda, outerCtx, lowerBlock);
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
  if (lambda.params.length !== 1) {
    throw new CodegenError(
      `\`$$.filter(<predicate>)\` inside \`$ = { ... }\` $facet must take exactly one parameter — write \`$$.filter(o => …)\` (the param name is your choice). The param represents each input document inside the facet sub-pipeline.`,
      lambda.pos,
    );
  }
  // Shared expr-or-block predicate lowering (see `lowerLambdaPredicate`). Inside
  // a facet sub-pipeline the lambda param IS the current document, so a
  // `$.<field>` reference (captured as a non-empty `letVars`) is rejected in
  // favour of the param spelling.
  return lowerLambdaPredicate(lambda, outerCtx, lowerBlock, {
    freshCtx: freshFacetCtx,
    onLocalRef: rejectLocalRef,
    missingBody: () => {
      throw new CodegenError(
        `\`$$.filter(p)\` lambda is missing a body — internal parser bug; please report.`,
        lambda.pos,
      );
    },
  });
}

function rejectLocalRef(letVars: Record<string, string>, param: string, pos: number): never {
  const sample = Object.values(letVars)[0]; // e.g. "$createdAt"
  const samplePath = sample.replace(/^\$+/, "");
  throw new CodegenError(
    `\`$.<field>\` inside \`$$.filter(p)\` in a \`$ = { ... }\` $facet is not supported — use the lambda parameter (e.g. \`${param}.${samplePath}\`) to reference the current document. Inside a facet sub-pipeline, the lambda param IS the current document; \`$.<field>\` would mean the same thing and adding a second spelling for it would only invite drift.`,
    pos,
  );
}
