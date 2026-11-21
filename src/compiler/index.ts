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
import { rawMqlBoundary } from "./passes/raw-mql.ts";
import { refuseNew } from "./passes/no-new.ts";
import { noStages, notAPipeline } from "./emit/errors.ts";

export function expr(source: string): unknown {
  const parsed = parseExpression(source);
  refuseNew(parsed);
  rawMqlBoundary(parsed, "other");
  const program = desugar(fold(parsed), VALUE);
  return lowerValue(program as Parameters<typeof lowerValue>[0], Env.root(program, "value"));
}

export function filter(source: string): Record<string, unknown> {
  const parsed = parseExpression(source);
  refuseNew(parsed);
  rawMqlBoundary(parsed, "filter");
  const program = desugar(fold(parsed), FILTER);
  return lowerFilter(program as Parameters<typeof lowerFilter>[0], Env.root(program, "filter"));
}

export function pipeline(source: string): unknown[] {
  const parsed = parse(source);
  if (shapeOf(parsed) !== "pipeline") throw notAPipeline((parsed as { pos: number }).pos);
  refuseNew(parsed);
  rawMqlBoundary(parsed, "other");
  const program = desugar(fold(parsed), STATEMENT);
  const stages = lowerProgram(program, Env.root(program, "statement"));
  if (stages.length === 0 && parsed.type !== "ArrayLiteral") throw noStages((program as { pos: number }).pos);
  return stages;
}

export function update(source: string): Record<string, unknown> {
  const parsed = parse(source);
  refuseNew(parsed);
  rawMqlBoundary(parsed, "other");
  const program = desugar(fold(parsed), UPDATE_DOC);
  return lowerUpdate(program, Env.root(program, "updateDoc"));
}
