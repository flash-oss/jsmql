// Stream-method registry: the chainable JS array-method vocabulary that
// extends a `$$ = $$.<chain>;` or `$$ = $$$.<coll>.<chain>;` RHS into
// pipeline stages. One entry per method, each declaring its arg-shape
// validator and its lowering to MQL stages. Walked by pipeline.ts —
// adding a method here makes it usable in both stream contexts.
//
// See docs/specs/stream-methods.md for the design and the per-method
// shape/lowering/error table.

import type { ArrayElement, CallArg, Expr, Pipeline, SpreadElement, UpdateFilter } from "./ast.ts";
import { someExpr } from "./ast-walk.ts";
import { CodegenError, generateWithCtx, type GenerateCtx, shorthandToLambda, stringKeyExpr } from "./codegen.ts";
import {
  aggregateArgToLambda,
  EMPTY_ENCLOSING,
  extractLetsFromExpr,
  extractLetsFromPipeline,
  extractLookupCalls,
  lowerCallbackBlock,
  validateAggregateArg,
  type SlotAllocator,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
import { GROUP_TMP, JSMQL_NS, LENGTH_SLOT, exprVar, streamLengthStage } from "./namespace.ts";
import { containsUnionPush } from "./union-translation.ts";
import { lowerUnionPush } from "./union-translation.ts";

type LambdaNode = Extract<Expr, { type: "Lambda" }>;

// The element name a shorthand iteratee (`"cat"` / `{ cat: "a" }` / `["cat", "a"]`)
// desugars its synthetic arrow param to. In the expression-variable namespace so it
// can't collide with a param the developer actually wrote — see src/namespace.ts.
const STREAM_SHORTHAND_PARAM = exprVar("el");

export type StreamMethodResult = {
  /** Stages this method contributes, appended to the surrounding chain. */
  stages: object[];
  /**
   * True if the emitted stages replace the document and drop in-scope `let`
   * bindings. Threaded back to the caller so the outer pipeline ctx can
   * clear the let scope. Defaults to false.
   */
  clearLets?: boolean;
  /**
   * Stages appended **once, at the very end of the chain** — never immediately
   * after this method's own `stages`. For clearing a `__jsmql.tmp` scratch field
   * a method had to materialise (a computed `$sort` key, `.shuffle`'s `$rand`).
   *
   * Deferring matters because `.takeWhile`/`.dropWhile` read `prevStages[last]`
   * to find the live `$sort`. An `$unset` sitting between the `$sort` and the
   * next method would hide it. (The now-removed "from the end" family made this
   * worse: it *silently* fell back to ordering by `_id` rather than erroring, so
   * `.shuffle().takeRight(3)` returned the last 3 by `_id` and discarded the
   * shuffle entirely.)
   *
   * Only needed inside a `$lookup.pipeline` (the `inSubPipeline` argument to
   * `lower`): there the sub-pipeline's docs land in an array field, so the outer
   * `{ $unset: "__jsmql" }` can't reach them. At the top level and inside a
   * `$unionWith.pipeline` that trailing sweep runs over these documents, so
   * emitting a second `$unset` would be pure noise.
   */
  cleanupStages?: object[];
  /**
   * `$lookup.let` correlation vars this method's body captured that must be
   * merged into the ENCLOSING lookup's `let` clause. Set by a statement-block
   * `.map` whose body reads cross-level values (`$.<field>`, an enclosing
   * foreign param, …) — those are hoisted into the lookup the chain is
   * extending. The chain assembler (`tryExtractChainedLookup` / the pivot)
   * `Object.assign`s them onto the lookup's `let`. Empty/absent otherwise.
   */
  extraLetVars?: Record<string, string>;
};

export type StreamMethodDef = {
  /** JS method name (e.g. "slice"). */
  name: string;
  /**
   * Validate the call's arg shape. Throw `CodegenError` (with `.pos`) for
   * any rejection branch. Called before `lower`; lowering may assume the
   * args have the shape the validator accepts.
   */
  validate: (args: readonly CallArg[], callPos: number) => void;
  /**
   * Produce the stages this method contributes.
   *
   * `prevStages` is the read-only view of stages the chain has emitted so
   * far in this context (outer pipeline for `$$` chains; `$unionWith`
   * sub-pipeline body for `$$$.<coll>` chains). Methods that don't need to
   * peek (`.slice`, `.map`, …) simply ignore it. `.takeWhile`/`.dropWhile`
   * are the only readers: they read the last `$sort`'s spec and reject when
   * there is none. Rewriting a previous stage is deliberately not offered —
   * see docs/specs/stream-methods.md § prevStages.
   *
   * `allocSlot` allocates a fresh `__jsmql.tmp.<N>` slot from the
   * surrounding pipeline's tracker — used by methods that need to
   * materialise embedded `$$$.<coll>.find/filter(...)` lookups (e.g.
   * `.map`'s body). Each call to `allocSlot()` marks the pipeline as
   * having used the namespace so the trailing `$unset: "__jsmql"` cleanup
   * is emitted. `inSubPipeline` is true when the chain is being lowered
   * inside a `$unionWith.pipeline` body (i.e. the `$$$.<coll>.<chain>` head);
   * methods that would otherwise produce nested `$lookup` stages use this
   * flag to surface the standard "nested lookup not yet supported" error.
   */
  lower: (
    args: readonly CallArg[],
    ctx: GenerateCtx,
    callPos: number,
    lowerBlock: SubPipelineLowerer,
    prevStages: readonly object[],
    allocSlot: SlotAllocator,
    inSubPipeline: boolean,
  ) => StreamMethodResult;
};

// ── .slice(start, end?) → $skip + $limit ──────────────────────────────────────
//
// Non-negative integer literals only. `start === 0` skips the `$skip` emission
// (no-op); a missing `end` skips the `$limit` emission (slice-from-start).
//
// JS `arr.slice(start, end)` returns elements at indices [start, end). The
// stream equivalent skips `start` documents from the head and (optionally)
// limits the remaining count to `end - start`.
const SLICE: StreamMethodDef = {
  name: "slice",
  validate(args, callPos) {
    if (args.length === 0 || args.length > 2) {
      throw new CodegenError(`.slice(start[, end]) takes 1 or 2 arguments, got ${args.length}.`, callPos);
    }
    for (const arg of args) {
      if (arg.type === "SpreadElement") {
        throw new CodegenError(`.slice(start[, end]) does not accept spread arguments.`, arg.pos);
      }
      if (arg.type !== "NumberLiteral") {
        throw new CodegenError(
          `.slice(start[, end]) requires non-negative integer literals; got '${arg.type}'. Computed or dynamic arguments aren't supported on streams — write the literal in source.`,
          arg.pos,
        );
      }
      if (arg.value < 0 || !Number.isInteger(arg.value)) {
        throw new CodegenError(
          `.slice(start[, end]) requires non-negative integer literals; got ${arg.value}. Negative indices and fractional values aren't supported on streams.`,
          arg.pos,
        );
      }
    }
    if (args.length === 2) {
      const start = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
      const end = (args[1] as Extract<Expr, { type: "NumberLiteral" }>).value;
      if (end < start) {
        throw new CodegenError(`.slice(start, end) requires end >= start (got start=${start}, end=${end}).`, callPos);
      }
    }
  },
  lower(args, _ctx, _callPos) {
    const start = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
    if (args.length === 2) {
      const end = (args[1] as Extract<Expr, { type: "NumberLiteral" }>).value;
      // An empty window (`slice(a, a)`) would emit `$limit: 0`, which the server
      // rejects ("the limit must be positive"). Drop the whole stream instead —
      // mirrors TAKE(0). The `$skip` is moot on an empty result, so omit it.
      if (end === start) return { stages: [{ $match: { $expr: false } }] };
    }
    const stages: object[] = [];
    if (start > 0) stages.push({ $skip: start });
    if (args.length === 2) {
      const end = (args[1] as Extract<Expr, { type: "NumberLiteral" }>).value;
      stages.push({ $limit: end - start });
    }
    return { stages };
  },
};

// Shared arg-shape validators for the single-literal count/key stream methods
// (.take / .drop / .sampleSize / .countBy / .uniqBy). Streams reject computed
// args — the value has to be a source literal so the emitted stage is fixed at
// compile time.
function validateSingleIntArg(sig: string, args: readonly CallArg[], callPos: number, min: number): void {
  if (args.length !== 1) {
    throw new CodegenError(`${sig} takes exactly 1 argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept a spread argument.`, arg.pos);
  }
  if (arg.type !== "NumberLiteral") {
    throw new CodegenError(
      `${sig} requires an integer literal; got '${arg.type}'. Computed or dynamic arguments aren't supported on streams — write the literal in source.`,
      arg.pos,
    );
  }
  if (!Number.isInteger(arg.value) || arg.value < min) {
    throw new CodegenError(`${sig} requires an integer >= ${min}; got ${arg.value}.`, arg.pos);
  }
}

/**
 * Resolve a *field-key* argument to the field name it names. Two spellings, one
 * meaning: the lodash property string (`"status"`) and the equivalent bare-field-path
 * arrow (`d => d.status`) — the arrow is just a longer way to write the same path, so
 * every stream method that keys on a field takes both, exactly as value position does.
 *
 * Returns null for anything that is not a plan-time field path (a *computed* arrow, a
 * matches-object, a dynamic value); callers reject those with the materialise-first
 * hint, since a `$sort` key / `$group._id` is fixed when the plan is built.
 * `""` and `"$…"` strings also return null so the caller keeps its own targeted
 * "plain field name" message for them.
 */
function fieldKeyArg(arg: CallArg | Expr | SpreadElement): string | null {
  if (arg.type === "StringLiteral") {
    return arg.value === "" || arg.value.startsWith("$") ? null : arg.value;
  }
  if (arg.type === "Lambda" && arg.params.length === 1 && arg.block === undefined && arg.body !== undefined) {
    return paramFieldPath(arg.body, arg.params[0]);
  }
  return null;
}

/**
 * The JS array methods that count "from the end" — deliberately NOT on the stream
 * surface. Value maps each to the equivalent the user should write instead.
 *
 * MongoDB has no stage that reverses a stream (`$reverseArray` is an *expression*,
 * for an array inside a document), and a stream has no ordering except the one a
 * `$sort` gives it. Faking them means rewriting the preceding `$sort`, which makes
 * them position-dependent in a way the JS methods never are and — with no `$sort` in
 * front — *silently* orders by `_id` instead of erroring. Reversing a sort you already
 * wrote is in any case a longer spelling of writing it descending.
 *
 * They remain available in VALUE position on a real array (`$.items.takeRight(3)`
 * → `$slice`, `$.items.toReversed()` → `$reverseArray`), where the array carries
 * its own order and the method means exactly what it means in JS.
 */
const FROM_THE_END_METHODS: Record<string, string> = {
  takeRight: `.toSorted({ <field>: -1 }).take(n)`,
  dropRight: `.toSorted({ <field>: -1 }).drop(n)`,
  initial: `.toSorted({ <field>: -1 }).drop(1)`,
  toReversed: `.toSorted({ <field>: -1 })`,
};

/** The rejection for a "from the end" method on a stream, or null if `name` isn't one. */
export function fromTheEndRejection(name: string, receiver: string, pos: number): CodegenError | null {
  const rewrite = FROM_THE_END_METHODS[name];
  if (rewrite === undefined) return null;
  const why =
    name === "toReversed"
      ? `it reverses the stream, and a MongoDB stream has no order to reverse`
      : `it counts from the END of the stream, and a MongoDB stream has no end to count back from`;
  const arg = name === "takeRight" || name === "dropRight" ? "n" : "";
  return new CodegenError(
    `'.${name}(...)' isn't available on a stream — ${why} (there is no stage that reverses one; ` +
      `'$reverseArray' is an expression, for an array inside a document). Say the order you want and take ` +
      `from the FRONT instead: '${receiver}${rewrite}'. On a real array value it still works exactly as in ` +
      `JS — '$.items.${name}(${arg})'.`,
    pos,
  );
}

/**
 * `$unset` stages for scratch slots a method materialised — but only inside a
 * `$lookup.pipeline`, where the sub-pipeline's documents land in an array field
 * that the outer `{ $unset: "__jsmql" }` cannot reach. At the top level and inside
 * a `$unionWith.pipeline` that trailing sweep already runs over these documents, so
 * a second `$unset` would be pure noise. Returns undefined when nothing is needed.
 */
function tempCleanup(slots: string[], inSubPipeline: boolean | undefined): object[] | undefined {
  if (!inSubPipeline || slots.length === 0) return undefined;
  // Unset the NAMESPACE ROOT, not the individual `__jsmql.tmp.<n>` slots: `$unset` of
  // a dotted path removes only the leaf, leaving the empty parents behind, so every
  // foreign document came back carrying `__jsmql: { tmp: {} }`. Nothing reads the
  // namespace after the chain ends, so dropping the whole thing is both correct and
  // one stage regardless of how many slots were used.
  return [{ $unset: JSMQL_NS }];
}

/**
 * Resolve a key argument to the MQL **expression** it evaluates to, for slots the
 * server evaluates per-document — i.e. `$group._id`.
 *
 * Generalises `fieldKeyArg`: every spelling that one resolves still yields the plain
 * `"$cat"` path (so a field key emits byte-identically to before), and a *computed*
 * iteratee now resolves too:
 *
 *   `d => d.cat.toLowerCase()`      →  `{ $toLower: "$cat" }`
 *   `{ cat: "a" }` / `["cat", "a"]` →  `{ $eq: ["$cat", "a"] }`   (lodash `_.matches`)
 *
 * The lambda param IS the current document, so `extractLetsFromExpr` rewrites
 * `d.<path>` to a bare field path and `rejectLocalDocRef` rejects a `$.<field>` read
 * (which would silently mean the outer document). A `$sort` key can NOT use this —
 * that slot is a field path, not an expression; see `computedKeyError`.
 */
function keyExpr(arg: CallArg, ctx: GenerateCtx, sig: string): unknown {
  const name = fieldKeyArg(arg);
  if (name !== null) return `$${name}`;
  const method = sig.slice(1, sig.indexOf("("));
  const lambda = arg.type === "Lambda" ? arg : shorthandToLambda(arg as Expr, method, STREAM_SHORTHAND_PARAM);
  if (lambda === null) throw computedKeyError(sig, "pos" in arg ? arg.pos : 0);
  const param = lambda.params[0];
  const { rewritten, letVars } = extractLetsFromExpr(mapBodyExpr(lambda, method), param);
  rejectLocalDocRef(letVars, param, lambda.pos, ctx.sourceSwitch?.desc, method);
  return generateWithCtx(rewritten, ctx);
}

/**
 * The rejection shared by every key slot handed something that is neither a field
 * path nor an iteratee — a number, a stray object, a dynamic value. `alsoTakes` names
 * any extra form the specific method accepts (e.g. `.groupBy`'s `$group` body), so one
 * message serves them all without under-selling a method.
 *
 * Note this is NOT "computed keys are unsupported": a sort key materialises through
 * `SortKeySink` and a group key lowers straight into `$group._id`. The one slot that
 * still can't take one is `.flatMap`'s `$unwind` path, which has its own message.
 */
function computedKeyError(sig: string, pos: number, alsoTakes = ""): CodegenError {
  // The example has to name the method being called — a `.keyBy(...)` error that
  // demonstrates `.countBy("status")` sends the reader to the wrong docs page.
  const name = sig.slice(1, sig.indexOf("("));
  return new CodegenError(
    `${sig} keys on a field, so it takes a field name ('.${name}("status")')${alsoTakes}, the equivalent ` +
      `bare-path arrow ('.${name}(d => d.status)'), or a computed key iteratee ` +
      `('.${name}(d => d.status.toLowerCase())').`,
    pos,
  );
}

/**
 * Validate the argument of a `$group`-keyed method (`.groupBy` / `.countBy` /
 * `.keyBy` / `.uniqBy`). `$group._id` is an **expression** slot, so beyond a field
 * key these take any computed iteratee — an arrow with an arbitrary expression body,
 * or a lodash matches shorthand. `lower` resolves the actual expression via `keyExpr`;
 * this only rejects shapes that can't be an iteratee at all.
 */
function validateKeyArg(sig: string, args: readonly CallArg[], callPos: number, alsoTakes = ""): void {
  if (args.length !== 1) {
    throw new CodegenError(`${sig} takes exactly 1 argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept a spread argument.`, arg.pos);
  }
  if (arg.type === "StringLiteral" && (arg.value === "" || arg.value.startsWith("$"))) {
    throw new CodegenError(
      `${sig} requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
      arg.pos,
    );
  }
  if (fieldKeyArg(arg) !== null) return; // plain field key
  const name = sig.slice(1, sig.indexOf("("));
  if (arg.type === "Lambda") {
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `${sig} takes a single-parameter iteratee '(d) => <key expr>', got ${arg.params.length} parameters.`,
        arg.pos,
      );
    }
    mapBodyExpr(arg, name); // rejects a multi-statement / binding-bearing block with its own message
    return;
  }
  // A lodash matches shorthand keys on the match BOOLEAN (lodash `_.matches`).
  if (shorthandToLambda(arg, name, STREAM_SHORTHAND_PARAM) !== null) return;
  throw new CodegenError(
    `${sig} takes a field name ('.${name}("status")'), a bare-path arrow ('.${name}(d => d.status)'), ` +
      `a computed iteratee ('.${name}(d => d.status.toLowerCase())')${alsoTakes}, or a lodash matches shorthand ` +
      `('{ active: true }' / '["status", "open"]').`,
    arg.pos,
  );
}

// ── .take(n) → $limit ─────────────────────────────────────────────────────────
//
// lodash `_.take(coll, n)` — the first `n` documents. `take(0)` is an empty
// result in lodash; since MongoDB rejects `$limit: 0`, that lowers to an
// always-false `$match` instead.
const TAKE: StreamMethodDef = {
  name: "take",
  validate(args, callPos) {
    validateSingleIntArg(".take(n)", args, callPos, 0);
  },
  lower(args) {
    const n = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
    return { stages: n === 0 ? [{ $match: { $expr: false } }] : [{ $limit: n }] };
  },
};

// ── .drop(n) → $skip ──────────────────────────────────────────────────────────
//
// lodash `_.drop(coll, n)` — all but the first `n`. `drop(0)` is identity, so
// it emits no stage.
const DROP: StreamMethodDef = {
  name: "drop",
  validate(args, callPos) {
    validateSingleIntArg(".drop(n)", args, callPos, 0);
  },
  lower(args) {
    const n = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
    return { stages: n === 0 ? [] : [{ $skip: n }] };
  },
};

// ── .takeWhile(pred) / .dropWhile(pred) → $setWindowFields running flag ───────
//
// lodash `_.takeWhile(coll, p)` keeps the LEADING RUN where `p` holds and stops at
// the first failure; `_.dropWhile` keeps the complement. On a stream that needs
// cross-document state, which MongoDB has only via `$setWindowFields`: a running
// `$max` of "has `p` failed at or before this document?" over an unbounded-preceding
// window. The two methods share that one stage and differ only in the `$match`
// polarity, so they are exact complements by construction.
//
// The window needs an ORDER. `$setWindowFields` requires `sortBy` for a
// document-based window ("Document-based bounds require a sortBy"), so the spec is
// lifted from the last `$sort` the chain has emitted — every sort spelling ends in
// one (`.sort` / `.toSorted` / `.sortBy` / `.orderBy` / the `.$sort(…)` stage link),
// including a computed `.sortBy(d => …)` whose key is a `__jsmql.tmp` scratch field.
// With no sort at all there is no leading run to speak of, so it is rejected rather
// than defaulted to `_id`: silently substituting an order nobody asked for is what
// got the "from the end" family removed. See docs/specs/stream-methods.md.
function lowerWhile(
  keep: 0 | 1,
  args: readonly CallArg[],
  ctx: GenerateCtx,
  callPos: number,
  prevStages: readonly object[],
  allocSlot: SlotAllocator,
  inSubPipeline: boolean | undefined,
): StreamMethodResult {
  const method = keep === 0 ? "takeWhile" : "dropWhile";
  const sortBy = lastSortSpec(prevStages);
  if (sortBy === null) {
    throw new CodegenError(
      `.${method}(<predicate>) needs a preceding sort — it keeps the ${keep === 0 ? "LEADING" : "TRAILING"} run of ` +
        `the stream, and a MongoDB stream has no order until you give it one. Sort first, then ` +
        `'.${method}(...)': e.g. '$$.toSorted({ t: 1 }).${method}(o => o.ok)'. Any sort spelling works ` +
        `('.sort' / '.toSorted' / '.sortBy' / '.orderBy' / '.$sort({ … })').`,
      callPos,
    );
  }
  const slot = allocSlot();
  return {
    stages: [
      {
        $setWindowFields: {
          sortBy,
          output: {
            [slot]: {
              $max: { $cond: [keyExpr(args[0], ctx, `.${method}(predicate)`), 0, 1] },
              window: { documents: ["unbounded", "current"] },
            },
          },
        },
      },
      { $match: { [slot]: keep } },
    ],
    cleanupStages: tempCleanup([slot], inSubPipeline),
  };
}

/** The spec of the last `$sort` the chain has emitted, or null if there is none. */
function lastSortSpec(prevStages: readonly object[]): Record<string, unknown> | null {
  for (let i = prevStages.length - 1; i >= 0; i--) {
    const spec = (prevStages[i] as Record<string, unknown>)["$sort"];
    if (spec !== undefined) return spec as Record<string, unknown>;
  }
  return null;
}

function validateWhileArg(method: string, args: readonly CallArg[], callPos: number): void {
  const sig = `.${method}(predicate)`;
  if (args.length !== 1) {
    throw new CodegenError(`${sig} takes exactly 1 argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept a spread argument.`, arg.pos);
  }
  if (arg.type === "Lambda") {
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `${sig} takes a single-parameter arrow '(o) => <condition>', got ${arg.params.length} parameters.`,
        arg.pos,
      );
    }
    mapBodyExpr(arg, method);
    return;
  }
  // Same predicate spellings `.filter` takes — a matches-object, a field name, a
  // `["field", value]` pair.
  if (shorthandToLambda(arg, method, STREAM_SHORTHAND_PARAM) !== null) return;
  throw new CodegenError(
    `${sig} takes an arrow predicate ('o => o.active'), a matches-object ('{ active: true }'), ` +
      `a field name ('"active"'), or a ["field", value] pair.`,
    arg.pos,
  );
}

const TAKE_WHILE: StreamMethodDef = {
  name: "takeWhile",
  validate(args, callPos) {
    validateWhileArg("takeWhile", args, callPos);
  },
  lower(args, ctx, callPos, _lb, prevStages, allocSlot, inSubPipeline) {
    return lowerWhile(0, args, ctx, callPos, prevStages, allocSlot, inSubPipeline);
  },
};

const DROP_WHILE: StreamMethodDef = {
  name: "dropWhile",
  validate(args, callPos) {
    validateWhileArg("dropWhile", args, callPos);
  },
  lower(args, ctx, callPos, _lb, prevStages, allocSlot, inSubPipeline) {
    return lowerWhile(1, args, ctx, callPos, prevStages, allocSlot, inSubPipeline);
  },
};

// ── .tail() → $skip: 1 ────────────────────────────────────────────────────────
//
// lodash `_.tail(coll)` — all but the first document; the stream analogue of
// `.drop(1)`.
const TAIL: StreamMethodDef = {
  name: "tail",
  validate(args, callPos) {
    if (args.length !== 0) throw new CodegenError(`.tail() takes no arguments, got ${args.length}.`, callPos);
  },
  lower() {
    return { stages: [{ $skip: 1 }] };
  },
};

// ── .shuffle() → $rand sort ───────────────────────────────────────────────────
//
// Random order: stamp each doc with a `$rand` key, sort by it, drop the key.
// Non-deterministic at runtime (like `.sample`). The temp lives in the `__jsmql`
// scratch namespace, so the trailing `$unset: "__jsmql"` clears any residue.
const SHUFFLE: StreamMethodDef = {
  name: "shuffle",
  validate(args, callPos) {
    if (args.length !== 0) throw new CodegenError(`.shuffle() takes no arguments, got ${args.length}.`, callPos);
  },
  lower(_args, _ctx, _callPos, _lb, _prevStages, allocSlot, inSubPipeline) {
    const slot = allocSlot();
    // The `$unset` is held back to the end of the chain, so the `$sort` stays the
    // last stage and a following `.takeWhile`/`.dropWhile` can still see it.
    return {
      stages: [{ $addFields: { [slot]: { $rand: {} } } }, { $sort: { [slot]: 1 } }],
      cleanupStages: tempCleanup([slot], inSubPipeline),
    };
  },
};

// ── .sampleSize(n) → $sample ──────────────────────────────────────────────────
//
// lodash `_.sampleSize(coll, n)` — `n` random documents. Maps to the `$sample`
// stage (size must be positive).
const SAMPLE_SIZE: StreamMethodDef = {
  name: "sampleSize",
  validate(args, callPos) {
    validateSingleIntArg(".sampleSize(n)", args, callPos, 1);
  },
  lower(args) {
    const n = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
    return { stages: [{ $sample: { size: n } }] };
  },
};

// ── .sample() → $sample: { size: 1 } ──────────────────────────────────────────
//
// lodash `_.sample(coll)` — a single random document. In JS that's `.sampleSize(1)`
// unwrapped to its element, but a pipeline is a stream of documents (not a scalar),
// so the stream analogue is just `.sampleSize(1)`: `$sample: { size: 1 }`. Zero-arg;
// use `.sampleSize(n)` for more than one.
const SAMPLE: StreamMethodDef = {
  name: "sample",
  validate(args, callPos) {
    if (args.length !== 0) {
      throw new CodegenError(
        `.sample() takes no arguments, got ${args.length}. For n random documents use '.sampleSize(n)'.`,
        callPos,
      );
    }
  },
  lower() {
    return { stages: [{ $sample: { size: 1 } }] };
  },
};

// ── .concat(...others) → $unionWith per arg ───────────────────────────────────
//
// JS-idiomatic alias for `$$.push(...)` in the chain context. Same arg-shape
// rules — collections must be spread (`...$$$.coll[.filter(p)]`), inline docs
// must not, `.find(pred)` results must not. The lowering routes through
// `lowerUnionPush` so the two codepaths stay in lock-step (no second copy of
// the spread / inline-doc / `.find` validation logic).
//
// Statement-only `$$.push(...)` continues to live in `union-translation.ts`;
// `.concat` is purely the chain-method analogue.
const CONCAT: StreamMethodDef = {
  name: "concat",
  validate(args, callPos) {
    if (args.length === 0) {
      throw new CodegenError(
        `.concat(...) requires at least one argument — a document literal ('{...}'), a spread of '$$$.<coll>[.filter(pred)]', or '$$$.<coll>.find(pred)'.`,
        callPos,
      );
    }
    // Per-arg shape validation lives inside `lowerUnionPush` (same engine
    // `$$.push` uses) — running it here would duplicate the rejection branches
    // verbatim. Defer.
  },
  lower(args, ctx, callPos, lowerBlock) {
    const stages = lowerUnionPush({ pos: callPos, callPos, args: [...args] }, ctx, lowerBlock);
    return { stages };
  },
};

// ── .map(d => <expr>) → $replaceWith ──────────────────────────────────────────
//
// Chain-form of the existing `$ = <expr>` statement sugar. Single-param
// arrow only; the parameter IS the current document, so `d.x` rewrites to
// the bare field path `$x` and `$.<field>` references are rejected (same
// "use the lambda parameter" convention as `.filter`). `$$.push` calls
// inside the body are rejected (statement-only construct, semantics don't
// fit inside an expression-position lambda).
//
// `$$$.<coll>.find/filter(...)` lookups inside the body ARE supported in
// both stream contexts. The body is post-processed through
// `extractLookupCalls` to materialise each lookup into an
// `__jsmql.tmp.<N>` slot ahead of the `$replaceWith`. References to
// the outer doc (`d.<field>`) get rewritten to bare field paths via
// `extractLetsFromExpr` BEFORE the lookup extractor runs, so the lookup
// predicate's `extractLetsFromExpr` (called from inside
// `translatePredicate`) sees those as `$.<field>` and hoists them to
// `$lookup.let` slots — basic-form is preferred when the predicate is a
// single `===` between matching paths. In the lookup-body context
// (`$$$.<coll>.filter(p).map(...)`), the materialised `$lookup` lands as
// a nested stage inside the outer `$unionWith.pipeline` — valid MQL,
// since the lookup correlates against the sub-pipeline's local doc (the
// foreign collection), not any outer-pipeline `let` binding.
// The expression a non-block `.map` lambda evaluates per element. An expression
// body (`d => X`) is used directly; an `exprBlock` body (only the `function`
// form reaches here now — `.map(function (d) { const a = …; return … })`) yields
// its `ret` when there are no bindings, else is rejected with a redirect. The
// statement-block arrow form (`d => { stmt; …; return X }`) is parsed as a
// pipeline block (`lambda.block` + `lambda.ret`) and handled by MAP.lower's
// dedicated block path — it never reaches here (callers guard on `lambda.block`).
// `method` names the caller, because the `$group`-keyed methods reuse this for their
// computed-key iteratee — an error on `.countBy(d => { … })` that talks about `.map`
// sends the reader to the wrong docs page (same rule as `computedKeyError`).
function mapBodyExpr(lambda: LambdaNode, method = "map"): Expr {
  if (lambda.body !== undefined) return lambda.body;
  const eb = lambda.exprBlock;
  if (eb !== undefined) {
    if (eb.decls.length > 0) {
      throw new CodegenError(
        `.${method}(d => { … }) with 'let'/'const' bindings isn't supported — use a single 'return <expr>' ` +
          `(e.g. '.${method}(d => d.field)'), or hoist the bindings to a top-level 'let' before the chain.`,
        lambda.pos,
      );
    }
    return eb.ret;
  }
  throw new CodegenError(
    `.${method}(d => <expr>) requires an expression or single-'return' body — a multi-statement block isn't supported here; split into separate stages ($set, $project, …) instead.`,
    lambda.pos,
  );
}

