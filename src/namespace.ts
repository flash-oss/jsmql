// Single source of truth for the `__jsmql` document namespace — the one
// top-level object where jsmql stashes compiler-generated temporaries, so
// values can move between stages without flooding the developer's output.
// A single trailing `{ $unset: "__jsmql" }` removes everything here before
// output. The Env appends this `$unset` when a stage writes under the
// namespace (src/compiler/emit/env.ts). See src/CLAUDE.md § Invariants.
//
// The scheme — sub-bucketed by kind:
//   __jsmql.var.<name>   — `let` / `const` bindings           → bindingSlot()
//   __jsmql.tmp.<n>      — anonymous compiler scratch          → tmpSlot()
//                          (lookup result slots, fan-out / $unwind slots,
//                          stream-method intermediates; the per-pipeline
//                          counter is the Env's, in src/compiler/emit/env.ts,
//                          and it builds its path here)
//   __jsmql.<reserved>   — named system values                (for example, the
//                          stream length `__jsmql.length`)
//
// THE ONE EXCEPTION: `$group` / `$bucket` accumulator OUTPUT keys may not
// contain dots, so scratch produced *inside* a group cannot live under the
// object. Such scratch uses the flat reserved name `GROUP_TMP` and MUST be
// consumed by the stage that immediately follows it (so it never reaches
// output or the trailing `$unset`).

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
 * Reserved named system value: the current stream length (`$$.length`).
 * A `$setWindowFields` `$count` materialises this value per document, and the
 * field path `"$" + LENGTH_SLOT` reads it back. It is a reserved key, so it
 * cannot collide with a user binding (`let length` → `__jsmql.var.length`).
 * See docs/specs/stream-length.md.
 */
export const LENGTH_SLOT = `${JSMQL_NS}.length`;

/**
 * Flat reserved scratch name for `$group` / `$bucket` accumulator output.
 * MongoDB forbids dotted field names there, so the value cannot live under the
 * `__jsmql` object. The stage that immediately follows must consume it. This
 * is the single documented exception to "all temporaries live under `__jsmql.`".
 */
export const GROUP_TMP = `${JSMQL_NS}Tmp`;

// ── `$lookup.let` correlation-variable names ──────────────────────────────────
//
// A nested sub-pipeline may reference a value from an OUTER JS scope. jsmql
// threads that value in through the lookup's `$lookup.let`, and the sub-pipeline
// reads it back as a `$$<name>` variable. These names are MongoDB **variable**
// names (NOT document fields), so — unlike the `__jsmql.*` field namespace above
// — they MUST start with a lowercase ASCII letter: the server rejects a `$$`
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
 * name is far more permissive: `sub-id`, `2fa`, and Unicode text are all legal.
 * When a correlation var is named after an outer field's last path segment
 * (`letFieldVar`), any char outside `[A-Za-z0-9_]` — a hyphen is the common one —
 * would make the emitted var name server-invalid (`FailedToParse: '…' contains
 * an invalid character for a variable name`), an HR3 violation. So this function
 * maps every such char to `_`.
 *
 * This mapping is deliberately NOT injective — `sub-id` and `sub_id` both fold
 * to `sub_id`. Collision safety is the `LetAllocator`'s job, not this function's:
 * it interns on the RAW field path and appends `_2`/`_3` when two distinct paths
 * yield the same base name, so two distinct fields still get two distinct vars
 * and the same field always gets the same var. This function only sanitises the
 * emitted NAME; the value side of the `$lookup.let` entry keeps the raw field
 * path (hyphens are legal in a field-path string). See docs/specs/lookup-stage.md
 * § Auto-`let` extraction.
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

/** `$lookup.let` var for a system value (for example, a stream length) — `jsmql_s<depth>_<name>`. */
export function letSysVar(name: string, depth: number): string {
  return `${JSMQL_NS_VAR}s${depth}_${sanitizeVarSegment(name)}`;
}

/** Prefix for `$lookup.let` correlation vars — must start with a letter (no `__`). */
const JSMQL_NS_VAR = "jsmql_";

// ── In-expression `$let` / `$map` / `$filter` variable names ──────────────────
//
// The third namespace. When a lowering needs to bind a value it computed itself
// — a receiver it must not evaluate twice, a loop element, an index — it emits a
// MongoDB variable. That name shares one flat scope with the user's own lambda
// parameters. A bare name (`s`, `v`, `kv`) is therefore a capture hazard whenever
// the lowering also splices OUTER-scope codegen into the `$let`'s `in:` clause:
// `.padStart(s.n)` inside `.map(s => …)` would re-resolve `s` against the
// receiver instead. This namespace uses the same grammar constraint as the
// correlation vars above (lowercase lead, `[A-Za-z0-9_]`), so the shared
// `jsmql` prefix carries over.
//
// The prefix alone is only a convention, though — nothing stops a user naming a
// param `jsmqlArr`. Uniqueness is `Scope.bind` in src/compiler/emit/names.ts,
// which gensyms this name against every name the program introduces; this
// module owns the SPELLING only.

/**
 * Name for a compiler-emitted `$let` / `$map` / `$filter` variable —
 * `exprVar("arr")` → `jsmqlArr`. Callers reach this through `Scope.bind(hint)`
 * in src/compiler/emit/names.ts, which adds the collision check.
 */
export function exprVar(base: string): string {
  return `jsmql${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}
