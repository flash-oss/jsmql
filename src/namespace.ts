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