/**
 * Reject the index (2nd) parameter being *used* anywhere in a `.map` body —
 * MongoDB streams have no per-doc index. The param may be present positionally
 * (to reach the 3rd 'collection' param) but never referenced. Works uniformly
 * over expression, expression-block, and statement-block bodies because
 * `someExpr` over the whole `Lambda` recurses into `body` / `exprBlock` /
 * `block` + `ret` (see ast-walk.ts).
 */
function rejectUsedIndexParam(lambda: LambdaNode): void {
  if (lambda.params.length < 2) return;
  const indexParam = lambda.params[1];
  if (someExpr(lambda, (e) => e.type === "ParamRef" && e.name === indexParam)) {
    throw new CodegenError(
      `.map((${lambda.params[0]}, ${indexParam}) => …) can't use the index parameter '${indexParam}' — MongoDB streams have no per-doc index. ` +
        `Drop it, or keep it unused (e.g. '(${lambda.params[0]}, _${indexParam}, coll)') only to reach the 3rd 'collection' parameter.`,
      lambda.pos,
    );
  }
}

/**
 * Validate the 3rd 'collection' param and report whether `<coll>.length` is
 * actually read. Only `coll.length` (the sub-stream's document count) is
 * available — a stream has no materialised array to index or iterate. Scans
 * the whole lambda body (expression / block + `ret`); any reference to the
 * collection param that isn't a `.length` access is rejected.
 */
