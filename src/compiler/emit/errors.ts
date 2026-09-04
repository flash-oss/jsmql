// Phase 5 — EMIT. Every message the emit phase can produce, worded once.
//
// A refusal is either a row's own text (`unsupported(…)`, handed on through
// `refusalSentence`) or one of the shapes below, each built from what the row
// states — a signature, a receiver list, a position. No sentence here says
// something a row could have carried.

import { CodegenError, UnknownIdentifierError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import type { Arity, Position } from "../../registry/vocabulary.ts";
import { refusalSentence } from "./consult.ts";
import type { Selected } from "./select.ts";
import { spreadAlternativeOf } from "../rows.ts";

export { CodegenError, UnknownIdentifierError };

/**
 * A lowering the registry says still lives in the old compiler. Typed, so the
 * differential gate can tell a slice that has not reached a construct from one
 * that refuses it — and verify the claim against the row.
 */
export class PendingLowering extends CodegenError {
  readonly name_: string;
  readonly position: Position;
  readonly livesIn: string;
  constructor(name: string, position: Position, livesIn: string, pos: number) {
    super(`'${name}' in ${position} position is not lowered by src/compiler yet — it still lives in ${livesIn}.`, pos);
    this.name = "PendingLowering";
    this.name_ = name;
    this.position = position;
    this.livesIn = livesIn;
  }
}

/** The argument signature as a message spells it: `.slice(start[, end])`. */
const signature = (spelled: string, args: Arity): string => `${spelled}(${args.sig})`;

/** `[1,2]` → "1 or 2", `[0,1,2]` → "0, 1, or 2". */
const countList = (ns: readonly number[]): string =>
  ns.length === 2 ? `${ns[0]} or ${ns[1]}` : `${ns.slice(0, -1).join(", ")}, or ${ns[ns.length - 1]}`;

const countWord = (args: Arity): string => {
  if (args.none === true) return "takes no arguments";
  if (args.exact !== undefined) return `requires exactly ${args.exact} argument${args.exact === 1 ? "" : "s"}`;
  if (args.allowed !== undefined) return `requires ${countList(args.allowed)} arguments`;
  if (args.atLeast !== undefined) return `requires at least ${args.atLeast} argument${args.atLeast === 1 ? "" : "s"}`;
  return "takes a different number of arguments";
};

/**
 * The error for a final `Selected` answer that is not a rule. `spelled` is how
 * the SOURCE wrote the name — `'.trim()'`, `'$abs'`, `'Math.max'` — because one
 * row answers for every spelling and only the caller knows which it saw.
 */
export function refusalFor(
  sel: Selected,
  spelled: string,
  container: string,
  position: Position,
  pos: number,
  near: readonly string[],
  format: (candidate: string) => string = (s) => `.${s}()`,
): CodegenError {
  switch (sel.kind) {
    case "refused":
      return new CodegenError(
        refusalSentence(
          { kind: "refused", name: sel.name, position, message: sel.message, needsSubject: sel.needsSubject },
          spelled,
          container,
        ),
        pos,
      );
    case "pending":
      return new PendingLowering(sel.name, position, sel.livesIn, pos);
    case "unknown":
      return new CodegenError(
        `Unknown ${container === "" ? "name" : "method"} '${spelled}${container === "" ? "" : "()"}' at position ${pos}.${didYouMean(sel.name, near, format)}`,
        pos,
      );
    case "wrongReceiver": {
      const accepts = sel.accepts === "any" ? "any receiver" : sel.accepts.map((f) => `'${f}'`).join(", ");
      const got = sel.got === null ? "a receiver whose type jsmql cannot prove" : `a '${sel.got}'`;
      return new CodegenError(`'${spelled}()' is not available on ${got} — it is defined on ${accepts}.`, pos);
    }
    case "wrongCount":
      return new CodegenError(`${signature(spelled, sel.args)} ${countWord(sel.args)}, got ${sel.got}`, pos);
    case "rejectedCount":
      return new CodegenError(sel.message, pos);
    case "spreadRefused": {
      const alt = spreadAlternativeOf(sel.name);
      const fix =
        alt === undefined
          ? `pass operands directly (${spelled}(a, b)) or as a single array (${spelled}([a, b]))`
          : `${alt}, or pass a single array (${spelled}([a, b]))`;
      return new CodegenError(`Spread (...) is not supported in ${spelled}(...) — ${fix}.`, pos);
    }
    case "fallback":
      return new CodegenError(`${spelled} has no value form here — see its 'where'.`, pos);
    case "composedOnly":
      return new CodegenError(
        `${spelled} is only meaningful composed with ${sel.owners.map((o) => `'${o}'`).join(" or ")}.`,
        pos,
      );
    case "noCell":
      return new CodegenError(`${spelled} cannot stand in ${position} position.`, pos);
    case "rule":
    case "dispatch":
      return new CodegenError(
        `jsmql internal error (please report to the jsmql maintainers): refusalFor received a '${sel.kind}' answer for ${spelled}`,
        pos,
      );
  }
}

// ── the shapes no row can carry: a construct used where it has no value ───────

export const undefinedAsValue = (pos: number): CodegenError =>
  new CodegenError(
    `'undefined' is only meaningful in a comparison — 'x === undefined' / 'x !== undefined' test whether a field is present. As a value it has no MongoDB equivalent: use 'null' for the present-but-null case, or 'delete $.field' to remove a field.`,
    pos,
  );

export const regexAsValue = (pos: number): CodegenError =>
  new CodegenError(
    `Regex literals are only valid as arguments to .match(), .test(), .exec(), .matchAll(), and .search(). To pass a regex pattern as a string, use a string literal instead.`,
    pos,
  );

export const lambdaAsValue = (pos: number): CodegenError =>
  new CodegenError(
    "A function (=>) is only valid as the callback to an iterating array method (.map, .filter, .some, .every, .find, .reduce, …) or as the second argument to $let.",
    pos,
  );

/** A callable name read without being called — `Number + 1`, `Math.floor + 5`. */
export const callableAsValue = (spelled: string, pos: number): CodegenError =>
  new CodegenError(
    `'${spelled}' used as a value is only valid as a callback to a higher-order array method (e.g. $.items.map(${spelled})). To apply it to one value, write ${spelled}(value).`,
    pos,
  );

export const functionAsValue = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is a reusable function — call it with '${name}(...)'. A function can't be used as a value (passing it to another function isn't supported); inline the call instead.`,
    pos,
  );

export const droppedBinding = (name: string, by: string, fix: string, pos: number): CodegenError =>
  new CodegenError(`\`${name}\` is a \`let\` binding and can't be read after \`${by}\` — ${fix}`, pos);

