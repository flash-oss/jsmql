// Single source of truth for the `__jsmql` document namespace — the one
// top-level object jsmql stashes compiler-generated temporaries in, so values
// can be threaded between stages without flooding the developer's output.
// Everything here is removed before output by a single trailing
// `{ $unset: "__jsmql" }` (peephole-skipped when a reshape stage already
// dropped the document). See src/CLAUDE.md § the `__jsmql` namespace.
//
// The scheme — sub-bucketed by kind:
//   __jsmql.var.<name>   — `let` / `const` bindings           → bindingSlot()
//   __jsmql.tmp.<n>      — anonymous compiler scratch          → tmpSlot()
//                          (lookup result slots, fan-out / $unwind slots,
//                          stream-method intermediates; the per-pipeline
//                          counter `createSlotAllocator` lives in
//                          lookup-translation.ts for import-cycle reasons but
//                          builds its path here)
//   __jsmql.<reserved>   — named system values                (e.g. the stream
//                          length `__jsmql.length`, added with that feature)
//
// THE ONE EXCEPTION: `$group` / `$bucket` accumulator OUTPUT keys may not
// contain dots, so scratch produced *inside* a group can't live under the
// object. Such scratch uses the flat reserved name `GROUP_TMP` and MUST be
// consumed by the immediately-following stage (so it never reaches output or
// the trailing `$unset`).

/** The namespace object — the root field, and the trailing `$unset` target. */
export const JSMQL_NS = "__jsmql";

/** Field path for a user `let` / `const` binding `<name>` → `__jsmql.var.<name>`. */
export function bindingSlot(name: string): string {
  return `${JSMQL_NS}.var.${name}`;
}

/** Field path for anonymous compiler scratch slot `n` → `__jsmql.tmp.<n>`. */
export function tmpSlot(n: number): string {
  return `${JSMQL_NS}.tmp.${n}`;
}

/**
 * Reserved named system value: the current stream length (`$$.length`),
 * materialised per-document by a `$setWindowFields` `$count` and read back via
 * the field path `"$" + LENGTH_SLOT`. A reserved key, so it can't collide with
 * a user binding (`let length` → `__jsmql.var.length`). See
 * docs/specs/stream-length.md.
 */
export const LENGTH_SLOT = `${JSMQL_NS}.length`;

/**
 * The `$setWindowFields` stage that stamps the stream's document count onto
 * every document as `__jsmql.length`. The single home for this shape: the
 * top-level `$$.length` materialiser (pipeline.ts) and the lookup-chain
 * sub-stream length (stream-methods.ts) both emit it, one level apart. Lives
 * in this leaf module so both importers avoid a pipeline ↔ stream-methods
 * cycle. See docs/specs/stream-length.md.
 */
export function streamLengthStage(): object {
  return { $setWindowFields: { output: { [LENGTH_SLOT]: { $count: {} } } } };
}

/**
 * Flat reserved scratch name for `$group` / `$bucket` accumulator output, where
 * MongoDB forbids dotted field names so the value can't live under the
 * `__jsmql` object. Must be consumed by the very next stage. The single
 * documented exception to "all temporaries live under `__jsmql.`".
 */
export const GROUP_TMP = `${JSMQL_NS}Tmp`;

// ── `$lookup.let` correlation-variable names ──────────────────────────────────
//
// When a value from an OUTER JS scope is referenced inside a nested
// sub-pipeline, it's threaded in through that lookup's `$lookup.let` and read
// back as a `$$<name>` variable. These names are MongoDB **variable** names
// (NOT document fields), so — unlike the `__jsmql.*` field namespace above —
// they MUST start with a lowercase ASCII letter: the server rejects a `$$`
// variable whose name begins with `_`, `$`, or an uppercase letter. Hence the
// `jsmql_` prefix (no leading `__`).
//
// Shape: `jsmql_<kind><scopeDepth>_<name>`, where `scopeDepth` is the nesting
// depth of the JS scope the value comes from (0 = root pipeline, 1 = first
// lookup body, …) and `kind` is one of:
//   f — a document field        (`$._id` → `jsmql_f0__id`, `o.createdAt` → `jsmql_f1_createdAt`)
//   v — a `let`/`const` binding  (`const startDate = …` at depth 1 → `jsmql_v1_startDate`)
//   s — a system value          (`$$.length` → `jsmql_s0_length`, `ordersColl.length` → `jsmql_s1_length`)
// The connector after the depth is always a single `_`, so a field that itself
// starts with `_` (like `_id`) reads as `jsmql_f0__id` (doubled), by design.