function classifyCollParam(lambda: LambdaNode): boolean {
  if (lambda.params.length !== 3) return false;
  const collName = lambda.params[2];
  let total = 0;
  let lengthUses = 0;
  someExpr(lambda, (e) => {
    if (e.type === "ParamRef" && e.name === collName) total++;
    if (
      e.type === "MemberAccess" &&
      e.member === "length" &&
      e.object.type === "ParamRef" &&
      e.object.name === collName
    ) {
      lengthUses++;
    }
    return false; // visit all
  });
  if (total > lengthUses) {
    throw new CodegenError(
      `In '.map((${lambda.params[0]}, _i, ${collName}) => …)' over a '$$$.<coll>' stream, only '${collName}.length' (the sub-stream's document count) is available — ` +
        `there's no materialised array to index or iterate. To work with the array itself, use the materialised form (e.g. '$$$.<coll>.filter(pred).filter((${lambda.params[0]}, i, ${collName}) => …)').`,
      lambda.pos,
    );
  }
  return lengthUses > 0;
}

/** Reject a `$.<field>` (local-doc) reference inside a `.map` body — only the
 * lambda parameter (the current document) is addressable. `letVars` is the
 * extractor's output; a non-empty map means a `$.<field>` slipped through.
 * `sourceSwitchDesc` (set when the `.map` runs inside a `$$ = $$$.<coll>…`
 * source-switch) swaps the generic "use the param" hint for the precise
 * "the outer root is gone — correlate with a `.filter`" guidance, since here
 * `<param>.<field>` is the SWITCHED collection's field, not the original root. */
function rejectLocalDocRef(
  letVars: Record<string, string>,
  param: string,
  pos: number,
  sourceSwitchDesc?: string,
  method = "map",
): void {
  if (Object.keys(letVars).length === 0) return;
  const samplePath = Object.values(letVars)[0].replace(/^\$+/, "");
  if (sourceSwitchDesc !== undefined) {
    throw new CodegenError(
      `\`$.${samplePath}\` (the outer document) isn't available inside \`${sourceSwitchDesc}\` — that source-switch ` +
        `replaces the stream with a different collection, so the original root document is gone (and \`${param}.${samplePath}\` ` +
        `here would be the switched collection's field, not the root's). To read the outer document per row, correlate with a ` +
        `\`.filter\` instead: \`$$$.<coll>.filter(${param} => ${param}.<field> === $.${samplePath}).map(…)\` lowers to a \`$lookup\` ` +
        `and threads \`$.${samplePath}\` into the sub-pipeline.`,
      pos,
    );
  }
  throw new CodegenError(
    `'$.<field>' inside '.${method}(d => …)' isn't supported — use the lambda parameter (e.g. '${param}.${samplePath}') to reference each input document. Inside this callback, the lambda parameter IS the current document.`,
    pos,
  );
}

// A stream `.map(d => <body>)` lowers to `$replaceWith: <body>`, so the body must
// evaluate to a document — MongoDB rejects a scalar / array new root at runtime
// ("'replacement document' must evaluate to an object"). Literal-gated exactly like
// the `$ = <expr>` guard (pipeline.ts `rejectNonDocumentReplaceRoot`): reject only a
// PROVABLY non-document body (a plain literal or an array literal). A field ref /
// member access / operator call is data-dependent — the field could be a
// subdocument — and passes, same as `$ = $.field`; a `$`-prefixed string is a field
// path (a runtime document) and is allowed too.
function rejectNonDocumentMapBody(body: Expr): void {
  const kind =
    body.type === "NumberLiteral"
      ? "a number"
      : body.type === "BigIntLiteral"
        ? "a bigint"
        : body.type === "BooleanLiteral"
          ? "a boolean"
          : body.type === "NullLiteral"
            ? "null"
            : body.type === "RegexLiteral"
              ? "a regex"
              : body.type === "ArrayLiteral"
                ? "an array"
                : body.type === "StringLiteral" && !body.value.startsWith("$")
                  ? "a string"
                  : null;
  if (kind !== null) {
    throw new CodegenError(
      `.map(d => …) must return a document, but this maps each document to ${kind} — MongoDB's '$replaceWith' requires an object root. To reshape into a new document write '.map(d => ({ … }))'; to keep a single value under a key, wrap it: '.map(d => ({ value: … }))'.`,
      body.pos,
    );
  }
}

const MAP: StreamMethodDef = {
  name: "map",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.map(d => <expr>) takes exactly one argument (a single-parameter arrow), got ${args.length}.`,
        callPos,
      );
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.map(...) does not accept a spread argument — pass a '(d) => <expr>' arrow.`, arg.pos);
    }
    // Any lodash iteratee shorthand: `.map("userId")` ≡ `.map(d => d.userId)` (pluck),
    // `.map({ a: 1 })` / `.map(["a", 1])` ≡ a `_.matches` boolean per element. Each
    // desugars to its arrow and lowers as a value-mode `$map` over the result array
    // (see `peelableTerminalMap`), matching what value position already accepts —
    // `shorthandToLambda` throws the per-form message for a malformed one.
    if (arg.type !== "Lambda") {
      if (shorthandToLambda(arg, "map", STREAM_SHORTHAND_PARAM) !== null) return;
      throw new CodegenError(
        `.map(d => <expr>) requires an arrow function (e.g. '.map(d => ({ id: d._id }))'), a field-name string ` +
          `('.map("userId")'), a matches-object ('{ active: true }'), or a ["field", value] pair.`,
        arg.pos,
      );
    }
    if (arg.params.length > 3) {
      throw new CodegenError(
        `.map(d => <expr>) takes at most 3 parameters '(element, index, collection)', got ${arg.params.length}.`,
        arg.pos,
      );
    }
    // A statement-block body (`d => { stmt; …; return <expr> }`) must end in a
    // `return` — the returned value becomes each output document.
    if (arg.block !== undefined && arg.ret === undefined) {
      throw new CodegenError(
        `.map(${arg.params[0]} => { … }) must end with 'return <expr>' — the returned value becomes each output document.`,
        arg.pos,
      );
    }
    if (arg.block === undefined) mapBodyExpr(arg); // throws for unsupported expr-block bodies
    rejectUsedIndexParam(arg);
  },
  lower(args, ctx, _callPos, lowerBlock, _prevStages, allocSlot, _inSubPipeline) {
    // Property shorthand `.map("field")` → project each doc to that field's value.
    const shorthand = args[0];
    if (shorthand.type === "StringLiteral") {
      return { stages: [{ $replaceWith: `$${shorthand.value}` }], clearLets: true };
    }
    const lambda = args[0] as LambdaNode;
    const param = lambda.params[0];
    const collName = lambda.params.length === 3 ? lambda.params[2] : undefined;
    const collLengthUsed = classifyCollParam(lambda);

    // ── Inside a correlated `$lookup` sub-pipeline (the `$$ =` pivot / a nested
    // chain / a `$.field = $$$.<coll>…` assignment) ───────────────────────────
    // Gated on `ctx.enclosingLookup` (set by the lookup assemblers, NOT by a flat
    // `$unionWith` source-switch). BOTH an expression body (`d => X`) and a
    // statement block (`d => { …; return X }`) lower through the SAME
    // `lowerCallbackBlock` engine `.filter` uses — an expression body is just
    // `d => { return X }`. So every form gets the full cross-level capture into the
    // enclosing `$lookup.let`: a root read (`$.x` / `$$.length`), an enclosing
    // foreign param, an ancestor `<coll>.length` handle, AND an outer-pipeline `let`
    // (`const k = …` before the pivot — resolved via the chain ctx's `pipelineLets`).
    // Captures come back as `extraLetVars` for the chain assembler to merge. The
    // trailing `return` is the only difference from `.filter` (appended as `$ = <ret>`).
    // A flat `$unionWith` (no `enclosingLookup`) has no `let` to correlate into, so it
    // falls through to the direct lowering below.
    if (ctx.enclosingLookup !== undefined) {
      const ret = lambda.block !== undefined ? (lambda.ret as Expr) : mapBodyExpr(lambda);
      // An expression-body ret becomes `$ = <ret>`; a provably non-document one is
      // rejected here (a block-body ret routes through `lowerCallbackBlock`'s own
      // `$ = <expr>` guard, same as the top-level block path).
      if (lambda.block === undefined) rejectNonDocumentMapBody(ret);
      if (containsUnionPush(ret)) {
        throw new CodegenError(
          `'$$.push(...)' inside a '.map(d => …)' body isn't meaningful — '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
          lambda.pos,
        );
      }
      const blockLambda: LambdaNode =
        lambda.block !== undefined
          ? lambda
          : {
              type: "Lambda",
              params: lambda.params,
              block: { type: "Pipeline", stmts: [], pos: lambda.pos },
              ret,
              pos: lambda.pos,
            };
      const enclosing = ctx.enclosingLookup ?? EMPTY_ENCLOSING;
      const blockCtx: GenerateCtx = { ...ctx, slotAllocator: allocSlot };
      const { letVars, pipeline } = lowerCallbackBlock(blockLambda, blockCtx, ctx.pipelineLets, lowerBlock, enclosing, {
        collParam: collName,
        terminalRet: ret,
      });
      return { stages: pipeline, clearLets: true, extraLetVars: letVars };
    }

    // ── Top-level `$$` stream (no enclosing `$lookup.let`) ────────────────────
    // Bind the 3rd 'collection' param to the current stream's materialised count
    // (`$__jsmql.length`); the `$setWindowFields` `$count` that stamps it is emitted
    // by `lowerBlock` (block body) or prepended below (expr body), ahead of the read.
    const bodyCtx: GenerateCtx =
      collName !== undefined && collLengthUsed
        ? {
            ...ctx,
            substreamLengthHandles: new Map([...(ctx.substreamLengthHandles ?? []), [collName, `$${LENGTH_SLOT}`]]),
          }
        : ctx;

    if (lambda.block !== undefined) {
      // The lambda param IS the current document, so a `$.<field>` ref is rejected
      // ("use the param"). The block + synthetic `$ = ret` lower directly to stages.
      const ret = lambda.ret as Expr; // validate() guarantees a block has a `ret`
      const { rewritten: rwBlock, letVars: blockLets } = extractLetsFromPipeline(lambda.block, param, ctx.pipelineLets);
      const { rewritten: rwRet, letVars: retLets } = extractLetsFromExpr(ret, param, ctx.pipelineLets);
      rejectLocalDocRef({ ...blockLets, ...retLets }, param, lambda.pos, ctx.sourceSwitch?.desc);
      const replaceStmt: UpdateFilter = {
        type: "UpdateFilter",
        ops: [{ type: "AssignExpr", target: { type: "FieldRef", path: "", pos: ret.pos }, value: rwRet, pos: ret.pos }],
        pos: ret.pos,
      };
      const synthetic: Pipeline = { type: "Pipeline", stmts: [...rwBlock.stmts, replaceStmt], pos: lambda.block.pos };
      const blockCtx: GenerateCtx = { ...bodyCtx, slotAllocator: allocSlot };
      return { stages: lowerBlock(synthetic, blockCtx), clearLets: true };
    }

    // ── Expression body: `(d) => <expr>` ─────────────────────────────────────
    const body = mapBodyExpr(lambda);
    rejectNonDocumentMapBody(body);
    if (containsUnionPush(body)) {
      throw new CodegenError(
        `'$$.push(...)' inside a '.map(d => …)' body isn't meaningful — '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
        lambda.pos,
      );
    }
    // Lookups inside the body are supported in both the top-level `$$` chain
    // and the lookup-body context (`$$$.<coll>.<chain>`). In the latter,
    // they land as a `$lookup` nested inside the outer `$unionWith.pipeline`
    // — valid MQL; the basic-form / pipeline-form translation in
    // `lookup-translation.ts` correlates against the sub-pipeline's local
    // doc (the foreign collection from the outer `$unionWith`), not any
    // outer-pipeline `let` bindings, so the let-coordination problem that
    // blocks the general nested-lookup case doesn't apply here.
    const { rewritten, letVars } = extractLetsFromExpr(body, param);
    rejectLocalDocRef(letVars, param, lambda.pos, ctx.sourceSwitch?.desc);
    // Materialise any `$$$.<coll>.find/filter(...)` lookups in the rewritten
    // body into prologue stages. `extractLookupCalls` handles the basic-vs-
    // pipeline-form predicate translation, auto-`let` extraction (for the
    // outer-doc paths we just rewrote to bare `FieldRef`s), and `$first`
    // wrapping for `.find`. When there are no lookups it returns prologue=[]
    // and the unchanged expr.
    const { stages: prologue, rewritten: rewritten2 } = extractLookupCalls(rewritten, bodyCtx, allocSlot, lowerBlock);
    const expr = generateWithCtx(rewritten2, bodyCtx);
    const lengthStages = collLengthUsed ? [streamLengthStage()] : [];
    return { stages: [...lengthStages, ...prologue, { $replaceWith: expr }], clearLets: true };
  },
};

