// Date component accessors — the first family migrated to the declaration grid.
//
// Each reads one component out of a date. MongoDB's operators are UTC by default, so the
// JS pair `.getHours()` / `.getUTCHours()` lower identically: the method name is where
// UTC was said, and naming it again in a `{ date, timezone }` object would restate the
// operator's own default. A timezone the developer TYPES still reaches the object form —
// see `.week("America/New_York")` in the date-options family.
//
// Two components deliberately follow MongoDB rather than JavaScript, and it is the same
// choice in both cases — one base across the whole language, matching the operator the
// value comes from:
//   .getMonth() is 1-based ($month), not JavaScript's 0-based
//   .getDay()   is 1-based with Sunday = 1 ($dayOfWeek), not JavaScript's 0-based
// For the ISO weekday (Monday = 1) use `.isoWeekday()`.
//
// See docs/specs/lowering-grid.md and docs/specs/method-dispatch.md § Date methods.

import type { MethodDef } from "./types.ts";

/** `<method name>` → the MongoDB operator that reads that component. */
const COMPONENT: Record<string, string> = {
  getFullYear: "$year",
  getMonth: "$month",
  getDate: "$dayOfMonth",
  getDay: "$dayOfWeek",
  getHours: "$hour",
  getMinutes: "$minute",
  getSeconds: "$second",
  getMilliseconds: "$millisecond",
  // The UTC pair. Identical lowerings, because the operators are UTC already.
  getUTCFullYear: "$year",
  getUTCMonth: "$month",
  getUTCDate: "$dayOfMonth",
  getUTCDay: "$dayOfWeek",
  getUTCHours: "$hour",
  getUTCMinutes: "$minute",
  getUTCSeconds: "$second",
  getUTCMilliseconds: "$millisecond",
};

function accessor(operator: string): MethodDef {
  return {
    receiver: "date",
    returns: "number",
    args: { sig: "", none: true },
    value: ({ recv }) => ({ [operator]: recv }),
  };
}

export const DATE_ACCESSOR_METHODS: Record<string, MethodDef> = Object.fromEntries(
  Object.entries(COMPONENT).map(([name, operator]) => [name, accessor(operator)]),
);