/**
 * Fold a correlation-var name segment down to MongoDB's `$$`-variable grammar.
 *
 * A MongoDB **variable** name may contain only `[A-Za-z0-9_]` (and — enforced by
 * the `jsmql_` prefix — must start with a lowercase letter). A MongoDB **field**
 * name is far more permissive: `sub-id`, `2fa`, unicode, etc. are all legal. When
 * a correlation var is named after an outer field's last path segment
 * (`letFieldVar`), any char outside `[A-Za-z0-9_]` — a hyphen is the common one —
 * would make the emitted var name server-invalid (`FailedToParse: '…' contains
 * an invalid character for a variable name`), an HR3 violation. So map every such
 * char to `_`.
 *
 * This is deliberately NOT injective — `sub-id` and `sub_id` both fold to
 * `sub_id`. Collision-safety is the `LetAllocator`'s job, not ours: it interns on
 * the RAW field path and appends `_2`/`_3` when two distinct paths yield the same
 * base name, so two distinct fields still get two distinct vars and the same
 * field always gets the same var. We only sanitize the emitted NAME; the value
 * side of the `$lookup.let` entry keeps the raw field path (hyphens are legal in
 * a field-path string). See docs/specs/lookup-stage.md § Auto-`let` extraction.
 */
function sanitizeVarSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** `$lookup.let` var for an outer document field — `jsmql_f<depth>_<field>`. */
export function letFieldVar(field: string, depth: number): string {
  return `${JSMQL_NS_VAR}f${depth}_${sanitizeVarSegment(field)}`;
}

/** `$lookup.let` var for an outer `let`/`const` binding — `jsmql_v<depth>_<name>`. */
export function letBindingVar(name: string, depth: number): string {
  return `${JSMQL_NS_VAR}v${depth}_${sanitizeVarSegment(name)}`;
}

/** `$lookup.let` var for a system value (e.g. a stream length) — `jsmql_s<depth>_<name>`. */
export function letSysVar(name: string, depth: number): string {
  return `${JSMQL_NS_VAR}s${depth}_${sanitizeVarSegment(name)}`;
}

/** Prefix for `$lookup.let` correlation vars — must start with a letter (no `__`). */
const JSMQL_NS_VAR = "jsmql_";

/**
 * Is `name` one of the `$lookup.let` correlation vars above? Used to catch a
 * hoisted var that has landed in a QUERY-document slot, where MongoDB does not
 * evaluate `$$vars` and the match would silently return nothing.
 */
export function isCorrelationVar(name: string): boolean {
  return name.startsWith(JSMQL_NS_VAR);
}

/**
 * Matches a `$lookup.let` correlation-var name produced by `letFieldVar` /
 * `letBindingVar` / `letSysVar` (`jsmql_<f|v|s><depth>_<name>`). Used by codegen
 * to recognise a compiler-generated correlation `ParamRef` and emit `$$<name>`
 * even when it isn't in the current `lambdaParams` set — a deeper level's
 * cross-level read can capture into an enclosing lookup's `let` after this
 * level's `lambdaParams` was frozen, and `$$` vars propagate through nested
 * `$lookup.pipeline` boundaries, so the var is in scope by construction. */
export const CORRELATION_VAR_RE = /^jsmql_[fvs]\d+_/;
