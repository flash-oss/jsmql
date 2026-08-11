// The callback-block rule: a `{ … }` body on a JavaScript or lodash method is
// JavaScript — `const`/`let` bindings plus one `return <expr>` — and pipeline
// stages belong to `.aggregate(pipeline)` alone.
//
// The parser hands `.find` / `.filter` / `.map` on a stream root the same
// pipeline-block grammar `.aggregate` uses (`STREAM_BLOCK_METHODS` in parser.ts),
// so the statements the developer actually wrote are parsed and reach here. That
// is the whole reason the grammar stays shared: the rejection can name the offending
// stage and the rewrite that works in this position, instead of an "unexpected
// token" from a parser that stopped at the first `$`. A stage-free block is the
// JavaScript value form in disguise, so it normalises back to it.
//
// See docs/specs/method-dispatch.md § Callback block bodies.

import type { Expr, Lambda, LetDecl, PipelineStmt } from "./ast.ts";
import { CodegenError } from "./codegen.ts";

/** What a rejection offers instead: the spelling that runs stages in THIS position. */
export type StageRewrite = string;

/**
 * The rewrite for a foreign-collection receiver (`$$$.<coll>`, `$$$$.<db>.<coll>`),
 * where a sub-pipeline has a home of its own: `.aggregate(pipeline)`.
 */
export function aggregateRewrite(spell: string): StageRewrite {
  return `write \`${spell}.aggregate((o) => { $match(...); $sort(...); ... })\`, which runs those statements as the sub-pipeline`;
}

/**
 * The rewrite for a `$$` (current-stream) receiver. A stage belongs to the chain
 * itself here, and the chained-stage spelling works in every container a `$$` chain
 * reaches — the `$$ =` stream, a `$facet` branch, an `$out` right-hand side — so one
 * sentence stays accurate in all of them.
 */
export const STREAM_STAGE_REWRITE: StageRewrite = "chain them as stage calls instead — `$$.$match({ … }).$sort({ … })`";

type CallbackOpts = {
  /** The method whose callback this is, for the message (`filter`, `map`, …). */
  method: string;
  /** Position-accurate rewrite — `aggregateRewrite(...)` or `STREAM_STAGE_REWRITE`. */
  rewrite: StageRewrite;
};

/**
 * Reject a pipeline stage inside a JavaScript/lodash callback's block body. A no-op
 * for an expression body, an `ExprBlock`, and a block that holds only `const`/`let`
 * declarations.
 */
export function requireStageFreeCallback(lambda: Lambda, opts: CallbackOpts): void {
  if (lambda.block === undefined) return;
  const stage = lambda.block.stmts.find((s) => s.type !== "LetDecl");
  if (stage === undefined) return;
  const param = lambda.params[0] ?? "o";
  throw new CodegenError(
    `\`.${opts.method}(${param} => { … })\` takes a JavaScript callback, so its block body holds \`const\`/\`let\` ` +
      `bindings and one \`return <expr>\`. ${describeStmt(stage)} is a pipeline stage, not part of a callback — ` +
      `${opts.rewrite}.`,
    stage.pos,
  );
}

/**
 * Normalise a JavaScript callback's block body to the value form the lowering
 * consumes, so `{ return E }` means exactly what `=> E` means and a block never
 * loses the expression it returns:
 *
 *   - `{ return E }`                → an expression-body lambda (`body: E`)
 *   - `{ const a = …; return E }`   → an `ExprBlock` lambda (→ nested `$let`)
 *   - a block holding a stage       → rejected (`requireStageFreeCallback`)
 *   - a block with no `return`      → rejected; it yields no value to use
 *
 * Callers that own their own `return` handling (the stream `.map`, whose `return` is
 * a document reshape) call `requireStageFreeCallback` directly instead.
 */
export function callbackBlockToValue(lambda: Lambda, opts: CallbackOpts): Lambda {
  requireStageFreeCallback(lambda, opts);
  const block = lambda.block;
  if (block === undefined) return lambda;
  const param = lambda.params[0] ?? "o";
  if (lambda.ret === undefined) {
    throw new CodegenError(
      `\`.${opts.method}(${param} => { … })\` must end with \`return <expr>\` — a block body that returns nothing ` +
        `has no value to use. Write \`.${opts.method}(${param} => <expr>)\`, or \`{ const a = …; return <expr>; }\` ` +
        `to bind first.`,
      block.pos,
    );
  }
  return tryCallbackBlockToValue(lambda);
}

/**
 * The non-throwing half of `callbackBlockToValue`: the value form when the block is
 * stage-free and returns, the lambda unchanged otherwise. For *detection* sites that
 * must stay side-effect-free (`detectLookupCall`) — the matching validator owns the
 * message, so nothing is swallowed here, only deferred.
 */
export function tryCallbackBlockToValue(lambda: Lambda): Lambda {
  const block = lambda.block;
  if (block === undefined || lambda.ret === undefined) return lambda;
  if (!block.stmts.every((s) => s.type === "LetDecl")) return lambda;
  if (block.stmts.length === 0) {
    return { type: "Lambda", params: lambda.params, body: lambda.ret, pos: lambda.pos };
  }
  return {
    type: "Lambda",
    params: lambda.params,
    exprBlock: { type: "ExprBlock", decls: block.stmts as LetDecl[], ret: lambda.ret, pos: block.pos },
    pos: lambda.pos,
  };
}

/** Name the offending statement the way the developer wrote it. */
function describeStmt(stmt: PipelineStmt): string {
  if (stmt.type === "FuncDecl") return `\`function ${stmt.name}(…) { … }\``;
  if (stmt.type === "UpdateFilter") {
    const op = stmt.ops[0];
    const target = op === undefined ? undefined : fieldPath(op.target);
    if (op !== undefined && op.type === "DeleteStmt") {
      return target === undefined ? "`delete`" : `\`delete $.${target}\``;
    }
    return target === undefined ? "an assignment" : `\`$.${target} = …\``;
  }
  if (stmt.type === "OperatorCall") return `\`${stmt.name}(...)\``;
  // `assert(...)`, `$$.push(...)`, `$$.indexStats()` — statement-position sugar that
  // reaches the same block grammar as a stage call.
  if (stmt.type === "CallExpression" && stmt.callee.type === "ParamRef") return `\`${stmt.callee.name}(...)\``;
  if (stmt.type === "MethodCall") return `\`.${stmt.method}(...)\``;
  return "that statement";
}

/** The dotted path of an assignment / delete target, when it is a plain field ref. */
function fieldPath(target: Expr): string | undefined {
  return target.type === "FieldRef" ? target.path : undefined;
}