// ── .aggregate((o, i, coll) => { … }) → sub-pipeline stages ───────────────────
//
// The full-sub-pipeline chain method: contributes its block's stages verbatim to
// the surrounding `$lookup.pipeline` (correlated chain / `$$ =` pivot / `$.field =`
// assignment) or `$unionWith.pipeline` (`$$ =` source-switch). Unlike `.map` it
// has NO terminal `return` — it's a pipeline, not a per-element reshape. Params
// mirror `.filter`/`.map`: `o.<field>` → `$<field>` (foreign), `$.<field>` → the
// outer doc (auto-`let`), `coll.length` → the sub-stream count. A stage-array
// literal argument (`.aggregate([{ … }])`) normalises to a zero-param block lambda.
//
// Shape + param validation is shared with the head form via `validateAggregateArg`
// (lookup-translation.ts); lowering reuses the same `lowerCallbackBlock` engine
// `.filter`/`.map` use, so cross-level `$lookup.let` capture works. Chaining
// `.aggregate` onto the CURRENT stream (`$$.aggregate(...)`) is rejected in
// `applyStreamMethods` — there it would be a redundant spelling of writing the
// stages directly; `.aggregate` only earns its keep against a foreign collection.
const AGGREGATE: StreamMethodDef = {
  name: "aggregate",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.aggregate(pipeline) takes exactly one argument — a block-body arrow '(o) => { $stage(...); ... }' ` +
          `or a stage-array literal '[{ $stage: ... }, ...]', got ${args.length}.`,
        callPos,
      );
    }
    validateAggregateArg(args[0], callPos);
  },
  lower(args, ctx, _callPos, lowerBlock, _prevStages, allocSlot, _inSubPipeline) {
    const lambda = aggregateArgToLambda(args[0]) as LambdaNode; // validate() guarantees non-null
    const param = lambda.params.length > 0 ? lambda.params[0] : undefined;
    const collName = lambda.params.length === 3 ? lambda.params[2] : undefined;

    // Inside a correlated `$lookup` sub-pipeline: same engine `.filter`/`.map`
    // use. Cross-level reads (`$.x`, an enclosing foreign param, an ancestor
    // `coll.length`) capture into the enclosing `$lookup.let`, returned as
    // `extraLetVars` for the chain assembler to merge. No terminal `return`, so
    // no `$replaceWith` is appended (that's the only difference from `.map`).
    if (ctx.enclosingLookup !== undefined) {
      const enclosing = ctx.enclosingLookup ?? EMPTY_ENCLOSING;
      const blockCtx: GenerateCtx = { ...ctx, slotAllocator: allocSlot };
      const { letVars, pipeline } = lowerCallbackBlock(lambda, blockCtx, ctx.pipelineLets, lowerBlock, enclosing, {
        collParam: collName,
      });
      return { stages: pipeline, clearLets: true, extraLetVars: letVars };
    }

    // Top-level source-switch (`$$ = $$$.<coll>.aggregate(...)`): the switched
    // stream flows through a `$unionWith.pipeline`, which has no `let` slot — so an
    // outer-doc `$.<field>` reference is rejected (mirrors `.map`), pointing at the
    // correlated `.filter` form. The block's stages lower directly. The 3rd
    // 'collection' param binds to this stream's materialised count (`$__jsmql.length`,
    // stamped by `lowerBlock`), exactly as `.map`'s source-switch form does.
    const collLengthUsed = collName !== undefined && classifyCollParam(lambda);
    const block = lambda.block as Pipeline;
    const { rewritten, letVars } = extractLetsFromPipeline(block, param ?? "", ctx.pipelineLets);
    rejectLocalDocRef(letVars, param ?? "o", lambda.pos, ctx.sourceSwitch?.desc);
    const blockCtx: GenerateCtx =
      collName !== undefined && collLengthUsed
        ? {
            ...ctx,
            slotAllocator: allocSlot,
            substreamLengthHandles: new Map([...(ctx.substreamLengthHandles ?? []), [collName, `$${LENGTH_SLOT}`]]),
          }
        : { ...ctx, slotAllocator: allocSlot };
    return { stages: lowerBlock(rewritten, blockCtx), clearLets: true };
  },
};

// ── .toSorted((a, b) => …) → $sort ────────────────────────────────────────────
//
// Accepts a comparator-shape expression body built from `a.<path> - b.<path>`
// terms (ascending), `b.<path> - a.<path>` terms (descending), and `||`
// combining multiple terms (compound sort, source order preserved). Anything
// else is rejected — bare `.toSorted()` (default JS string compare) included,
// because MongoDB streams of documents have no natural ordering.
type ComparatorPath = { param: "a" | "b"; path: string };

function classifyComparatorPath(expr: Expr, paramA: string, paramB: string): ComparatorPath | null {
  let cur: Expr = expr;
  const segments: string[] = [];
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "MemberAccess") {
      segments.unshift(cur.member);
      cur = cur.object;
      continue;
    }
    if (cur.type === "IndexAccess" && cur.index.type === "StringLiteral") {
      segments.unshift(cur.index.value);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (cur.type !== "ParamRef") return null;
  const which: "a" | "b" | null = cur.name === paramA ? "a" : cur.name === paramB ? "b" : null;
  if (which === null) return null;
  if (segments.length === 0) return null;
  return { param: which, path: segments.join(".") };
}

function parseComparatorBody(
  body: Expr,
  paramA: string,
  paramB: string,
  callPos: number,
  method: string,
): Record<string, 1 | -1> {
  if (body.type === "BinaryExpr" && body.op === "||") {
    const left = parseComparatorBody(body.left, paramA, paramB, callPos, method);
    const right = parseComparatorBody(body.right, paramA, paramB, callPos, method);
    return { ...left, ...right };
  }
  if (body.type === "BinaryExpr" && body.op === "-") {
    const leftPath = classifyComparatorPath(body.left, paramA, paramB);
    const rightPath = classifyComparatorPath(body.right, paramA, paramB);
    if (leftPath !== null && rightPath !== null && leftPath.path === rightPath.path) {
      if (leftPath.param === "a" && rightPath.param === "b") return { [leftPath.path]: 1 };
      if (leftPath.param === "b" && rightPath.param === "a") return { [leftPath.path]: -1 };
    }
  }
  throw new CodegenError(
    `.${method}((${paramA}, ${paramB}) => …) accepts only '${paramA}.<field> - ${paramB}.<field>' (ascending) or '${paramB}.<field> - ${paramA}.<field>' (descending) terms, combined with '||' for compound sorts. Other comparator shapes aren't supported on streams.`,
    body.pos ?? callPos,
  );
}

