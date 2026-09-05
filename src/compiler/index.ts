// The compiler's entry: source in, MQL out, through the five phases.
//
//   LEX + PARSE   parse/parser.ts     source → tree
//   FOLD          passes/fold.ts      constants settled
//   DESUGAR       passes/desugar.ts   sugar rewritten to the forms the rows know (phase 4 runs inside)
//   EMIT          emit/lower.ts       tree → document, every name checked against its row first
//
// One entry per shape of program. `expr` is the bare aggregation expression —
// what `jsmql.expr(…)` returns: no `$expr` wrap, no query translation.

import { parse, parseExpression } from "./parse/parser.ts";
import { fold } from "./passes/fold.ts";
import { desugar } from "./passes/desugar.ts";
import { FILTER, STATEMENT, UPDATE_DOC, VALUE } from "./passes/position.ts";
import { Env } from "./emit/env.ts";
import { lowerValue } from "./emit/lower.ts";
import { lowerFilter } from "./emit/filter.ts";
import { lowerProgram } from "./emit/statement.ts";
import { lowerUpdate } from "./emit/update.ts";
import { shapeOf } from "./passes/shape.ts";
import { noStages, notAPipeline } from "./emit/errors.ts";

/** A bare aggregation expression: `$.qty * $.price` → `{ $multiply: ["$qty", "$price"] }`. */
export function expr(source: string): unknown {
  const program = desugar(fold(parseExpression(source)), VALUE);
  return lowerValue(program as Parameters<typeof lowerValue>[0], Env.root(program, "value"));
}

/**
 * A query document for `find(filter)`: `$.age > 18` → `{ age: { $gt: 18 } }`. A predicate
 * with no native form becomes `{ $expr: … }`; a raw `{ … }` document is the developer's own.
 */
export function filter(source: string): Record<string, unknown> {
  const program = desugar(fold(parseExpression(source)), FILTER);
  return lowerFilter(program as Parameters<typeof lowerFilter>[0], Env.root(program, "filter"));
}

/**
 * The pipeline for `aggregate(pipeline)`: `$.total = $.qty * $.price;` →
 * `[{ $set: { total: { $multiply: ["$qty", "$price"] } } }]`. Every statement
 * of the program becomes stages, in the order it was written.
 */
export function pipeline(source: string): unknown[] {
  const program = desugar(fold(parse(source)), STATEMENT);
  // Which DOCUMENT the program becomes is phase 4's other answer, and no single
  // step can see it. Without asking, a folded constant array — `[1,2].slice(2,2)`
  // settles to `[]` — reads as the empty pipeline instead of as a value.
  if (shapeOf(program) !== "pipeline") throw notAPipeline((program as { pos: number }).pos);
  const stages = lowerProgram(program, Env.root(program, "statement"));
  if (stages.length === 0) throw noStages((program as { pos: number }).pos);
  return stages;
}

/** The object form of an update — `updateOne(filter, { $set: { … }, $inc: { … } })` — from writes and update operators. */
export function update(source: string): Record<string, unknown> {
  const program = desugar(fold(parse(source)), UPDATE_DOC);
  return lowerUpdate(program, Env.root(program, "updateDoc"));
}
