// The compiler's entry: source in, MQL out, through the five phases.
//
//   LEX + PARSE   parse/parser.ts     source → tree
//   FOLD          passes/fold.ts      constants settled
//   DESUGAR       passes/desugar.ts   sugar rewritten to the forms the rows know (phase 4 runs inside)
//   EMIT          emit/lower.ts       tree → document, every name checked against its row first
//
// One entry per shape of program. `expr` is the bare aggregation expression —
// what `jsmql.expr(…)` returns: no `$expr` wrap, no query translation.

import { parseExpression } from "./parse/parser.ts";
import { fold } from "./passes/fold.ts";
import { desugar } from "./passes/desugar.ts";
import { VALUE } from "./passes/position.ts";
import { Env } from "./emit/env.ts";
import { lowerValue } from "./emit/lower.ts";

/** A bare aggregation expression: `$.qty * $.price` → `{ $multiply: ["$qty", "$price"] }`. */
export function expr(source: string): unknown {
  const program = desugar(fold(parseExpression(source)), VALUE);
  return lowerValue(program as Parameters<typeof lowerValue>[0], Env.root(program, "value"));
}