// ── .sort(<sort>) / .toSorted(<sort>) → $sort ─────────────────────────────────
//
// Ordering a document stream → one `$sort` stage. Accepts a field name
// (ascending), an array of field names (all ascending), a
// `{ field: 1 | -1 | "asc" | "desc" }` spec, or a comparator arrow
// `(a, b) => a.<field> - b.<field>` (`||` for compound). `.sort` and `.toSorted`
// are equivalent on a stream — there's no array to mutate, so both just reorder
// the flow (the mutate-vs-immutable distinction only matters for an array *value*).
function buildStreamSortSpec(args: readonly CallArg[], callPos: number, method: string): Record<string, 1 | -1> {
  if (args.length === 0) {
    throw new CodegenError(
      `.${method}(<sort>) needs a sort key — MongoDB streams have no natural document ordering. Pass a field name ('.${method}("createdAt")'), a '{ field: 1 | -1 | "asc" | "desc" }' spec, or a comparator '(a, b) => a.x - b.x'.`,
      callPos,
    );
  }
  if (args.length > 1) {
    throw new CodegenError(`.${method}(<sort>) takes exactly one argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`.${method}(...) does not accept a spread argument.`, arg.pos);
  }
  if (arg.type === "Lambda") {
    if (arg.params.length !== 2) {
      throw new CodegenError(
        `.${method}((a, b) => …) comparator requires a two-parameter arrow (got ${arg.params.length} params).`,
        arg.pos,
      );
    }
    if (arg.body === undefined) {
      throw new CodegenError(`.${method}((a, b) => …) requires an expression body, not a block.`, arg.pos);
    }
    const [paramA, paramB] = arg.params;
    return parseComparatorBody(arg.body as Expr, paramA, paramB, callPos, method);
  }
  return buildKeySortSpec(arg, `.${method}(...)`);
}

const TO_SORTED: StreamMethodDef = {
  name: "toSorted",
  validate(args, callPos) {
    buildStreamSortSpec(args, callPos, "toSorted");
  },
  lower(args, _ctx, callPos) {
    return { stages: [{ $sort: buildStreamSortSpec(args, callPos, "toSorted") }] };
  },
};

const SORT: StreamMethodDef = {
  name: "sort",
  validate(args, callPos) {
    buildStreamSortSpec(args, callPos, "sort");
  },
  lower(args, _ctx, callPos) {
    return { stages: [{ $sort: buildStreamSortSpec(args, callPos, "sort") }] };
  },
};

// ── .sortBy(field | [fields]) / .orderBy(keys, orders) → $sort ─────────────────
// The lodash sort names, value-mode siblings re-added for streams. `.sortBy` is
// ascending by one or more keys; `.orderBy` takes parallel keys + directions.
function buildSortByStreamSpec(args: readonly CallArg[], callPos: number, sink?: SortKeySink): Record<string, 1 | -1> {
  if (args.length !== 1) {
    throw new CodegenError(`.sortBy(<field> | [fields]) takes exactly one argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "ObjectLiteral") {
    throw new CodegenError(
      `.sortBy({ … }) isn't supported — an object here is a lodash matches-shorthand, not a direction. Use '.orderBy({ field: -1 })' or '.sort({ field: -1 })' for directions.`,
      arg.pos,
    );
  }
  return buildKeySortSpec(arg as Expr, ".sortBy(...)", sink); // field / [fields] → ascending
}

// A single `.orderBy` direction slot: 1 / -1 / "asc" / "desc".
function orderByStreamDir(e: Expr | SpreadElement): 1 | -1 {
  if (e.type !== "StringLiteral" && e.type !== "NumberLiteral" && e.type !== "UnaryExpr") {
    throw new CodegenError(`.orderBy(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
  }
  const dir = sortDirection(e);
  if (dir === null) {
    throw new CodegenError(`.orderBy(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
  }
  return dir;
}

function buildOrderByStreamSpec(args: readonly CallArg[], callPos: number, sink?: SortKeySink): Record<string, 1 | -1> {
  if (args.length < 1 || args.length > 2) {
    throw new CodegenError(
      `.orderBy(keys[, orders] | { field: dir }) takes one or two arguments, got ${args.length}.`,
      callPos,
    );
  }
  const keysArg = args[0];
  const ordersArg = args[1];
  // Object form `.orderBy({ field: dir })` mirrors `.sort({ … })`: the directions live
  // inside the object, so there is no separate `orders` argument (shares the value-mode
  // `.orderBy` object branch's shape via `buildKeySortSpec`).
  if (keysArg.type === "ObjectLiteral") {
    if (ordersArg !== undefined) {
      throw new CodegenError(
        `.orderBy({ … }) already carries a direction per field — drop the second 'orders' argument.`,
        ordersArg.pos,
      );
    }
    return buildKeySortSpec(keysArg, ".orderBy({ … })", sink);
  }
  const names =
    keysArg.type === "ArrayLiteral"
      ? keysArg.elements.map((el) => fieldNameLiteral(el as Expr | SpreadElement, ".orderBy(keys)", "", sink))
      : [fieldNameLiteral(keysArg, ".orderBy(keys)", "", sink)];
  const dirs =
    ordersArg === undefined
      ? []
      : ordersArg.type === "ArrayLiteral"
        ? ordersArg.elements.map((el) => orderByStreamDir(el as Expr | SpreadElement))
        : [orderByStreamDir(ordersArg)];
  const spec: Record<string, 1 | -1> = {};
  names.forEach((nm, i) => {
    spec[nm] = dirs[i] ?? 1; // fewer orders than keys ⇒ remainder ascending (lodash)
  });
  return spec;
}

const SORT_BY: StreamMethodDef = {
  name: "sortBy",
  validate(args, callPos) {
    buildSortByStreamSpec(args, callPos, validatingSortKeys());
  },
  lower(args, ctx, callPos, _lb, _prevStages, allocSlot, inSubPipeline) {
    const { sink, computed } = materialisingSortKeys(ctx, allocSlot);
    const spec = buildSortByStreamSpec(args, callPos, sink);
    return sortStages(spec, computed, inSubPipeline);
  },
};

const ORDER_BY: StreamMethodDef = {
  name: "orderBy",
  validate(args, callPos) {
    buildOrderByStreamSpec(args, callPos, validatingSortKeys());
  },
  lower(args, ctx, callPos, _lb, _prevStages, allocSlot, inSubPipeline) {
    const { sink, computed } = materialisingSortKeys(ctx, allocSlot);
    const spec = buildOrderByStreamSpec(args, callPos, sink);
    return sortStages(spec, computed, inSubPipeline);
  },
};

// ── .pick([fields]) / .omit([fields]) → $project ──────────────────────────────
//
// The lodash object methods, applied per-document on the stream. `.pick` keeps
// ONLY the named fields (an inclusion `$project`; `_id` is dropped unless named,
// matching lodash + the value-mode `.pick`, which keeps only named keys). `.omit`
// drops the named fields (an exclusion `$project`; everything else — including
// `_id` — is kept, matching lodash `_.omit`). One field-name-string array arg.
function projectFieldNames(args: readonly CallArg[], callPos: number, method: string): string[] {
  if (args.length !== 1) {
    throw new CodegenError(
      `.${method}([fields]) takes exactly one argument (an array of field names), got ${args.length}.`,
      callPos,
    );
  }
  const arg = args[0];
  if (arg.type !== "ArrayLiteral") {
    throw new CodegenError(
      `.${method}([fields]) takes an array of field-name strings, e.g. '.${method}(["name", "email"])'.`,
      arg.pos,
    );
  }
  if (arg.elements.length === 0) throw new CodegenError(`.${method}([fields]) needs at least one field name.`, arg.pos);
  return arg.elements.map((el) => {
    if (el.type !== "StringLiteral" || el.value === "" || el.value.startsWith("$")) {
      throw new CodegenError(`.${method}([fields]) entries must be plain field-name strings (no leading '$').`, el.pos);
    }
    return el.value;
  });
}

const PICK: StreamMethodDef = {
  name: "pick",
  validate(args, callPos) {
    projectFieldNames(args, callPos, "pick");
  },
  lower(args, _ctx, callPos) {
    const fields = projectFieldNames(args, callPos, "pick");
    const proj: Record<string, 0 | 1> = {};
    for (const f of fields) proj[f] = 1;
    if (!fields.includes("_id")) proj._id = 0; // lodash pick keeps ONLY named keys
    return { stages: [{ $project: proj }], clearLets: true };
  },
};

const OMIT: StreamMethodDef = {
  name: "omit",
  validate(args, callPos) {
    projectFieldNames(args, callPos, "omit");
  },
  lower(args, _ctx, callPos) {
    const fields = projectFieldNames(args, callPos, "omit");
    const proj: Record<string, 0> = {};
    for (const f of fields) proj[f] = 0;
    // Exclusion projection keeps every other field (incl. `let` scratch), so the
    // let scope survives — no clearLets.
    return { stages: [{ $project: proj }] };
  },
};

// Key-form sort helpers, shared by `.sort` / `.toSorted` above and by the `$group`
// key form. A plain field-name literal (no leading `$`):
/**
 * Turns a *computed* sort key into the field path `$sort` will read. `$sort` needs a
 * literal path, so the expression has to be materialised into a scratch field first;
 * the sink allocates that slot and records the expression for the caller's
 * `$addFields` prologue. Absent (`undefined`) means "this slot takes only a field
 * path" and a computed key is rejected outright.
 */
type SortKeySink = (e: LambdaNode, sig: string) => string;

function fieldNameLiteral(e: Expr | SpreadElement, sig: string, alsoTakes = "", sink?: SortKeySink): string {
  if (e.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept spread elements.`, e.pos);
  }
  if (e.type === "StringLiteral" && (e.value === "" || e.value.startsWith("$"))) {
    throw new CodegenError(
      `${sig} requires plain field names (no leading '$'), got ${JSON.stringify(e.value)}.`,
      e.pos,
    );
  }
  // `"cat"` and `d => d.cat` name the same path — accept both here so the spelling
  // is free wherever a sort/group key is taken (`fieldKeyArg`).
  const name = fieldKeyArg(e);
  if (name !== null) return name;
  // Only an ARROW may be a computed key. An object stays claimed by the richer
  // surface it already means here (`.orderBy({ field: dir })` directions), and
  // `.sortBy({ … })` keeps its own message pointing at those.
  if (sink !== undefined && e.type === "Lambda") return sink(e, sig);
  throw computedKeyError(sig, e.pos, alsoTakes);
}

/**
 * The `lower`-time sink: allocate a `__jsmql.tmp` slot per computed key and record
 * its expression. `computed` becomes one `$addFields` ahead of the `$sort`.
 */
function materialisingSortKeys(
  ctx: GenerateCtx,
  allocSlot: SlotAllocator,
): { sink: SortKeySink; computed: Record<string, unknown> } {
  const computed: Record<string, unknown> = {};
  return {
    computed,
    sink: (e, sig) => {
      const slot = allocSlot();
      computed[slot] = keyExpr(e, ctx, sig);
      return slot;
    },
  };
}

/**
 * The `validate`-time sink. `validate` runs without a ctx or a slot allocator, so it
 * can't resolve the expression — it re-runs the same shape checks `keyExpr` would and
 * hands back a distinct placeholder per key (distinct so a multi-key spec object
 * doesn't collapse to one entry and hide a later key's error).
 */
/**
 * Assemble the stages for a key-form sort. With no computed key this is the single
 * `$sort` it always was; otherwise one `$addFields` materialises every computed key
 * ahead of it, and the scratch slots are cleared at the END of the chain (never
 * between the `$sort` and the next method — see `StreamMethodResult.cleanupStages`).
 */
function sortStages(
  spec: Record<string, 1 | -1>,
  computed: Record<string, unknown>,
  inSubPipeline: boolean | undefined,
): StreamMethodResult {
  const slots = Object.keys(computed);
  if (slots.length === 0) return { stages: [{ $sort: spec }] };
  return { stages: [{ $addFields: computed }, { $sort: spec }], cleanupStages: tempCleanup(slots, inSubPipeline) };
}

function validatingSortKeys(): SortKeySink {
  let n = 0;
  return (e, sig) => {
    const method = sig.slice(1, sig.indexOf("("));
    if (e.params.length !== 1) {
      throw new CodegenError(
        `${sig} takes a single-parameter key iteratee '(d) => <key expr>', got ${e.params.length} parameters.`,
        e.pos,
      );
    }
    mapBodyExpr(e, method); // rejects a multi-statement / binding-bearing block
    return `__jsmqlSortKeyProbe${n++}`;
  };
}

// 1 (ascending) or -1 (descending), from a `1` / `-1` number or an `"asc"` /
// `"desc"` string. `-1` parses as a UnaryExpr, so that shape is handled too.
// Returns null for anything else.
function sortDirection(e: Expr): 1 | -1 | null {
  if (e.type === "NumberLiteral") return e.value === 1 ? 1 : e.value === -1 ? -1 : null;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral" && e.operand.value === 1) return -1;
  if (e.type === "StringLiteral") return e.value === "asc" ? 1 : e.value === "desc" ? -1 : null;
  return null;
}

// A field name ("age"), an array of field names (all ascending), or a
// `{ field: 1 | -1 | "asc" | "desc" }` spec → a `$sort` document.
function buildKeySortSpec(arg: Expr, sig: string, sink?: SortKeySink): Record<string, 1 | -1> {
  // `"age"` and the bare-path arrow `d => d.age` are the same ascending key.
  if (arg.type === "StringLiteral" || arg.type === "Lambda") {
    return { [fieldNameLiteral(arg, sig, "", sink)]: 1 };
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) {
      throw new CodegenError(`${sig} needs at least one field name.`, arg.pos);
    }
    const spec: Record<string, 1 | -1> = {};
    for (const el of arg.elements) spec[fieldNameLiteral(el as Expr | SpreadElement, sig, "", sink)] = 1;
    return spec;
  }
  if (arg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `${sig} takes a field name ("age"), an array of field names (["a", "b"]), or a '{ field: 1 | -1 | "asc" | "desc" }' spec.`,
      arg.pos,
    );
  }
  if (arg.entries.length === 0) {
    throw new CodegenError(`${sig} needs at least one field.`, arg.pos);
  }
  const spec: Record<string, 1 | -1> = {};
  for (const entry of arg.entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError(`${sig} does not accept spread entries.`, entry.pos);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`${sig} keys must be plain field names — computed keys aren't supported.`, entry.pos);
    }
    const dir = sortDirection(entry.value);
    if (dir === null) {
      throw new CodegenError(
        `${sig} direction for '${entry.key.name}' must be 1 / -1 / "asc" / "desc".`,
        entry.value.pos,
      );
    }
    spec[entry.key.name] = dir;
  }
  return spec;
}

// ── .groupBy(key | { _id, <field>: <accumulator> }) → object collapse / $group ──
//
// Two arg shapes, deliberately different outputs:
//   • a bare field name — `.groupBy("dept")` — is lodash `_.groupBy(coll, key)`,
//     so it collapses the stream to the OBJECT `{ <keyValue>: [elements] }` (see
//     the string branch in `lower` below and COUNT_BY for the pattern). This
//     mirrors value-mode `$.arr.groupBy(...)`.
//   • a `$group` body object — `{ _id: "$dept", n: $sum(1) }` — is jsmql's
//     `$group`-builder: lowered verbatim to a `$group` stage (a stream of group
//     docs). Field-value slots (every key but `_id`) generate in accumulator
//     context, so `$addToSet` / `$push` / … pass the codegen gate, exactly like
//     the direct `$group(...)` stage. There is no lodash analogue for the
//     accumulator form, which is why it keeps the stream shape.
//
// (Per-key accumulator scoping mirrors `pipeline.ts`'s `$group` body generation;
// it's reimplemented locally because pipeline.ts imports THIS module — importing
// back would be a cycle.)
function generateGroupBody(
  obj: Extract<Expr, { type: "ObjectLiteral" }>,
  ctx: GenerateCtx,
  callPos: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let hasId = false;
  for (const entry of obj.entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError(
        `.groupBy({ … }) does not accept spread entries — write an explicit '$group' body.`,
        entry.pos,
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `.groupBy({ … }) keys must be static field names — computed keys aren't supported.`,
        entry.pos,
      );
    }
    const key = entry.key.name;
    // `_id` is a plain grouping expression; every other slot is an accumulator.
    const slotCtx: GenerateCtx = key === "_id" ? ctx : { ...ctx, accumulatorContext: "group" };
    out[key] = generateWithCtx(entry.value, slotCtx);
    if (key === "_id") hasId = true;
  }
  if (!hasId) {
    throw new CodegenError(
      `.groupBy({ … }) requires an '_id' key (the group key). Use '.groupBy("field")' to group by a single field.`,
      callPos,
    );
  }
  return out;
}

const GROUP_BY: StreamMethodDef = {
  name: "groupBy",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.groupBy(key | { _id: …, <field>: <accumulator>, … }) takes exactly 1 argument, got ${args.length}.`,
        callPos,
      );
    }
    const a = args[0];
    if (a.type === "SpreadElement") {
      throw new CodegenError(`.groupBy(...) does not accept a spread argument.`, a.pos);
    }
    // An ObjectLiteral is the `$group`-body form (jsmql's own surface, carrying
    // accumulators), NOT a lodash matches-shorthand — so it is checked by
    // `generateGroupBody`, not as a key. `.groupBy` is the one keyed method where
    // the matcher spelling is unavailable, because that spelling is already taken.
    // Every other argument is a key, computed or not (`$group._id` is an expression).
    if (a.type === "ObjectLiteral") return;
    validateKeyArg(".groupBy(key)", args, callPos, ` or a '$group' body ('{ _id: "$dept", n: $sum(1) }')`);
  },
  lower(args, ctx, callPos) {
    const a = args[0] as Expr;
    if (a.type !== "ObjectLiteral") {
      const key = keyExpr(a, ctx, ".groupBy(key)");
      // Bare-key form is lodash `_.groupBy(coll, key)` → the OBJECT
      // `{ <keyValue>: [elements] }`. Collapse the stream to that single object
      // (mirroring value-mode `$.arr.groupBy(...)`): `$push: "$$ROOT"` gathers each
      // group's docs, then the second `$group` + `$arrayToObject` build the object.
      // `GROUP_TMP` is consumed by the very next stage each time (see COUNT_BY /
      // namespace.ts). The object-body form below stays a real `$group` stage —
      // it carries accumulators with no lodash analogue.
      return {
        stages: [
          { $group: { _id: key, [GROUP_TMP]: { $push: "$$ROOT" } } },
          { $group: { _id: null, [GROUP_TMP]: { $push: { k: stringKeyExpr("$_id"), v: `$${GROUP_TMP}` } } } },
          { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } },
        ],
        clearLets: true,
      };
    }
    const body = generateGroupBody(a as Extract<Expr, { type: "ObjectLiteral" }>, ctx, callPos);
    return { stages: [{ $group: body }], clearLets: true };
  },
};

// ── .countBy(field) → object collapse ─────────────────────────────────────────
//
// lodash `_.countBy(coll, key)` returns an OBJECT `{ <keyValue>: <count> }`, so the
// stream form collapses the whole stream to that single object (mirroring value-mode
// `$.arr.countBy(...)`, not MongoDB's `$sortByCount` stream of `{ _id, count }` docs).
// Two `$group`s then `$arrayToObject`: tally per key → gather the `{k, v}` pairs into
// the flat `GROUP_TMP` slot (a group accumulator key can't be dotted) → build the
// object. `$replaceWith` consumes `GROUP_TMP` on the very next stage, so it never
// reaches output. For the count-descending stream instead, write the `$sortByCount`
// stage directly. See docs/specs/stream-methods.md.
const COUNT_BY: StreamMethodDef = {
  name: "countBy",
  validate(args, callPos) {
    validateKeyArg(".countBy(key)", args, callPos);
  },
  lower(args, ctx) {
    const key = keyExpr(args[0], ctx, ".countBy(key)");
    return {
      stages: [
        { $group: { _id: key, [GROUP_TMP]: { $sum: 1 } } },
        { $group: { _id: null, [GROUP_TMP]: { $push: { k: stringKeyExpr("$_id"), v: `$${GROUP_TMP}` } } } },
        { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } },
      ],
      clearLets: true,
    };
  },
};

// ── .keyBy(field) → object collapse ───────────────────────────────────────────
//
// lodash `_.keyBy(coll, key)` returns the OBJECT `{ <keyValue>: <last doc> }` (last
// wins on a collision). The stream form collapses to that single object (mirroring
// value-mode `$.arr.keyBy(...)`): `$group` with `$last: "$$ROOT"` keeps the last doc
// per key, then the second `$group` + `$arrayToObject` build the object. "Last"
// follows the stream's current order, so precede with a `.sort(...)` when which-
// duplicate-wins matters (same caveat as `.uniqBy`, which keeps the first).
const KEY_BY: StreamMethodDef = {
  name: "keyBy",
  validate(args, callPos) {
    validateKeyArg(".keyBy(key)", args, callPos);
  },
  lower(args, ctx) {
    const key = keyExpr(args[0], ctx, ".keyBy(key)");
    return {
      stages: [
        { $group: { _id: key, [GROUP_TMP]: { $last: "$$ROOT" } } },
        { $group: { _id: null, [GROUP_TMP]: { $push: { k: stringKeyExpr("$_id"), v: `$${GROUP_TMP}` } } } },
        { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } },
      ],
      clearLets: true,
    };
  },
};

// ── .uniqBy(field) → $group + $replaceWith ────────────────────────────────────
//
// lodash `_.uniqBy(coll, key)` — one document per distinct key. `$group` keeps
// the first document seen for each key (`$first`), then `$replaceWith` restores
// it as the root. NB "first" follows the stream's current order, so precede with
// a `.sort(...)` when which-duplicate-wins matters.
const UNIQ_BY: StreamMethodDef = {
  name: "uniqBy",
  validate(args, callPos) {
    validateKeyArg(".uniqBy(key)", args, callPos);
  },
  lower(args, ctx) {
    const key = keyExpr(args[0], ctx, ".uniqBy(key)");
    return {
      stages: [{ $group: { _id: key, [GROUP_TMP]: { $first: "$$ROOT" } } }, { $replaceWith: `$${GROUP_TMP}` }],
      clearLets: true,
    };
  },
};

// ── .flatMap(d => d.<path>) → $unwind ─────────────────────────────────────────
//
// Only bare-field-path bodies are supported. The lambda body must walk back
// to the param ref through `.member` / `["literal"]` access; the lowered
// stage is a single `$unwind: "$<path>"` that splits each input doc into
// one-per-element, with surrounding fields preserved (MQL-natural — differs
// from JS `flatMap` which yields bare elements).
//
// Users who want JS-faithful "just the elements" can chain
// `.map(d => d.<path>)` after to project the unwound array down to its
// element. More complex bodies (e.g. `.flatMap(d => d.items.map(...))`)
// would require a slot allocator threaded through the chain walker;
// deferred to a follow-up.

function paramFieldPath(expr: Expr, param: string): string | null {
  const segments: string[] = [];
  let cur: Expr = expr;
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "MemberAccess") {
      segments.unshift(cur.member);
      cur = cur.object;
      continue;
    }
    if (cur.type === "IndexAccess" && cur.index.type === "StringLiteral") {
      segments.unshift(cur.index.value);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (cur.type !== "ParamRef") return null;
  if (cur.name !== param) return null;
  if (segments.length === 0) return null;
  return segments.join(".");
}

const FLAT_MAP: StreamMethodDef = {
  name: "flatMap",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.flatMap(d => d.<path>) takes exactly one argument (a single-parameter arrow), got ${args.length}.`,
        callPos,
      );
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.flatMap(...) does not accept a spread argument.`, arg.pos);
    }
    // lodash property shorthand: `.flatMap("productIds")` ≡ `.flatMap(d => d.productIds)`.
    if (arg.type === "StringLiteral") {
      if (arg.value === "" || arg.value.startsWith("$")) {
        throw new CodegenError(
          `.flatMap("field") requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
          arg.pos,
        );
      }
      return;
    }
    if (arg.type !== "Lambda") {
      throw new CodegenError(
        `.flatMap(...) names the array field to flatten, so it takes a bare-path arrow ` +
          `('.flatMap(d => d.items)') or the equivalent field-name string ('.flatMap("items")'). On a stream it ` +
          `lowers to '$unwind', which needs a field path — a computed arrow, a matches-object, or a ` +
          `["field", value] pair doesn't name one. Materialise the array into a field first, then flatten it ` +
          `by name: '$.items = <expr>; $$ = $$.flatMap("items");' — or, inside a foreign chain, ` +
          `'.map(d => ({ items: <expr>, … })).flatMap("items")'.`,
        arg.pos,
      );
    }
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `.flatMap(d => d.<path>) requires a single-parameter arrow (got ${arg.params.length} params).`,
        arg.pos,
      );
    }
    if (arg.body === undefined) {
      throw new CodegenError(`.flatMap(d => d.<path>) requires an expression body, not a block.`, arg.pos);
    }
  },
  lower(args, _ctx, callPos, _lowerBlock, _prevStages) {
    const shorthand = args[0];
    if (shorthand.type === "StringLiteral") {
      return { stages: [{ $unwind: `$${shorthand.value}` }] };
    }
    const lambda = args[0] as LambdaNode;
    const param = lambda.params[0];
    const body = lambda.body as Expr;
    const path = paramFieldPath(body, param);
    if (path === null) {
      throw new CodegenError(
        `.flatMap(d => …) needs a field path — it lowers to '$unwind', which returns each element to a NAMED field, so a computed body (e.g. '.flatMap(d => d.items.map(...))') has nothing to unwind into. Build the array into a field first, then flatten it by name: '$.items = <expr>; $$ = $$.flatMap("items");'.`,
        body.pos ?? callPos,
      );
    }
    return { stages: [{ $unwind: `$${path}` }] };
  },
};