export const statementInValue = (what: string, pos: number): CodegenError =>
  new CodegenError(
    `${what} is a statement, not a value. It is only valid at the top level or as a pipeline-array element.`,
    pos,
  );

export const negativeIndex = (index: number, pos: number): CodegenError =>
  new CodegenError(
    `Negative bracket index '[${index}]' isn't allowed — in JavaScript that reads a property named "${index}" (normally 'undefined'), not the element ${-index} from the end. Use '.at(${index})' to index from the end, which works on both arrays and strings.`,
    pos,
  );

export const looseEqualityNotNull = (op: "==" | "!=", pos: number): CodegenError =>
  new CodegenError(
    `'${op}' is only allowed against null in jsmql. Use '${op === "==" ? "===" : "!=="}' for JS-like strict equality (no surprising type coercion). To match "null or missing", write '$.x ${op} null'.`,
    pos,
  );

export const scalarInOperand = (pos: number): CodegenError =>
  new CodegenError(
    "Right-hand side of 'in' must be an array literal, object literal, or field reference, not a scalar value",
    pos,
  );

export const recursiveFunction = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `Recursive function calls aren't supported — a MongoDB expression can't call itself. '${name}' is invoked while it is still being expanded (direct or mutual recursion). Rewrite it without recursion.`,
    pos,
  );

export const wrongCallCount = (label: string, params: readonly string[], got: number, pos: number): CodegenError =>
  new CodegenError(
    `${label}: expected ${params.length} argument(s)${params.length ? ` for params (${params.join(", ")})` : ""}, got ${got}.`,
    pos,
  );

export const unknownFunction = (name: string, known: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `Unknown function '${name}(...)'.${didYouMean(name, known, (s) => `${s}(...)`)} Declare it first with \`const ${name} = (…) => …;\` at the top level of a pipeline; for a MongoDB operator write \`$${name}(...)\`; for a method, \`receiver.${name}(...)\`.`,
    pos,
  );

export const notCallable = (pos: number): CodegenError =>
  new CodegenError(
    `Direct call '(...)(args)' is only supported when the callee is an arrow function (IIFE → $let) or a declared function name. For named operators use $opName(...); for methods use receiver.method(...).`,
    pos,
  );

export const letParamsMustNameVars = (params: readonly string[], keys: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `$let's arrow parameters must name its variables: got (${params.join(", ")}) for vars { ${keys.join(", ")} }.`,
    pos,
  );

export const redeclared = (kind: string, name: string, pos: number): CodegenError =>
  new CodegenError(
    `\`${kind} ${name}\` is already declared earlier in this block — re-declaration in the same scope is not allowed; pick a different name.`,
    pos,
  );

/** A list-only operator handed one operand that is not an array literal. */
export const listOperand = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `${name} operates on a list of operands — pass two or more (${name}(a, b)) or a single array (${name}([a, b])).`,
    pos,
  );

/** A value that materialises a STAGE, read where there is no pipeline to place it in. */
export const needsPipeline = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'$$.${name}' (the current stream's document count) needs Pipeline mode — it materialises a '$setWindowFields' stage. Use it inside a pipeline (e.g. \`({ $ }) => { $.n = $$.${name}; … }\`); it has no meaning in a Filter or in 'jsmql.expr'.`,
    pos,
  );

export const spreadInOperatorBody = (pos: number): CodegenError =>
  new CodegenError("Spread elements in objects are not supported in MQL output", pos);

export const computedKeyInOperatorBody = (pos: number): CodegenError =>
  new CodegenError("Computed object keys are not allowed here — operator argument keys must be literal names", pos);

/** A spread handed to a lambda application — an IIFE or a declared function. */
export const spreadInCall = (label: string, pos: number): CodegenError =>
  new CodegenError(
    `${label}: spread arguments aren't supported — pass each argument explicitly, or use $op($let, ...) to build the bindings by hand.`,
    pos,
  );
