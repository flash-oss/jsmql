// Chained pipeline-stage calls — `<stream>.$match(<body>)`, the chain-position
// spelling of the `$match(<body>);` statement.
//
// This is a LEAF module on purpose. Three containers resolve chain links — the
// `$$` stream and the `$unionWith` source-switch (both in pipeline.ts) and the
// `$lookup` sub-pipeline (in lookup-translation.ts) — and lookup-translation.ts
// sits *below* pipeline.ts in the dependency graph, so it cannot import back.
// Keeping name resolution, arity, and the placement rules here gives all three
// one cycle-free home, and keeps the error wording identical wherever a stage
// link was written.
//
// See docs/specs/aggregation-stages.md § chained stage calls.

import type { Expr, Pipeline } from "./ast.ts";
import { CodegenError } from "./codegen.ts";
import { didYouMean } from "./levenshtein.ts";
import { lookupOperator } from "./operators.ts";
import { lookupStage, STAGES, stageForbiddenIn, stageMustBeFirst, stageMustBeLast } from "./stages.ts";

type MethodCallNode = Extract<Expr, { type: "MethodCall" }>;
type LambdaNode = Extract<Expr, { type: "Lambda" }>;

/** Which run of stages is being assembled — drives the `forbiddenIn` rules. */
export type ContainerKind = "top" | "facet" | "lookup" | "unionWith";

/**
 * Is this chain link a stage call (`.$match(...)`) rather than a JS method?
 *
 * Deliberately loose — ANY `$`-prefixed method name, not only a registered
 * stage. This mirrors `isStageCandidate`'s treatment of `$<name>(...)` at
 * array root: claiming the link here means a typo surfaces
 * "'$prject' is not a known aggregation stage. Did you mean '$project'?"
 * instead of silently falling through to value-mode method dispatch.
 */
export function isStageLink(m: MethodCallNode): boolean {
  return m.method.startsWith("$");
}

/**
 * Resolve a stage link's name and arity, returning its body expression.
 * Arity matches the statement form (`asStageShape`): exactly one argument.
 */
export function stageLinkBody(m: MethodCallNode): Expr {
  if (lookupStage(m.method) === undefined) {
    throw new CodegenError(formatUnknownStageLink(m.method), m.pos);
  }
  if (m.args.length !== 1) {
    throw new CodegenError(
      `'.${m.method}(<body>)' takes exactly one argument — the stage body, got ${m.args.length}.`,
      m.pos,
    );
  }
  const body = m.args[0];
  if (body.type === "SpreadElement") {
    throw new CodegenError(
      `'.${m.method}(<body>)' takes the stage body directly, not a spread ('...'). Write '.${m.method}({ … })'.`,
      m.pos,
    );
  }
  return body;
}

function formatUnknownStageLink(name: string): string {
  const suggestion = didYouMean(name, Object.keys(STAGES), (s) => s);
  if (lookupOperator(name) !== undefined) {
    return (
      `'${name}' is an expression operator, not an aggregation stage — only stages chain as '.${name}(...)'.${suggestion} ` +
      `To use '${name}' as an expression, write it inside a stage body (e.g. '.$set({ x: ${name}(...) })').`
    );
  }
  return `'${name}' is not a known aggregation stage.${suggestion}`;
}

export function mustBeFirstLiteralMessage(stageName: string): string {
  return (
    `'${stageName}' must be the first stage in a pipeline — it produces the pipeline's source documents, ` +
    `so nothing can run before it. Move it to the front, or remove the stage(s) that precede it.`
  );
}

/** Message for a stage used inside a sub-pipeline container that forbids it. */
export function forbiddenInContextMessage(stageName: string, container: "facet" | "lookup" | "unionWith"): string {
  const owner = container === "facet" ? "$facet" : container === "lookup" ? "$lookup" : "$unionWith";
  return (
    `'${stageName}' is not allowed inside a '${owner}' sub-pipeline. ` + `Move it to the outer (top-level) pipeline.`
  );
}

/**
 * Structural placement rules for a stage link, for the containers that assemble
 * their stages outside `makePipelineValidator`'s loop (currently
 * `$lookup.pipeline`, via `peelForeignChain`). Same declarative source as the
 * statement path — `stages.ts`'s `forbiddenIn` / `position` — so a stage
 * rejected as `$out(...)` at statement level is rejected as `.$out(...)` too.
 */
export function checkStageLinkPlacement(
  name: string,
  pos: number,
  indexInContainer: number,
  isLastInContainer: boolean,
  container: ContainerKind,
): void {
  const def = lookupStage(name);
  if (def === undefined) return; // stageLinkBody already threw; defensive
  if (container !== "top" && stageForbiddenIn(def, container)) {
    throw new CodegenError(forbiddenInContextMessage(name, container), pos);
  }
  if (stageMustBeFirst(def) && indexInContainer > 0) {
    throw new CodegenError(mustBeFirstLiteralMessage(name), pos);
  }
  if (stageMustBeLast(def) && !isLastInContainer) {
    throw new CodegenError(
      `'${name}' must be the last stage in a pipeline. Move it to the end of the chain, or remove the links after it.`,
      pos,
    );
  }
}

/**
 * A stage link expressed as the one-statement sub-pipeline block it is
 * equivalent to: `.$match(b)` ≡ `.aggregate((o) => { $match(b); })`.
 *
 * Foreign-collection containers lower the result through the same block engine
 * `.aggregate(...)` uses (`lowerCallbackBlock`), so an outer-document read in
 * the stage body (`.$match({ userId: $._id })`) hoists into `$lookup.let` and
 * emits `$$`-var query form exactly as the `.aggregate` spelling already does.
 * The block carries no parameter — a sub-pipeline's `$` is its own document, so
 * raw `"$field"` refs pass through untouched.
 */
export function stageLinkBlockLambda(m: MethodCallNode, body: Expr): LambdaNode {
  const stmt: Expr = {
    type: "OperatorCall",
    name: m.method,
    style: body.type === "ObjectLiteral" ? "object" : "positional",
    args: [body],
    pos: m.pos,
  };
  const block: Pipeline = { type: "Pipeline", stmts: [stmt], pos: m.pos };
  return { type: "Lambda", params: [], block, pos: m.pos };
}