// ── $$ = [{ key: $$.reduce(…) }] wrap pattern → $group + $replaceWith ─────────
//
// `.reduce(...)` is NOT a chain method on `$$`. In JS, `arr.reduce(...)`
// returns a single value (scalar / object / array depending on the
// reducer); assigning a non-array value directly to `$$` would violate
// the "stream is always an array of docs" invariant. So jsmql requires
// the user to **explicitly wrap** the reduce result(s) into a stream-
// shaped RHS:
//
//   - For scalar reducers: `$$ = [{ <key>: $$.reduce(<reducer>, <init>) }];`
//     The wrap turns the scalar into a named field of a single-doc stream.
//   - For object reducers: `$$ = [$$.reduce(<reducer>, <init>)];`
//     (future work — needs object-returning reducer patterns).
//
// This file owns the scalar-into-object wrap. Each entry of the inner
// object must be a direct `$$.reduce(...)` call; lowering pattern-matches
// each reducer body to a MongoDB `$group` accumulator and emits:
//
//   [
//     { $group: { _id: null, <key>: { $sum/$max/$min: <expr> }, ... } },
//     { $replaceWith: { <key>: "$<key>", ... } },                    // drop _id
//   ]
//
// Reducer-body shapes (pattern-matched per entry):
//
//   `acc + d.<field>`              → `{ $sum: "$<field>" }`
//   `acc + 1`                       → `{ $sum: 1 }` (count documents)
//   `Math.max(acc, d.<field>)`     → `{ $max: "$<field>" }`
//   `Math.min(acc, d.<field>)`     → `{ $min: "$<field>" }`
//
// The `init` argument is required (JS-faithful — `.reduce` without an
// initial value is a footgun in JS too) but its specific value is unused
// in the `$group` lowering (MongoDB accumulators have their own neutral
// elements). Validated to be a literal so a stray `$.field` reference
// can't sneak through.
//
// Distinct from the existing `.reduce` chained terminal on
// `$$$.<coll>.find/filter(...)` chains (in `lookup-translation.ts`) —
// that one builds a `$reduce` expression over a materialised array slot.
// Different surface, different target operator, intentionally kept
// separate. `.reduce` is also explicitly NOT in `STREAM_METHODS` — the
// chain walker rejects it with an actionable wrap-pattern hint via
// `unknownStreamMethod`.

type ReduceAccumulator =
  | { kind: "sum"; value: string | number }
  | { kind: "max"; value: string }
  | { kind: "min"; value: string }
  | { kind: "first"; value: string }
  | { kind: "last"; value: string }
  | { kind: "push"; value: string };

export type ReduceWrapEntry = { key: string; accumulator: ReduceAccumulator; pos: number };

/**
 * Pattern-match an accumulator expression. The `isAccRef` predicate decides
 * what counts as the accumulator reference — for scalar reducers it's
 * `ParamRef(accParam)`; for object reducers (one accumulator per key) it's
 * `MemberAccess { object: ParamRef(accParam), member: key }`. Reusing one
 * matcher keeps the supported reducer shapes in lock-step across both forms.
 *
 * Recognised body shapes:
 *   - `<acc> + d.<path>`        →  $sum: "$<path>"
 *   - `<acc> + 1`                →  $sum: 1 (count)
 *   - `Math.max(<acc>, d.<path>)`→  $max: "$<path>"
 *   - `Math.min(<acc>, d.<path>)`→  $min: "$<path>"
 *   - `<acc> ?? d.<path>`        →  $first: "$<path>" (first non-null value)
 *   - `d.<path>` (acc-ignoring)  →  $last: "$<path>" (always-overwrite ⇒ last value)
 *   - `[...<acc>, d.<path>]`     →  $push: "$<path>"
 *   - `<acc>.concat(d.<path>)`   →  $push: "$<path>" (alt spelling)
 */
function classifyAccumulatorExpr(body: Expr, isAccRef: (e: Expr) => boolean, dParam: string): ReduceAccumulator | null {
  // $sum / count via `acc + ...`
  if (body.type === "BinaryExpr" && body.op === "+") {
    const otherSide = isAccRef(body.left) ? body.right : isAccRef(body.right) ? body.left : null;
    if (otherSide !== null) {
      if (otherSide.type === "NumberLiteral" && otherSide.value === 1) {
        return { kind: "sum", value: 1 };
      }
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: "sum", value: `$${path}` };
    }
  }
  // $max / $min via Math.max(acc, d.<path>) / Math.min(acc, d.<path>)
  if (body.type === "MathCall" && (body.method === "max" || body.method === "min") && body.args.length === 2) {
    const [a0, a1] = body.args;
    if (a0.type === "SpreadElement" || a1.type === "SpreadElement") return null;
    const a0e = a0 as Expr;
    const a1e = a1 as Expr;
    const otherSide = isAccRef(a0e) ? a1e : isAccRef(a1e) ? a0e : null;
    if (otherSide !== null) {
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: body.method, value: path };
    }
  }
  // $first via `acc ?? d.<path>` (or `acc.<key> ?? d.<path>` for object form).
  // JS-faithful: ?? returns LHS if LHS is non-null, else RHS. Across the
  // group, the accumulator stays at its initial value (null) until the first
  // non-null d.<path> arrives — exactly $first semantics.
  if (body.type === "BinaryExpr" && body.op === "??") {
    if (isAccRef(body.left)) {
      const path = paramFieldPath(body.right, dParam);
      if (path !== null) return { kind: "first", value: path };
    }
  }
  // $last via bare `d.<path>` — body doesn't reference acc at all, so every
  // doc overwrites; the final value wins, matching $last in MongoDB.
  {
    const path = paramFieldPath(body, dParam);
    if (path !== null) return { kind: "last", value: path };
  }
  // $push via `[...acc, d.<path>]` (single-element spread + push) OR
  // `acc.concat(d.<path>)` (method form).
  if (body.type === "ArrayLiteral" && body.elements.length === 2) {
    const [first, second] = body.elements;
    if (first.type === "SpreadElement" && isAccRef(first.argument) && second.type !== "SpreadElement") {
      // Reject update-op array elements (AssignExpr/DeleteStmt/LetDecl); only
      // Expr second elements are valid here.
      if (
        second.type === "AssignExpr" ||
        second.type === "DeleteStmt" ||
        second.type === "LetDecl" ||
        second.type === "FuncDecl"
      )
        return null;
      const path = paramFieldPath(second, dParam);
      if (path !== null) return { kind: "push", value: path };
    }
  }
  if (body.type === "MethodCall" && body.method === "concat" && body.args.length === 1) {
    if (isAccRef(body.object)) {
      const arg = body.args[0];
      if (arg.type !== "SpreadElement") {
        const path = paramFieldPath(arg, dParam);
        if (path !== null) return { kind: "push", value: path };
      }
    }
  }
  return null;
}

function classifyReduceBody(body: Expr, accParam: string, dParam: string): ReduceAccumulator | null {
  return classifyAccumulatorExpr(body, (e) => e.type === "ParamRef" && e.name === accParam, dParam);
}

type ObjectLiteralNode = Extract<Expr, { type: "ObjectLiteral" }>;

/**
 * Detect the wrap patterns that consume `$$.reduce(...)` back into the
 * stream. Two forms, both lowering to the same `$group` + `$replaceWith`
 * pair via `lowerReduceWrap`:
 *
 *   1. **Scalar wrap.** `$$ = [{ <key>: $$.reduce(…, <literal-init>), … }];`
 *      The inner array element is an object literal; each entry is a direct
 *      `$$.reduce(...)` call. One accumulator per entry.
 *
 *   2. **Object reducer.** `$$ = [$$.reduce((acc, d) => ({...acc, <key>: <expr>, ...}), { <key>: <init>, ... })];`
 *      The inner array element is the `$$.reduce(...)` call itself; the
 *      reducer body returns an object literal whose keys become the
 *      accumulator namespace. Each entry's value is pattern-matched the
 *      same way as the scalar form, except `acc` is referenced as
 *      `acc.<key>` (not bare `acc`).
 *
 * The array-returning reducer form (`$$ = [$$.reduce(... => acc.concat(...), [])]`)
 * is **not** handled here — its lowering is `$match` + `$replaceWith` rather
 * than `$group`-shaped, so it has its own detector / lowering pair
 * (`detectArrayReducerWrap` / `lowerArrayReducerWrap`).
 *
 * Returns `null` for non-matching shapes (the caller falls through to the
 * other RHS handlers, including the array-reducer detector). Throws for
 * matching-but-malformed shapes so the user sees a precise error instead of
 * a generic "RHS must be …".
 */
export function detectReduceWrap(value: Expr): ReduceWrapEntry[] | null {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type === "ObjectLiteral") return detectScalarReduceWrap(el);
  if (el.type === "MethodCall" && el.method === "reduce" && el.object.type === "CollectionRef") {
    // An ArrayLiteral init means the user wants the array-returning reducer
    // form — let `detectArrayReducerWrap` handle it. (We could also throw
    // here with a more precise message, but the fall-through keeps the two
    // detectors decoupled: each one only commits to its shape when it sees
    // its own init type.)
    if (el.args.length === 2 && el.args[1].type === "ArrayLiteral") return null;
    return detectObjectReducerWrap(el);
  }
  return null;
}

function detectScalarReduceWrap(docEl: ObjectLiteralNode): ReduceWrapEntry[] | null {
  if (docEl.entries.length === 0) return null;
  // First pass: every entry must be `<staticKey>: $$.reduce(...)`.
  for (const entry of docEl.entries) {
    if (entry.type !== "KeyValueEntry") return null;
    if (entry.key.kind !== "static") return null;
    const ev = entry.value;
    if (ev.type !== "MethodCall") return null;
    if (ev.method !== "reduce") return null;
    if (ev.object.type !== "CollectionRef") return null;
  }
  // Second pass: validate and classify each reducer. (Throwing only happens
  // here so a near-miss shape — e.g. a single-doc array literal with one
  // non-reduce entry — falls through cleanly via the early `return null`s
  // above.)
  const out: ReduceWrapEntry[] = [];
  for (const entry of docEl.entries) {
    if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") continue;
    const ev = entry.value as Extract<Expr, { type: "MethodCall" }>;
    validateReduceCallBasics(ev);
    ensureLiteralInit(ev);
    const lambda = ev.args[0] as LambdaNode;
    const [accParam, dParam] = lambda.params;
    const body = lambda.body as Expr;
    const accumulator = classifyReduceBody(body, accParam, dParam);
    if (accumulator === null) {
      throw new CodegenError(
        `$$.reduce((${accParam}, ${dParam}) => …) supports these reducer shapes: ` +
          `'${accParam} + ${dParam}.<field>' (→ $sum), '${accParam} + 1' (→ $sum: 1, count), ` +
          `'Math.max(${accParam}, ${dParam}.<field>)' (→ $max), 'Math.min(${accParam}, ${dParam}.<field>)' (→ $min). ` +
          `Other shapes aren't supported yet — write the $group stage by hand.`,
        body.pos ?? ev.pos,
      );
    }
    out.push({ key: entry.key.name, accumulator, pos: entry.pos });
  }
  return out;
}

function detectObjectReducerWrap(reduceCall: Extract<Expr, { type: "MethodCall" }>): ReduceWrapEntry[] {
  validateReduceCallBasics(reduceCall);
  const lambda = reduceCall.args[0] as LambdaNode;
  const initArg = reduceCall.args[1];
  const [accParam, dParam] = lambda.params;
  const body = lambda.body as Expr;
  if (body.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'$$ = [$$.reduce(...)]' requires the reducer to return an object literal — '(${accParam}, ${dParam}) => ({ ...${accParam}, <key>: <expr>, ... })'. ` +
        `For scalar reducers, use the object-wrap form instead: '$$ = [{ <key>: $$.reduce((acc, d) => …, <literal-init>) }];'.`,
      body.pos,
    );
  }
  if (initArg.type === "SpreadElement" || initArg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'$$ = [$$.reduce(<reducer>, <init>)]' with an object-returning reducer requires an object init that names each accumulator key — got '${initArg.type}'. Write '{ <key1>: <init1>, <key2>: <init2>, ... }' matching the keys returned by the reducer body.`,
      ("pos" in initArg ? initArg.pos : reduceCall.pos) as number,
    );
  }
  return classifyObjectReducer(reduceCall, body, initArg, accParam, dParam);
}

function classifyObjectReducer(
  reduceCall: Extract<Expr, { type: "MethodCall" }>,
  body: ObjectLiteralNode,
  init: ObjectLiteralNode,
  accParam: string,
  dParam: string,
): ReduceWrapEntry[] {
  // Body entries: optional leading `...accParam` spread, then static-keyed entries.
  const bodyEntries: { key: string; value: Expr; pos: number }[] = [];
  let seenNamedEntry = false;
  for (const entry of body.entries) {
    if (entry.type === "SpreadElement") {
      if (seenNamedEntry) {
        throw new CodegenError(
          `Object-reducer body's '...${accParam}' spread must be the first entry, not after named keys.`,
          entry.pos,
        );
      }
      const sp = entry.argument;
      if (sp.type !== "ParamRef" || sp.name !== accParam) {
        throw new CodegenError(
          `Object-reducer body may only spread the accumulator parameter ('...${accParam}'). Spreads of other expressions aren't supported.`,
          entry.pos,
        );
      }
      continue;
    }
    seenNamedEntry = true;
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `Object-reducer body entry must have a static key. Computed keys ('[expr]: …') aren't supported.`,
        entry.pos,
      );
    }
    bodyEntries.push({ key: entry.key.name, value: entry.value, pos: entry.pos });
  }
  if (bodyEntries.length === 0) {
    throw new CodegenError(
      `Object-reducer body must declare at least one '<key>: <reducer-expr>' entry (got an empty or spread-only object).`,
      body.pos,
    );
  }
  // Init keys.
  const initKeys = new Set<string>();
  for (const entry of init.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(
        `The init object passed to $$.reduce must be a literal '{ <key>: <init>, ... }' — spreads aren't supported.`,
        entry.pos,
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`The init object's keys must be static (no computed '[expr]:' keys).`, entry.pos);
    }
    initKeys.add(entry.key.name);
  }
  // Body keys must match init keys exactly. (Asymmetric sets would mean
  // either an accumulator with no starting value or a starting value with
  // no per-doc update — both are user-side bugs in JS too.)
  const bodyKeys = new Set(bodyEntries.map((e) => e.key));
  const missingInInit = Array.from(bodyKeys).filter((k) => !initKeys.has(k));
  const missingInBody = Array.from(initKeys).filter((k) => !bodyKeys.has(k));
  if (missingInInit.length > 0 || missingInBody.length > 0) {
    const parts: string[] = [];
    if (missingInInit.length > 0) parts.push(`init is missing keys [${missingInInit.join(", ")}]`);
    if (missingInBody.length > 0) parts.push(`body is missing keys [${missingInBody.join(", ")}]`);
    throw new CodegenError(
      `Object-reducer body and init must declare the same keys (${parts.join("; ")}). Each key needs a starting value in init and a per-doc update in the body.`,
      reduceCall.pos,
    );
  }
  // Classify each body entry's value.
  const out: ReduceWrapEntry[] = [];
  for (const entry of bodyEntries) {
    const accumulator = classifyAccumulatorExpr(
      entry.value,
      (e) =>
        e.type === "MemberAccess" &&
        e.object.type === "ParamRef" &&
        e.object.name === accParam &&
        e.member === entry.key,
      dParam,
    );
    if (accumulator === null) {
      throw new CodegenError(
        `Object-reducer entry '${entry.key}: …' — supported shapes: ` +
          `'${accParam}.${entry.key} + ${dParam}.<field>' (→ $sum), '${accParam}.${entry.key} + 1' (→ $sum: 1, count), ` +
          `'Math.max(${accParam}.${entry.key}, ${dParam}.<field>)' (→ $max), 'Math.min(${accParam}.${entry.key}, ${dParam}.<field>)' (→ $min). ` +
          `Each entry must reference '${accParam}.${entry.key}' as the accumulator side.`,
        entry.value.pos ?? entry.pos,
      );
    }
    out.push({ key: entry.key, accumulator, pos: entry.pos });
  }
  return out;
}

function validateReduceCallBasics(call: Extract<Expr, { type: "MethodCall" }>): void {
  if (call.args.length !== 2) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) takes exactly two arguments (the reducer arrow and the initial value), got ${call.args.length}.`,
      call.pos,
    );
  }
  const [arg0, arg1] = call.args;
  if (arg0.type === "SpreadElement") {
    throw new CodegenError(`$$.reduce(...) does not accept spread arguments.`, arg0.pos);
  }
  if (arg1.type === "SpreadElement") {
    throw new CodegenError(`$$.reduce(...) does not accept spread arguments.`, arg1.pos);
  }
  if (arg0.type !== "Lambda") {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) requires an arrow function as the first argument.`,
      arg0.pos,
    );
  }
  if (arg0.params.length !== 2) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) requires a two-parameter arrow '(acc, d) => …' (got ${arg0.params.length} params).`,
      arg0.pos,
    );
  }
  if (arg0.body === undefined) {
    throw new CodegenError(`$$.reduce(...) requires an expression body, not a block.`, arg0.pos);
  }
}

function ensureLiteralInit(call: Extract<Expr, { type: "MethodCall" }>): void {
  const arg1 = call.args[1] as Expr;
  const isLiteral =
    arg1.type === "NumberLiteral" ||
    arg1.type === "StringLiteral" ||
    arg1.type === "BooleanLiteral" ||
    arg1.type === "NullLiteral" ||
    arg1.type === "BigIntLiteral";
  if (!isLiteral) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <scalar-expr>, <init>) — the initial value must be a literal (number, string, boolean, null) for the scalar wrap form. For object-returning reducers, use '$$ = [$$.reduce((acc, d) => ({ ...acc, ... }), { ... })];' instead.`,
      ("pos" in arg1 ? arg1.pos : call.pos) as number,
    );
  }
}

// ── Dictionary-build reducer wrap → $group + $replaceWith ────────────────────
//
// `$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<keyPath>]: <d.<valPath>|d> }), {})];`
//
// The single-computed-key form of the object-returning reducer. Distinct from
// the static-key object-reducer (which the user names every accumulator at
// compile time) because here the *keys come from runtime data* — one input
// doc, one output entry, key/value both read off the doc. Lowers to:
//
//   [{ $group:       { _id: null, __jsmqlTmp: { $push: { k: "$<keyPath>", v: "$<valPath>"|"$$ROOT" } } } },
//    { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } }]
//
// The leading `...acc` spread is supported (JS-faithful — that's how `{ ...acc, [k]: v }`
// is conventionally spelled in JS) but optional: `(acc, d) => ({ [d.k]: d.v })`
// works equally well. The init MUST be `{}` (empty object) — non-empty seeds
// have no MQL accumulator analogue. Mixed shapes (computed key + static key in
// the same body, e.g. `({ ...acc, [d.k]: d.v, count: acc.count + 1 })`) fall
// through to the existing object-reducer path, which will report the
// computed-key error there.

export type DictBuildWrap = {
  /** Path on `d` for the dict-entry key (e.g. "id" or "user.email"). */
  keyPath: string;
  /** Path on `d` for the dict-entry value, OR null when the value is the bare doc. */
  valuePath: string | null;
  /** Lambda position for actionable errors. */
  lambdaPos: number;
};

/**
 * Detect the dict-build wrap form. Returns null if the shape doesn't match
 * (so `detectReduceWrap` / `detectArrayReducerWrap` can have a turn);
 * returns a `DictBuildWrap` when it does match cleanly.
 *
 * Deliberately narrow: requires exactly one computed-key entry (plus optional
 * leading `...acc` spread), key path rooted on the `d` param, value path or
 * bare `d`, and `{}` init. Anything richer (multiple computed keys, mixed
 * static + computed, computed key reading from `acc`) is not this pattern
 * and either lands in the existing object-reducer path or surfaces a clear
 * error there.
 */
export function detectDictBuildWrap(value: Expr): DictBuildWrap | null {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type !== "MethodCall" || el.method !== "reduce" || el.object.type !== "CollectionRef") return null;
  if (el.args.length !== 2) return null;
  const lambda = el.args[0];
  const init = el.args[1];
  if (lambda.type === "SpreadElement" || init.type === "SpreadElement") return null;
  if (lambda.type !== "Lambda" || lambda.params.length !== 2 || lambda.body === undefined) return null;
  if (init.type !== "ObjectLiteral" || init.entries.length !== 0) return null;
  const body = lambda.body;
  if (body.type !== "ObjectLiteral") return null;
  const [accParam, dParam] = lambda.params;
  // Walk entries: optional leading `...acc` spread, then exactly one
  // computed-key entry. Any other shape (static keys, second computed entry,
  // bare-value spreads) is not dict-build.
  let seenComputed = false;
  let result: DictBuildWrap | null = null;
  for (const entry of body.entries) {
    if (entry.type === "SpreadElement") {
      if (seenComputed) return null;
      if (entry.argument.type !== "ParamRef" || entry.argument.name !== accParam) return null;
      continue;
    }
    // KeyValueEntry
    if (seenComputed) return null;
    if (entry.key.kind !== "computed") return null;
    const keyPath = paramFieldPath(entry.key.expr, dParam);
    if (keyPath === null) return null;
    const valuePath = paramFieldOrBareParam(entry.value, dParam);
    if (valuePath === undefined) return null;
    result = { keyPath, valuePath, lambdaPos: lambda.pos };
    seenComputed = true;
  }
  return result;
}

/**
 * Bare `d` → null (lowering uses `$$ROOT`); `d.<path>` → "<path>".
 * Anything else returns `undefined` (caller bails to "not dict-build").
 */
function paramFieldOrBareParam(expr: Expr, param: string): string | null | undefined {
  if (expr.type === "ParamRef" && expr.name === param) return null;
  const path = paramFieldPath(expr, param);
  if (path !== null) return path;
  return undefined;
}

/**
 * Lower a detected dict-build wrap to the `$group` + `$replaceWith` pair.
 * Collects the `{k, v}` pairs into the flat `GROUP_TMP` slot (a `$group`
 * accumulator output key can't be dotted, so this is the namespace's
 * group-output exception — see namespace.ts); `$replaceWith` consumes it on
 * the very next stage, so it never reaches the developer's output.
 */
export function lowerDictBuildWrap(wrap: DictBuildWrap): object[] {
  const v: string = wrap.valuePath === null ? "$$ROOT" : `$${wrap.valuePath}`;
  return [
    { $group: { _id: null, [GROUP_TMP]: { $push: { k: `$${wrap.keyPath}`, v } } } },
    { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } },
  ];
}

/**
 * Emit the `$group` + `$replaceWith` pair for a detected `[{key: $$.reduce(…), …}]`
 * wrap. The `$group` collects every keyed accumulator under `_id: null`; the
 * trailing `$replaceWith` drops the `_id: null` field so the output stream is
 * a single doc with exactly the user-named keys.
 */
export function lowerReduceWrap(entries: readonly ReduceWrapEntry[]): object[] {
  const groupBody: Record<string, unknown> = { _id: null };
  const replaceBody: Record<string, unknown> = {};
  for (const entry of entries) {
    const acc = entry.accumulator;
    // Map accumulator kind to MQL operator and value form. `sum` is the only
    // kind that takes a non-`$<path>` value (`1` for the count form); every
    // other kind takes a `$<path>` field reference.
    const op =
      acc.kind === "sum"
        ? "$sum"
        : acc.kind === "max"
          ? "$max"
          : acc.kind === "min"
            ? "$min"
            : acc.kind === "first"
              ? "$first"
              : acc.kind === "last"
                ? "$last"
                : "$push";
    const v: string | number = acc.kind === "sum" ? acc.value : `$${acc.value}`;
    groupBody[entry.key] = { [op]: v };
    replaceBody[entry.key] = `$${entry.key}`;
  }
  return [{ $group: groupBody }, { $replaceWith: replaceBody }];
}

// ── Array-returning reducer wrap → $match (optional) + $replaceWith ───────────
//
// `$$ = [$$.reduce(<reducer>, [])];` — the third wrap form. Used when the
// reducer collapses the stream into a flat array of projected docs:
//
//   • Unconditional map:  '(acc, d) => acc.concat(d.<path>)'
//       → '[{$replaceWith: "$<path>"}]'   (each input doc becomes its sub-doc)
//
//   • Filter + map (ternary):  '(acc, d) => (cond ? acc.concat(d.<path>) : acc)'
//       → '[{$match: <cond translated>}, {$replaceWith: "$<path>"}]'
//
//   • Identity variants where `d` itself is concatted (bare param, no `.path`)
//     skip the `$replaceWith` — the docs flow through unchanged.
//
// The init MUST be `[]` (empty array) — non-empty initial arrays are rejected
// because no MQL accumulator preserves a JS-faithful "seed array" semantic.
// The body's `.concat(...)` argument must be a path on `d` (a sub-doc the
// stream will replace each input doc with) or bare `d` (identity, used for
// pure filter shapes).
//
// Distinct from the `$group`-shaped scalar/object wraps because the output
// is a doc-shaped stream of the projected fields, not a single summary doc.
// Detection commits at the init-is-empty-ArrayLiteral check; lowering lives
// in `pipeline.ts` so it can reuse `lowerStreamFilterPredicate` for the
// condition (same predicate translation `.filter` uses).

export type ArrayReducerProject = { kind: "field"; path: string } | { kind: "identity" };

export type ArrayReducerWrap = {
  /** Identity (`acc.concat(d)`) or field-path projection (`acc.concat(d.<path>)`). */
  project: ArrayReducerProject;
  /**
   * When present, the lowering emits a `$match` stage before the projection
   * using this expression as the predicate body. Translated through
   * `lowerStreamFilterPredicate` in pipeline.ts (same engine `.filter` uses).
   */
  condition: Expr | null;
  /** The reducer's per-doc parameter name (used to translate the condition). */
  dParam: string;
  /** Lambda position (for actionable errors). */
  lambdaPos: number;
};

/** `$$.reduce(<reducer>, [<...>])` — a reduce on the stream seeded with an array literal. */
function isArrayInitReduce(el: ArrayElement): el is Extract<Expr, { type: "MethodCall" }> {
  return (
    el.type === "MethodCall" &&
    el.method === "reduce" &&
    el.object.type === "CollectionRef" &&
    el.args.length === 2 &&
    el.args[1].type === "ArrayLiteral"
  );
}

/**
 * Detect `$$ = $$.reduce(<reducer>, [])` — the array-returning reducer form.
 * A reducer seeded with `[]` already returns an array, i.e. a stream, so it is
 * assigned **unbracketed**. Returns the classified `ArrayReducerWrap`, or null
 * for non-matching shapes (the caller falls through to other handlers).
 *
 * Throws for: the legacy **bracketed** form `$$ = [$$.reduce(…, [])]` (wrapping
 * a stream in `[ ]` yields `[[…]]` — nonsense; the throw points at the
 * unbracketed form); a non-empty seed array; and unrecognised reducer bodies.
 */
export function detectArrayReducerWrap(value: Expr): ArrayReducerWrap | null {
  // Legacy bracketed shape: detect it precisely and reject with a fix-it hint.
  // Everything else inside an array literal falls through to `null`.
  if (value.type === "ArrayLiteral") {
    if (value.elements.length !== 1) return null;
    if (!isArrayInitReduce(value.elements[0])) return null;
    throw new CodegenError(
      `A reducer seeded with '[]' already produces a stream, so don't wrap it in '[ ]' — assign it directly: '$$ = $$.reduce((acc, d) => …, [])'.`,
      value.pos,
    );
  }
  if (!isArrayInitReduce(value)) return null;
  const el = value;
  const initArg = el.args[1];
  // Past this point we commit — throw for malformed shapes.
  if (initArg.type === "ArrayLiteral" && initArg.elements.length !== 0) {
    throw new CodegenError(
      `'$$ = $$.reduce(<reducer>, <init>)' with an array-returning reducer requires the init to be '[]' — a non-empty seed array isn't supported (no MQL accumulator preserves the JS-faithful "start with these elements" semantic).`,
      initArg.pos,
    );
  }
  validateReduceCallBasics(el);
  const lambda = el.args[0] as LambdaNode;
  const [accParam, dParam] = lambda.params;
  const body = lambda.body as Expr;
  const classified = classifyArrayReducerBody(body, accParam, dParam);
  if (classified === null) {
    throw new CodegenError(
      `Array-returning reducer body — supported shapes:\n` +
        `  • Unconditional map:  '(${accParam}, ${dParam}) => ${accParam}.concat(${dParam}.<field>)'  →  '$replaceWith: "$<field>"'\n` +
        `  • Filter + map:       '(${accParam}, ${dParam}) => (<cond> ? ${accParam}.concat(${dParam}.<field>) : ${accParam})'  →  '$match(<cond>) + $replaceWith: "$<field>"'\n` +
        `  • The '${dParam}' itself (bare param) instead of '${dParam}.<field>' projects the whole doc (no '$replaceWith').\n` +
        `Other shapes — '${accParam}.concat([${dParam}.<x>, ${dParam}.<y>])', '[...${accParam}, ${dParam}.<x>]', non-ternary branches — aren't supported yet.`,
      body.pos,
    );
  }
  return { ...classified, dParam, lambdaPos: lambda.pos };
}

function classifyArrayReducerBody(
  body: Expr,
  accParam: string,
  dParam: string,
): { project: ArrayReducerProject; condition: Expr | null } | null {
  // Filter + map: `<cond> ? <concat-call> : acc`
  if (body.type === "TernaryExpr") {
    if (body.alternate.type !== "ParamRef" || body.alternate.name !== accParam) return null;
    const project = classifyConcatCall(body.consequent, accParam, dParam);
    if (project === null) return null;
    return { project, condition: body.condition };
  }
  // Unconditional map: `<concat-call>`
  const project = classifyConcatCall(body, accParam, dParam);
  if (project !== null) return { project, condition: null };
  return null;
}

function classifyConcatCall(expr: Expr, accParam: string, dParam: string): ArrayReducerProject | null {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "concat") return null;
  if (expr.object.type !== "ParamRef" || expr.object.name !== accParam) return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  // Bare `d` — identity (no projection).
  if (arg.type === "ParamRef" && arg.name === dParam) return { kind: "identity" };
  // `d.<path>` — field-path projection.
  const path = paramFieldPath(arg, dParam);
  if (path !== null) return { kind: "field", path };
  return null;
}

// lodash reductions that collapse a document stream to a single VALUE (a doc,
// scalar, bool, or array) and have **no** stream lowering, so they're valid only in
// a VALUE position (`const x = <chain>` / `$.field = <chain>`), where they lower
// value-mode over the materialised lookup result; rejected as a `$$ =` stream pivot
// or a bare statement (a value isn't a pipeline). `.find`/`.findLast`/`.at`/`.reduce`
// are the pre-existing members with their own tailored messages (see
// `unknownStreamMethod`); this set drives the same treatment for the rest.
// NB `.keyBy`/`.countBy`/`.groupBy` are NOT here: they also collapse to an object,
// but DO have a stream lowering (a one-doc `$arrayToObject` stream), so they work in
// BOTH positions — see COUNT_BY / GROUP_BY / KEY_BY.
export const VALUE_TERMINAL_METHODS: ReadonlySet<string> = new Set([
  "head",
  "first",
  "last",
  "nth",
  "size",
  "every",
  "some",
  "includes",
  "partition",
  // Aggregates that collapse the stream to one scalar — same value-position rule.
  "sum",
  "mean",
  "max",
  "min",
  "sumBy",
  "meanBy",
  "minBy",
  "maxBy",
]);

// ── Registry ──────────────────────────────────────────────────────────────────

const STREAM_METHODS: Record<string, StreamMethodDef> = {
  slice: SLICE,
  sample: SAMPLE,
  take: TAKE,
  drop: DROP,
  tail: TAIL,
  takeWhile: TAKE_WHILE,
  dropWhile: DROP_WHILE,
  shuffle: SHUFFLE,
  sampleSize: SAMPLE_SIZE,
  concat: CONCAT,
  map: MAP,
  sort: SORT,
  aggregate: AGGREGATE,
  toSorted: TO_SORTED,
  sortBy: SORT_BY,
  orderBy: ORDER_BY,
  groupBy: GROUP_BY,
  countBy: COUNT_BY,
  keyBy: KEY_BY,
  uniqBy: UNIQ_BY,
  pick: PICK,
  omit: OMIT,
  flatMap: FLAT_MAP,
  // Note: `.reduce` is deliberately NOT in this registry. `arr.reduce(...)`
  // returns a scalar / object / array in JS depending on the reducer. A
  // scalar/object result must be wrapped into a stream-shaped RHS; an
  // array-returning reducer already IS a stream and is assigned unbracketed.
  // The chain walker's `unknownStreamMethod` helper special-cases `.reduce`
  // with an actionable hint, and the forms are implemented above:
  //   • `detectReduceWrap`         — scalar-into-object `$$ = [{ k: $$.reduce(…) }]` & object-returning `$$ = [$$.reduce(…, {})]` ($group + $replaceWith)
  //   • `detectArrayReducerWrap`   — array-returning `$$ = $$.reduce(…, [])`, unbracketed ($match + $replaceWith); the bracketed form throws
};

/** Look up a registered stream method by name; null if not registered. */
export function lookupStreamMethod(name: string): StreamMethodDef | null {
  return STREAM_METHODS[name] ?? null;
}

/** Names of all registered stream methods (for error messages). */
export function streamMethodNames(): readonly string[] {
  return Object.keys(STREAM_METHODS);
}

// ── Chain collection helper ───────────────────────────────────────────────────

export type MethodCallNode = Extract<Expr, { type: "MethodCall" }>;

export type StreamChain = {
  /** The receiver at the innermost end of the chain (CollectionRef, DatabaseRef-rooted member access, etc.). */
  root: Expr;
  /** Method calls in the order they apply (innermost first). */
  methods: MethodCallNode[];
};

/**
 * Walk an Expr that's expected to be a chain of `.method(...)` calls and
 * separate the innermost receiver from the chain. Always succeeds —
 * non-MethodCall input returns `{ root: expr, methods: [] }`. Callers
 * inspect `root.type` to decide whether the chain is rooted at a
 * legitimate stream/collection receiver.
 */
export function collectStreamChain(expr: Expr): StreamChain {
  const methods: MethodCallNode[] = [];
  let cur: Expr = expr;
  while (cur.type === "MethodCall") {
    methods.push(cur);
    cur = cur.object;
  }
  methods.reverse();
  return { root: cur, methods };
}
