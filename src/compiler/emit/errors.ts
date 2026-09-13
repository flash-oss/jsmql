// Phase 5 — EMIT. Every message the emit phase can produce, worded once.
//
// A refusal is either a row's own text (`unsupported(…)`, handed on through
// `refusalSentence`) or one of the shapes below, each built from what the row
// states — a signature, a receiver list, a position. No sentence here says
// something a row could have carried.

import { CodegenError, UnknownIdentifierError, internalError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import type { Arity, Position, SlotForm } from "../../registry/vocabulary.ts";
import { TYPEOF_HINTS } from "../../registry/vocabulary.ts";
import { refusalSentence } from "./consult.ts";
import type { Selected } from "./select.ts";
import { callbackParamsOf, diagnosticOf, isFieldProperty, spreadAlternativeOf, stageBodyRuleOf } from "../rows.ts";

export { CodegenError, UnknownIdentifierError };

/** The argument signature as a message spells it: `.slice(start[, end])`. */
const signature = (spelled: string, args: Arity): string => `${spelled}(${args.sig})`;

/**
 * Where a stage runs, as the reference that spells it. Two words name the same
 * place — the receiver family a stage accepts (`stream`) and the scope a
 * diagnostic stage states (`collection`) — so both are keys here.
 */
const RUNS_ON: Readonly<Record<string, { sigil: string; place: string } | undefined>> = {
  stream: { sigil: "$$", place: "the collection reference, run on 'db.coll.aggregate()'" },
  collection: { sigil: "$$", place: "the collection reference, run on 'db.coll.aggregate()'" },
  cluster: { sigil: "$$$$", place: "the cluster reference, run on the admin database" },
};

/** The stage name without its `$`: `$indexStats` → `indexStats`, the spelling that takes no body. */
const sugarOf = (name: string): string => (name.startsWith("$") ? name.slice(1) : name);

/** Where a diagnostic stage runs, from either spelling — `indexStats` or `$indexStats`. */
const runsOnFor = (name: string): { sigil: string; place: string } | undefined =>
  RUNS_ON[(diagnosticOf(name) ?? diagnosticOf(`$${name}`))?.scope ?? ""];

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
 * The sentence for a name whose row has no cell for the position — the position's
 * own reason, in the words the rows use for it, so a name a row never mentions in
 * that position is refused like one that does. The name arrives quoted.
 */
const NO_CELL: Readonly<Record<Position, (quoted: string, bare: string) => string>> = {
  value: (q) => `${q} has no value form here — see its 'where'.`,
  filter: (q, b) => `${q} is a value, not a test. Compare it: '$.<field> === ${b}'.`,
  stream: (q) => `${q} produces a value, not a stream of documents.`,
  statement: (q, b) => `${q} computes a value, and a statement writes one. Assign it to a field: '$.<field> = ${b};'`,
  group: (q) => `${q} is not an accumulator. Inside '$group' write the MongoDB operator.`,
  window: (q) => `${q} is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
  updateDoc: (q, b) =>
    `${q} is computed on the server, and a document-form update takes constants. Use the pipeline form ('jsmql.pipeline("$.<field> = ${b}…;")'), which 'updateOne' accepts as well, or pass the value from your code.`,
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
  // Callers spell the name as the source did — `.trim`, `'.find()'`, `Math.max` —
  // and a sentence that adds its own quotes or parentheses starts from the bare name.
  const bare = spelled.replace(/^'(.*)'$/, "$1").replace(/\(\)$/, "");
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
    case "unknown":
      return new CodegenError(
        `Unknown ${container === "" ? "name" : "method"} '${spelled}${container === "" ? "" : "()"}' at position ${pos}.${didYouMean(sel.name, near, format)}`,
        pos,
      );
    case "wrongReceiver": {
      const accepts = sel.accepts === "any" ? "any receiver" : sel.accepts.map((f) => `'${f}'`).join(", ");
      const got = sel.got === null ? "a receiver whose type jsmql cannot prove" : `a '${sel.got}'`;
      // The way from what the value IS to what the method takes, when there is one.
      const takesString = sel.accepts !== "any" && sel.accepts.includes("string");
      // A stage runs on ONE context reference. Name that spelling, not the value hints below.
      const oneRef =
        position === "statement" && sel.accepts !== "any" && sel.accepts.length === 1
          ? RUNS_ON[sel.accepts[0]]
          : undefined;
      const hint =
        oneRef !== undefined
          ? ` Write '${oneRef.sigil}${bare}()' — ${oneRef.place}.`
          : sel.got === "array" && sel.accepts !== "any" && !sel.accepts.includes("array")
            ? ` Map over the array first — '.map(x => x${bare}(…))' — or take one element ('[0]').`
            : sel.got === "date" && takesString
              ? ` Render the date as a string first: '.format("%Y-%m-%d")' or '.toISOString()'.`
              : sel.got === "number" && takesString
                ? ` Render the number as a string first: '.toString()'.`
                : sel.got === "stream" && sel.accepts !== "any" && !sel.accepts.includes("stream")
                  ? ` A stream is not an array: chain a method the stream has ('$$.filter(…)', '$$.orderBy(…)'), or call this one on an array the document carries ('$.<field>.<method>()').`
                  : sel.got === "object" && sel.accepts !== "any" && sel.accepts.includes("array")
                    ? ` A document is not a list: read one of its fields ('.<field>'), or drop the terminal that takes a single document to keep the array.`
                    : sel.got === "bool"
                      ? ` A boolean has no methods; use it as a condition ('cond ? a : b').`
                      : "";
      // a property (`.length`) is spelled without the call parentheses
      const shown = isFieldProperty(sel.name) ? `'${bare}'` : `'${bare}()'`;
      return new CodegenError(`${shown} is not available on ${got} — it is defined on ${accepts}.${hint}`, pos);
    }
    case "wrongCount": {
      // `.map(f, thisArg)`: JavaScript's trailing `thisArg` has no meaning here, and the count alone would not say why
      const most = sel.args.exact ?? (sel.args.allowed === undefined ? undefined : Math.max(...sel.args.allowed));
      const thisArg =
        callbackParamsOf(sel.name, position) !== undefined && most !== undefined && sel.got === most + 1
          ? " — JavaScript's trailing 'thisArg' has no meaning in MQL; drop it"
          : "";
      return new CodegenError(`'${signature(bare, sel.args)}' ${countWord(sel.args)}, got ${sel.got}${thisArg}`, pos);
    }
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
      return new CodegenError(NO_CELL[position](spelled.startsWith("'") ? spelled : `'${spelled}'`, bare), pos);
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

/**
 * A declared function read as a VALUE. MQL expressions carry no function value,
 * so the way out is the explicit lambda that calls it. The tracking id stays in
 * this comment and out of the message: a developer reading the error has no use
 * for it. [DEF-032]
 */
export const functionAsValue = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is a reusable function, and a function is not a value MQL can carry. Call it — '${name}(x)' — or, to hand it to a higher-order method, write the lambda that calls it: '.map((x) => ${name}(x))'.`,
    pos,
  );

/** A read of a name that has no value here; the binding says why, worded where it was dropped. */
export const droppedBinding = (ref: { readonly message: string }, pos: number): CodegenError =>
  new CodegenError(ref.message, pos);

/** The wording a document-replacing stage leaves on every binding it took away. */
export const afterReplace =
  (by: string) =>
  (name: string, mutable: boolean): string =>
    mutable
      ? `\`${name}\` is a \`let\` binding and can't be read after \`${by}\` — that stage replaced the document that carried it. Assign it again after the stage (\`${name} = …\`), or carry the value as a field of the new document.`
      : `\`${name}\` is a \`const\` binding and can't be read after \`${by}\` — that stage replaced the document that carried it. Carry the value as a field of the new document, or declare it with \`let\` and assign it again after the stage.`;

/** A callback parameter the stream cannot fill — the index, the collection. */
export const unfilledParam = (name: string, method: string, why: string): string =>
  `\`${name}\` has no value inside \`.${method}()\` — ${why}`;

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

/**
 * `$ = <array>` — the root takes ONE document, and the stream is what takes an array.
 * The destination has to say which: `$` is the document, `$$` is the stream.
 */
export const rootIsArray = (pos: number): CodegenError =>
  new CodegenError(
    "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    pos,
  );

/** A read of another collection where there is no pipeline to place its `$lookup` in. */
export const joinNeedsPipeline = (pos: number): CodegenError =>
  new CodegenError(
    "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline (e.g. `({ $ }) => { $.n = $$$.<coll>.filter(…).length; }`); it has no meaning in a Filter or in 'jsmql.expr'.",
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

/** A bracketed stage list where a value belongs. `near` are the stage names, for the suggestion. */
export const stageListAsValue = (pos: number): CodegenError =>
  new CodegenError(
    "A bracketed stage list is a pipeline, not an expression. Pass it to jsmql.pipeline(…), or write the stages as statements ('$match(…); $sort(…);').",
    pos,
  );

export const unknownStage = (index: number, name: string, stages: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `Element ${index} of pipeline: '${name}' is not a known aggregation stage.${didYouMean(name, stages, (s) => s)}`,
    pos,
  );

export const multiKeyStage = (index: number, keys: number, pos: number): CodegenError =>
  new CodegenError(
    `Element ${index} of pipeline must be a single-key stage object (e.g. \`{ $match: ... }\`), but found an object with ${keys} keys.`,
    pos,
  );

/** A computed expression in a raw query document's value slot. */
export const expressionInQueryValue = (pos: number): CodegenError =>
  new CodegenError(
    "The value of a key in a query document is a VALUE or a query operator, and this is a computed expression. The query language reads it as a value to compare against: measured, '{ a: $.b > 1 }' becomes '{ a: { $gt: [\"$b\", 1] } }', which the server accepts and matches nothing. Write the predicate itself ('$.a > 1', or '$match($.a > 1)'), or put the expression in '$expr'.",
    pos,
  );

/** An aggregation operator in a query document, where the server knows no such operator. */
export const aggregationOperatorInQuery = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is an aggregation operator, and a query document has no such operator — the server answers "unknown operator: ${name}". Put it in '$expr' ('$expr($eq(${name}(…), …))'), or use the query operator that says the same thing.`,
    pos,
  );

/** A query-only operator written inside a `.some(…)` body, where the server refuses it. */
export const queryOnlyInsideElement = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' applies to the top-level document only — the server refuses it inside an array element test. Move it out of the '.some(…)' body: '$.items.some(…) && ${name}(…)'.`,
    pos,
  );

// ── the statement target ─────────────────────────────────────────────────────

/** `.join()` / `.toString()` on a receiver that provably holds arrays: the server refuses to stringify an element that is an array. */
export const arrayOfArrays = (method: string, holder: string, pos: number): CodegenError =>
  new CodegenError(
    `.${method}() can't stringify an array of arrays — ${holder} holds arrays, and the server refuses to stringify an array element. Flatten first ('.flat().join()'), or map each inner array to a string ('.map(a => a.join(",")).join()').`,
    pos,
  );

/**
 * The callback's third parameter, in a body whose stages make its count untrue. The
 * count is stamped into a field ahead of the body, so a stage that drops the fields
 * loses it and a stage that changes the document count makes it stale — and a test on
 * either silently answers on the wrong number.
 */
export const streamHandleAfterReplace = (name: string, stage: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is the body's own stream, and this body runs '${stage}', which changes what its count means — '${name}.length' is stamped into a field ahead of the body, and that stage either drops the field or changes how many documents there are. Only a stage that leaves both alone keeps the count true. Take the count in a statement ahead of this chain, or drop '${name}' from the parameter list.`,
    pos,
  );

/** The callback's third parameter — the body's own stream — read as a value. */
export const streamHandleAsValue = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is the body's own stream, the callback's third parameter: read its count ('${name}.length') or chain on it ('${name}.filter(…)'). It is not a document or a value on its own.`,
    pos,
  );

/** A context reference alone — `$$`, `$$$`, `$$$$` — where a statement must stand. */
export const bareContextRef = (ref: string, pos: number): CodegenError => {
  const what =
    ref === "$$"
      ? "'$$' is the stream — chain what to do with it: '$$.filter(…);', '$$.push({ … });', '$$ = $$.take(10);'"
      : ref === "$$$"
        ? "'$$$' is the current database — name a collection after it: '$.o = $$$.<coll>.find(…);' reads one, '$$$.<coll> = $$;' writes one"
        : "'$$$$' is the cluster — name a database and a collection after it: '$$$$.<db>.<coll> = $$;' writes one; '$$$$.currentOp();' is a source stage";
  return new CodegenError(`${what}. Alone it is not a statement.`, pos);
};

/** An expression standing where a statement must: it computes a value and writes nothing. */
export const notAStatement = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline statement writes something: a field ('$.total = …;'), the document ('$ = { … };'), a deletion ('delete $.x;'), or a stage ('$match(…);'). This expression only computes a value — assign it to a field, or wrap a predicate as '$match(…)'.",
    pos,
  );

/** A name that is not a stage, standing as a statement. */
export const notAStage = (name: string, stages: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is not an aggregation stage, so it cannot stand as a statement.${didYouMean(name, stages, (s) => s)}`,
    pos,
  );

/** A raw stage document with more than one key: which stage would it be? */
export const multiKeyStageDocument = (name: string, keys: number, pos: number): CodegenError =>
  new CodegenError(
    `A raw stage document holds exactly one stage, and this one holds ${keys} keys. Write '{ ${name}: … }' on its own, and the next stage as its own statement.`,
    pos,
  );

/**
 * `$ = 5` — a root replacement whose value cannot BE a document. Measured: the
 * server refuses `{ $replaceWith: 5 }`, `"x"`, `[1, 2]` and `null` alike
 * ("'replacement document' must evaluate to an object"), and accepts a field path
 * because only the run can tell what it holds.
 */
export const rootMustBeDocument = (noun: string, pos: number): CodegenError =>
  new CodegenError(
    `'$ = …' replaces the document, so the value has to BE a document — ${noun} is not one. Put it under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').`,
    pos,
  );

/** `delete $` — the root is not a field, and a pipeline that drops the document has no shape. */
export const cannotDeleteRoot = (pos: number): CodegenError =>
  new CodegenError(
    "'delete $' would delete the document itself. To replace it, write '$ = { … };'; to drop every field but one, write '$ = { keep: $.keep };'.",
    pos,
  );

/** A write whose destination is not a field path. */
export const notAWriteTarget = (pos: number): CodegenError =>
  new CodegenError(
    "A write names a field: '$.total = …', '$.a.b = …', or the document itself, '$ = { … }'. A computed destination ('$[expr] = …') has no field name at compile time — use '$setField({ field: <expr>, input: $, value: … })' when the name is a value.",
    pos,
  );

/** A stage body, or one key of it, that must be a bracketed list of stages. */
export const needsStageList = (slot: { stage: string; key: string } | null, pos: number): CodegenError => {
  if (slot === null) {
    return new CodegenError(
      "This stage's body is a sub-pipeline: write it as a bracketed list of stages, '[$match(…), $sort(…)]'.",
      pos,
    );
  }
  const words = stageBodyRuleOf(slot.stage)?.enums?.[slot.key];
  return new CodegenError(
    words === undefined
      ? `'${slot.stage}' ${slot.key} is a sub-pipeline: write it as a bracketed list of stages, '${slot.key}: [$match(…), $sort(…)]'.`
      : `'${slot.stage}' ${slot.key} is a bracketed list of stages, '${slot.key}: [$set({ … })]', or one of: ${words.join(", ")}.`,
    pos,
  );
};

/** A spread inside a stage list: the pipeline is written out, stage by stage. */
export const spreadInStageList = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline is written out stage by stage; '...' cannot spread stages into it. List each stage.",
    pos,
  );

/** A name the server accepts only in the pipeline's first stage, written after something else. */
export const mustBeFirstStage = (name: string, pos: number, why?: string): CodegenError =>
  new CodegenError(
    why ??
      `'${name}' produces the pipeline's source documents, so it has to be the FIRST stage — the server refuses it anywhere else. Move it to the top of the program.`,
    pos,
  );

/** Two stages that each have to be last. */
export const twoTerminalStages = (name: string, already: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' writes the pipeline's output and has to be its last stage, and '${already}' already is. A pipeline writes to one destination — keep one of them.`,
    pos,
  );

/** A source that is a value, handed to the pipeline entry. */
export const notAPipeline = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline is one or more statements: `;`-separated ('$match(…); $sort({…});') or a bracketed list of stages ('[$match(…), $sort({…})]'). This source is a single expression — pass it to jsmql() for a filter, or jsmql.expr() for an aggregation expression.",
    pos,
  );

/** A program whose statements produce no stages at all. */
export const noStages = (pos: number): CodegenError =>
  new CodegenError(
    "This program produces no stages, so it would leave the documents untouched. Write at least one statement that reads or changes them.",
    pos,
  );

/** `[..."abc"]` — JavaScript spreads a string into characters; MongoDB has no such operator. */
export const spreadOfString = (pos: number): CodegenError =>
  new CodegenError(
    "'...' spreads a string into its characters in JavaScript, and MongoDB has no operator that does — '$concatArrays' takes arrays only. For one character per element write '$range(0, <string>.length).map(i => <string>.charAt(i))'; to keep the string whole, drop the '...'.",
    pos,
  );

/** A statement after the stage that writes the pipeline's output. */
export const afterTerminalStage = (already: string, pos: number): CodegenError =>
  new CodegenError(
    `Nothing can follow '${already}': it writes the pipeline's output and the server requires it last. Move this statement above it.`,
    pos,
  );

/** A name written inside a container its row forbids — the stage itself, or one its body holds. */
export const forbiddenInContainer = (name: string, container: string, pos: number, instead?: string): CodegenError =>
  new CodegenError(
    `'${name}' cannot stand inside '${container}' — the server refuses it in that body. ${instead ?? "Run it as a stage of the outer pipeline instead."}`,
    pos,
  );

/**
 * A sugar whose stage the container bans at any depth. `forbiddenInContainer` is the
 * DIRECT reading, for a stage the source wrote; this one is for a stage the source
 * never named, so the message leads with what WAS written.
 */
export const bannedNested = (spelled: string, stage: string, container: string, instead: string, pos: number) =>
  new CodegenError(
    `'${spelled}' makes a '${stage}' stage, and the server refuses that anywhere inside a '${container}' — however deeply it is nested. ${instead}`,
    pos,
  );

/** `typeof x === "boolean"` — a spelling that is not one of MongoDB's type names. */
export const notAMongoType = (spelling: string, aliases: readonly string[], pos: number): CodegenError => {
  const hint = TYPEOF_HINTS[spelling];
  const suggestion = hint !== undefined ? ` Did you mean '${hint}'?` : didYouMean(spelling, aliases, (s) => s);
  return new CodegenError(
    `'typeof' compares against one of MongoDB's type names, and "${spelling}" is not one.${suggestion} For absence, write 'x === undefined'.`,
    pos,
  );
};

// ── the stream road ──────────────────────────────────────────────────────────

/**
 * A write to a callback's own STREAM parameter. `.push`/`.sort` and friends desugar
 * to `x = …` on the receiver, so every mutator spelling lands here as an assignment
 * and the message names the chain links that do the same job.
 */
export const writeToOwnStream = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is the body's own stream, and a stream is not a value a statement writes to. Append documents with '.concat(…)' ('${name}.concat([{ … }]);'), keep some with '.filter(…)', or run a stage on it ('${name}.$match(…);').`,
    pos,
  );

/** `$$ = <array whose elements the registry proves are not documents>`. */
export const streamElementsNotDocuments = (noun: string, written: string, pos: number): CodegenError =>
  new CodegenError(
    `'${written}' makes documents from the array's ELEMENTS, one each, and these elements are ${noun}. Put each under a field — '<array>.map((v) => ({ value: v }))' — or write to a field of the document you have ('$.<field> = <array>;').`,
    pos,
  );

/** `$$ = <something that is neither a chain on the stream nor a list of documents>`. */
export const notAStreamChain = (
  pos: number,
  noun?: string,
  lead = "'$$ = …' replaces the STREAM, so the right side has to be MANY documents",
  how = "Write a chain that starts from '$$' ('$$ = $$.filter(d => d.x > 1).take(10);'), a list of documents ('$$ = [{ a: 1 }, { a: 2 }];'), or an array whose elements are the documents ('$$ = $.items;').",
): CodegenError => new CodegenError(`${lead}${noun === undefined ? "" : ` — ${noun} is one value`}. ${how}`, pos);

/** A link in a stream chain whose name is not a method the stream has, nor a stage. */
export const notAStreamLink = (name: string, candidates: readonly string[], pos: number): CodegenError => {
  // A diagnostic stage is spelled on its own reference and takes no body there,
  // so the suggestion names that form, not the `.$name(body)` link form.
  const spell = (s: string): string => {
    const runsOn = runsOnFor(s);
    return runsOn === undefined ? `.${s}()` : `${runsOn.sigil}.${sugarOf(s)}()`;
  };
  return new CodegenError(
    `'.${name}()' is not a method of the stream '$$'.${didYouMean(name, candidates, spell)} A stage is a link too: '$$.$match(…)'.`,
    pos,
  );
};

/** One accepted spelling, with the shortest example of it. */
const SPELLING: Readonly<Record<SlotForm, string>> = {
  propertyPath: `a field name ('"status"')`,
  matchesObject: `a matcher object ('{ status: "paid" }')`,
  matchesPropertyPair: `a '[field, value]' pair ('["status", "paid"]')`,
  bareCallable: "a callable ('Boolean')",
  omitted: "no argument at all",
};

/** Every spelling the slot takes, the arrow first, as one English list. */
const spellings = (forms: readonly SlotForm[]): string => {
  const all = ["an arrow ('d => …')", ...forms.map((f) => SPELLING[f])];
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(", ")}, or ${all[all.length - 1]}`;
};

/** What the developer wrote instead, named as they would name it. */
const ARG_NOUN: Readonly<Record<string, string>> = {
  NumberLiteral: "a number",
  StringLiteral: "a string",
  BooleanLiteral: "a boolean",
  NullLiteral: "null",
  ObjectLiteral: "an object",
  ArrayLiteral: "an array",
};

/**
 * A stage cell asked for a callback and got a shape this slot never takes. The
 * spellings come from the row, so the way out is the one the compiler accepts.
 */
export const notAnArrow = (
  name: string,
  what: string,
  forms: readonly SlotForm[],
  got: { type: string; pos: number },
): CodegenError =>
  new CodegenError(
    `'.${name}()' takes ${what} here — ${spellings(forms)}. Got ${
      got.type === "Ident" ? `the name '${(got as { name?: string }).name}'` : (ARG_NOUN[got.type] ?? "something else")
    }.`,
    got.pos,
  );

/** `.filter({})` — a matcher object that names no field to match. */
export const emptyMatcherObject = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}({ … })' matches a document by its fields, and '{}' names none. Write the field to match — '.${name}({ status: "paid" })' — or an arrow — '.${name}(d => d.status === "paid")'.`,
    pos,
  );

/** `.filter([1, 2])` — the `[field, value]` pair, malformed. */
export const badMatchesPropertyPair = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}([field, value])' matches one field against one value. It takes exactly two elements, and the first is a field-name string: '.${name}(["status", "paid"])'. An arrow says the same thing: '.${name}(d => d.status === "paid")'.`,
    pos,
  );

/** An arrow with a `{ … }` body of stages where a VALUE body was wanted. */
export const blockWhereValueExpected = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' takes an arrow that returns a value — 'd => d.x', or 'd => { …; return d.x; }'. A body of pipeline stages belongs to '.aggregate(o => { … })'.`,
    pos,
  );

/** An arrow with a value body where a block of STAGES was wanted. */
export const valueWhereBlockExpected = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' takes an arrow whose body is a block of stages — 'o => { $match(…); $limit(1); }' — or a bracketed list of them.`,
    pos,
  );

/** `$$?.filter(…)` — the stream is never null, so the `?.` says nothing true. */
export const optionalOnStream = (pos: number): CodegenError =>
  new CodegenError(
    "'$$' is the stream of documents and is never null, so '?.' has nothing to guard. Write '$$.' instead.",
    pos,
  );

/** `.map(d => 5)` — the server refuses every non-document root. */
export const mapMustReturnDocument = (name: string, kind: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}(d => …)' replaces each document with what the arrow returns, so it has to return a document — ${kind === "null" ? "null" : `a ${kind}`} is not one. Return '({ value: … })' to keep it under a field.`,
    pos,
  );

/** `.flatMap(d => 5)` — an unwind names a field of the document. */
export const notAFieldOfTheDocument = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}(d => …)' names the ARRAY FIELD to flatten: 'd => d.items'. It lowers to '$unwind', which takes a field path and nothing else.`,
    pos,
  );

// ── bindings ─────────────────────────────────────────────────────────────────

/** `let x = …; $$.aggregate(o => { let x = …; })` — the block runs on the same documents. */
export const shadowsOuterBinding = (kind: string, name: string, pos: number): CodegenError =>
  new CodegenError(
    `\`${kind} ${name}\` shadows the \`${name}\` declared outside this block, and both would live in the same document. Pick a different name, or assign the outer one (\`${name} = …\`).`,
    pos,
  );

/** A read of the outer document inside a body whose stage has no `let` — `$unionWith`. */
export const noCorrelationSlot = (stage: string, pos: number): CodegenError =>
  new CodegenError(
    `'${stage}' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.`,
    pos,
  );

/** `$$$$.<db>.<coll>.find(…)` — a `$lookup` reads the current database only. */
export const crossDatabaseRead = (pos: number): CodegenError =>
  new CodegenError(
    "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    pos,
  );

/** `{ tags: { $all: [$.x] } }` — a query operator whose expression twin does not take `[field, operand]`. */
export const runtimeInQueryOperator = (op: string, pos: number): CodegenError =>
  new CodegenError(
    `'${op}' compares against a constant in a query document, and this operand is read at run time. Write the test as an expression — '$match($.field …)' — or give '${op}' a constant.`,
    pos,
  );

/** `$$.filter(…)` inside a body over another collection — the root stream is out of reach there. */
export const rootStreamInForeign = (pos: number): CodegenError =>
  new CodegenError(
    "'$$' is the root stream, and a body over another collection cannot reach it. Name the body's own stream through the callback's third parameter — '(o, _i, coll) => { coll.filter(…); }' — or write the stage: '$match(…)', '$sort(…)'.",
    pos,
  );

/** `$.k = $$.filter(…)` — a stream chain has no value; the root replace makes it a `$facet`. */
export const streamAsValue = (pos: number): CodegenError =>
  new CodegenError(
    "A chain on '$$' is a stream of documents, not a value. To branch the stream write '$ = { k: $$.filter(…), … }' (a '$facet'); for its size write '$$.length'; to keep the documents, chain them as a statement: '$$.filter(…);'.",
    pos,
  );

/** `$ = { k: $$.filter(…), other: 1 }` — every branch of a `$facet` is a stream. */
export const facetMixed = (key: string, pos: number): CodegenError =>
  new CodegenError(
    `'$ = { … }' with a '$$' chain is a '$facet', and every entry must be one: '${key}' is not a chain on '$$'. Make it one ('${key}: $$.filter(…)'), or move it out of the object.`,
    pos,
  );

/** A `$facet` branch name the server refuses: empty, dotted, or `$`-led. */
export const facetKey = (key: string, pos: number): CodegenError =>
  new CodegenError(
    `'${key}' cannot name a '$facet' branch — the server takes a plain field name: not empty, no '.', no leading '$'.`,
    pos,
  );

export const unionNeedsArgument = (pos: number): CodegenError =>
  new CodegenError(
    "Nothing to add to the stream: give a document ('$$.push({ … })'), another collection ('$$.push(...$$$.<coll>)'), or one of its documents ('$$.push($$$.<coll>.find(pred))').",
    pos,
  );

/** `$$$.c.concat();` — the collection write names no documents. */
export const mergeNeedsArgument = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `Nothing to write into the collection: give the stream ('$$$.<coll>.${name}($$);'), an array of documents ('$$$.<coll>.concat(<array>);' or '$$$.<coll>.push(...<array>);'), or one document ('$$$.<coll>.push({ … });').`,
    pos,
  );

/** `$ = { a: …, a: … }` — JavaScript keeps the last; two branches under one name is a lost branch. */
export const facetDuplicate = (key: string, pos: number): CodegenError =>
  new CodegenError(
    `'${key}' names two '$facet' branches, and JavaScript would keep only the last. Give each branch its own name.`,
    pos,
  );

export const facetSpread = (pos: number): CodegenError =>
  new CodegenError(
    "A '$facet' is written branch by branch; '...' cannot spread branches in. Name each one: '$ = { k: $$.filter(…) }'.",
    pos,
  );

export const facetComputedKey = (pos: number): CodegenError =>
  new CodegenError("A '$facet' branch is named when the pipeline is written: a plain key, not a computed one.", pos);

/** `$$$.currentOp()` — the database has no source stage of its own. */
export const noStageOnDatabase = (name: string, pos: number): CodegenError => {
  const sugar = sugarOf(name);
  const runsOn = runsOnFor(name);
  return new CodegenError(
    runsOn === undefined
      ? `'$$$' is the database, and no stage runs on it alone. Write '$$.${sugar}()' on the collection, or '$$$$.${sugar}()' on the cluster.`
      : `'$$$' is the database, and no stage runs on it alone. Write '${runsOn.sigil}.${sugar}()' — ${runsOn.place}.`,
    pos,
  );
};

// ── the reducer wrap ─────────────────────────────────────────────────────────

export const reduceWrapArity = (got: number, pos: number): CodegenError =>
  new CodegenError(
    `'$$.reduce(reducer, init)' takes the reducer and its initial value — 2 arguments, got ${got}.`,
    pos,
  );

export const reduceWrapCallback = (pos: number): CodegenError =>
  new CodegenError(
    "'$$.reduce(…)' takes a two-parameter arrow with an expression body: '(acc, d) => acc + d.total'.",
    pos,
  );

export const reduceWrapEntry = (pos: number): CodegenError =>
  new CodegenError(
    "In '$$ = [{ … }]' every entry is a plain key with a '$$.reduce(…)' — one fold per key; a spread or a computed key has no fold to name.",
    pos,
  );

export const reduceWrapShape = (acc: string, d: string, pos: number): CodegenError =>
  new CodegenError(
    `This reducer body spells no MongoDB accumulator. The shapes that do: '${acc} + ${d}.<field>' ($sum), '${acc} + 1' ($sum: 1), 'Math.max(${acc}, ${d}.<field>)' / 'Math.min(…)' ($max / $min), '${acc} ?? ${d}.<field>' ($first), '${d}.<field>' ($last), '[...${acc}, ${d}.<field>]' or '${acc}.concat(${d}.<field>)' ($push). For anything else write '$group({ … })'.`,
    pos,
  );

export const reduceWrapObjectBody = (acc: string, pos: number): CodegenError =>
  new CodegenError(
    `'$$ = [$$.reduce(…)]' folds to one document, so the reducer returns a document: '(${acc}, d) => ({ ...${acc}, total: ${acc}.total + d.amount })'. For one value write '$$ = [{ total: $$.reduce(…) }]'.`,
    pos,
  );

export const reduceWrapInit = (key: string, why: string, pos: number): CodegenError =>
  new CodegenError(
    `'${key}' is uneven between the reducer and its init — ${why}. Name every accumulator in both.`,
    pos,
  );

export const reduceWrapSeed = (pos: number): CodegenError =>
  new CodegenError(
    "The initial value of a stream fold is a constant — 0, [], null — because MongoDB's accumulators start empty and the seed is folded in afterwards; a field cannot seed them.",
    pos,
  );

export const reduceWrapKeyedNeedsSpread = (acc: string, pos: number): CodegenError =>
  new CodegenError(
    `A body that returns '{ [d.k]: d.v }' without '...${acc}' replaces the accumulator each step, so JavaScript keeps the LAST document only. To build one document keyed by a field write '({ ...${acc}, [d.k]: d.v })'.`,
    pos,
  );

export const reduceWrapKeyedInit = (pos: number): CodegenError =>
  new CodegenError("A fold keyed by a field — '({ ...acc, [d.k]: d.v })' — starts from '{}'.", pos);

export const reduceWrapMisplaced = (pos: number): CodegenError =>
  new CodegenError(
    "'$$.reduce(…)' folds the stream to one value, and a stream must stay documents: wrap it in one — '$$ = [{ total: $$.reduce((acc, d) => acc + d.total, 0) }]' — with nothing else in the list.",
    pos,
  );

/** `.map(5)` — an array callback is an arrow with an expression body. */
export const notAnArrowCallback = (name: string, pos: number): CodegenError =>
  new CodegenError(`'.${name}((x[, i[, arr]]) => …)' takes an arrow with an expression body.`, pos);

export const tooManyCallbackParams = (name: string, got: number, pos: number): CodegenError =>
  new CodegenError(`'.${name}()' callbacks take at most 3 parameters (element, index, array); got ${got}.`, pos);

/** `.mapValues(5)` — an object iteratee is a one- or two-parameter arrow. */
export const objIterateeShape = (name: string, pos: number): CodegenError =>
  new CodegenError(`'.${name}((value[, key]) => …)' takes a one- or two-parameter arrow with an expression body.`, pos);

/** `$$.push(...$.items)` — only another collection spreads into the stream. */
export const unionSpreadSource = (pos: number): CodegenError =>
  new CodegenError(
    "The stream takes another collection ('...$$$.<coll>', '...$$$.<coll>.filter(pred)') or documents the program spells out ('$$.push({ … })', '$$.push(...[{ … }, { … }])'). An array the DATA decides cannot be appended: '$documents' takes a written list, and MEASURED the server refuses a field path there (\"an array is expected\"). To make the stream FROM such an array, write '$$ = <array>;'.",
    pos,
  );

/** `$$.push(...$$$.c.find(p))` — one document is not spread. */
export const unionSpreadOfOne = (pos: number): CodegenError =>
  new CodegenError(
    "'.find(pred)' gives ONE document, which JavaScript would not spread. Drop the '...' to push the match, or write '...$$$.<coll>.filter(pred)' to push every match.",
    pos,
  );

/** `$$.push($$$.c.filter(p))` — an array pushed whole would be one document. */
export const unionNeedsSpread = (pos: number): CodegenError =>
  new CodegenError(
    "'$$.push($$$.<coll>.filter(pred))' would push the whole array as one document. Spread it — '$$.push(...$$$.<coll>.filter(pred))' — to push every match, or write '.find(pred)' for the first one.",
    pos,
  );

/** `$$.push(5)` — a stream holds documents. */
export const unionArg = (kind: string, pos: number): CodegenError =>
  new CodegenError(
    `A stream holds documents, and this is a ${kind}. Push a document ('$$.push({ … })'), a written list of them ('$$.push(...[{ … }])'), or another collection ('$$.push(...$$$.<coll>)').`,
    pos,
  );

/** `$$$.c = $.x` — a collection is written from the stream. */
export const outNeedsStream = (pos: number): CodegenError =>
  new CodegenError(
    "A collection is written from the stream: '$$$.<coll> = $$' replaces it, '$$$.<coll> += $$' adds to it, and either takes more stages first ('… = $$.filter(…)'). To write an ARRAY of documents, name them: '$$$.<coll>.concat(<array>);' or '$$$.<coll>.push(...<array>);'.",
    pos,
  );

/** `$$$.c.push(5)` — one pushed value IS the document written. */
export const mergeNotADocument = (noun: string, pos: number): CodegenError =>
  new CodegenError(
    `'$$$.<coll>.push(<value>)' writes that value AS one document, and ${noun} is not a document. Spread a list of them ('$$$.<coll>.push(...<array>);'), or put the value under a field ('$$$.<coll>.push({ value: … });').`,
    pos,
  );

/** `$$$.c *= $$` — only `=` and `+=` write a collection. */
export const writeToCollectionOp = (op: string, pos: number): CodegenError =>
  new CodegenError(
    `A collection takes '=' or '+=', not '${op}': '$$$.<coll> = $$' REPLACES what the collection holds (a '$out'), and '$$$.<coll> += $$' ADDS to it, updating the documents whose '_id' matches (a '$merge').`,
    pos,
  );

/** `$$$.c.concat($$, $$)` — one source per write. */
export const mergeOneSource = (name: string, count: number, pos: number): CodegenError =>
  new CodegenError(
    `'$$$.<coll>.${name}()' writes ONE source into the collection, and this names ${count}. Write them one statement at a time, or join them first ('$$$.<coll>.${name}([...a, ...b]);').`,
    pos,
  );

/** `$$$$.db = $$` — a database is not a destination. */
export const outNeedsCollection = (pos: number): CodegenError =>
  new CodegenError(
    "'$$$$.<db>' names a database; write the collection too: '$$$$.<db>.<coll> = $$' — or '$$$.<coll> = $$' for the current database.",
    pos,
  );

/** `$$$.a.b = $$` — one segment names a collection of the current database. */
export const outTooManySegments = (pos: number): CodegenError =>
  new CodegenError(
    "Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$').",
    pos,
  );

/** `$$$[""] = $$` / `$$$["$x"] = $$` — a name the server refuses. */
export const badOutTarget = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' cannot name a collection to write: the server refuses an empty name and one that starts with '$'.`,
    pos,
  );

/** `$$$[$.name].find(…)` — the collection a `$lookup` reads is fixed when the pipeline is written. */
export const collectionNameMustBeConstant = (pos: number): CodegenError =>
  new CodegenError(
    "The collection is named when the pipeline is written: '$$$.<coll>' or '$$$[\"<coll>\"]'. To choose it at run time, build the pipeline with 'jsmql.compile' and pass the name in.",
    pos,
  );

export const emptyCollectionName = (pos: number): CodegenError =>
  new CodegenError("'$$$[\"\"]' names no collection — the server refuses an empty namespace.", pos);

export const collectionMissing = (pos: number): CodegenError =>
  new CodegenError("'$$$' is the database; name the collection to read: '$$$.<coll>.find(…)'.", pos);

export const notAJoinChain = (pos: number): CodegenError =>
  new CodegenError(
    "A read of another collection is a chain on '$$$.<coll>': '.find(pred)', '.filter(pred)', '.aggregate(o => { … })', a stream method or a stage link.",
    pos,
  );

/**
 * A DIAGNOSTIC stage written as a chain link — `$$.$indexStats({})`. It reports on
 * the deployment, so it is a SOURCE stage: it stands first and is spelled on the
 * reference its scope names, with no body.
 */
export const diagnosticIsNotALink = (name: string, pos: number): CodegenError => {
  const runsOn = runsOnFor(name);
  const sugar = sugarOf(name);
  return new CodegenError(
    `'${name}' reports on the deployment, so it is a source stage and not a chain link.${
      runsOn === undefined ? "" : ` Write '${runsOn.sigil}.${sugar}()' — ${runsOn.place}.`
    }`,
    pos,
  );
};

/**
 * `$$$$.currentOpp();` — a name called straight on the database or the cluster.
 * Only a diagnostic stage of that scope is spelled there, so an unknown one is a
 * misspelling; on the database, where none is, the message names both scopes.
 */
export const notAStageOnRef = (
  name: string,
  sigil: "$$$" | "$$$$",
  candidates: readonly string[],
  pos: number,
): CodegenError => {
  const where =
    sigil === "$$$$"
      ? "'$$$$' is the cluster, and only the stages that report on the deployment are spelled on it"
      : "'$$$' is the database, and no stage runs on it alone";
  const tail =
    sigil === "$$$$"
      ? didYouMean(name, candidates, (s) => `$$$$.${s}()`)
      : " A stage runs on the collection ('$$.<stage>()') or the cluster ('$$$$.<stage>()').";
  const read = ` To read a collection called '${name}', write '$.<field> = ${sigil}.${name}.find(…)'.`;
  return new CodegenError(`${where}. '.${name}()' is not one of them.${tail}${read}`, pos);
};

/** `$$$.c.filter(p);` — the documents read have nowhere to go. */
export const noDestination = (pos: number): CodegenError =>
  new CodegenError(
    "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    pos,
  );

/** `$ = $$$.c.filter(p)` — the new root must be ONE document. */
export const rootNeedsOneDocument = (pos: number): CodegenError =>
  new CodegenError(
    "The document can only become ONE document, and this chain gives an array. Write '$ = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '$.<field> = $$$.<coll>.…'.",
    pos,
  );

/** `$$ = $$$.c.find(p)` — one document is not a stream. */
export const oneDocumentInStream = (pos: number): CodegenError =>
  new CodegenError(
    "'.find(…)' gives ONE document, and the stream is many. Write '$$ = $$$.<coll>.filter(pred).take(1)' for a stream of the first match, or '$ = $$$.<coll>.find(pred)' to make each document the one it finds.",
    pos,
  );

/** `$$ = $$$.c.filter(p).length` — a value is not a stream. */
export const valueInStream = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….${name}()'.`,
    pos,
  );

/** `$.x = …` inside a body over another collection: the outer document is out of reach there. */
export const outerWriteInForeign = (pos: number): CodegenError =>
  new CodegenError(
    "The outer document can't be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'); write the outer field after the join.",
    pos,
  );

/** `const x = …; x = …;` — a constant is written once. */
export const constReassigned = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is a 'const' and cannot be assigned again. Declare it with 'let' to write it more than once.`,
    pos,
  );

/** `.reduce(5, 0)` — a reducer is a two- or three-parameter arrow. */
export const reducerShape = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}((acc, x[, i]) => …, seed)' takes a two- or three-parameter arrow with an expression body.`,
    pos,
  );

/** `.zipWith(b, x => x)` — the arrow takes one parameter per zipped array. */
export const elementsShape = (name: string, count: number, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' takes an arrow with one parameter per zipped array — ${count} here — and an expression body.`,
    pos,
  );

/** `$.s.trim().sort();` — a mutator statement writes a field or a binding, and this receiver is neither. */
export const mutatorNeedsField = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' changes its receiver in place, so as a statement it needs a field or a binding to write: '$.<field>.${name}(…);'. For a value, use its immutable form.`,
    pos,
  );

/** `$exists(1)` — a query operator's call form tests a FIELD. */
export const needsFieldPath = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}(field, …)' tests a field: its first argument is a field path ('$.a'), as in '${name}($.a, …)' or the document form '{ a: ${name}(…) }'.`,
    pos,
  );

/** `$all($.tags, $.other)` — a query operator compares against a constant. */
export const needsLiteral = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' compares against a compile-time constant in a query document, and this argument is read at run time. Give it a literal, or write the test as an expression ('$expr(…)').`,
    pos,
  );

/** `$elemMatch($.items, x => x.q > $.min)` — the element predicate must have a query form. */
export const elementNeedsQuery = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}(field, predicate)' takes a one-parameter arrow over the element whose body is a query test of the element alone ('x => x.q > 1'); a body that reads the outer document or computes a value has no query form here.`,
    pos,
  );

/** `$box([[0, 0], [1, 1]])` on its own — a fragment of another operator's operand. */
export const onlyInside = (name: string, hosts: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is a fragment of ${hosts.map((h) => `'${h}'`).join(" / ")} and has no meaning on its own — write it as that operator's operand: '${hosts[0]}(…, ${name}(…))'.`,
    pos,
  );

/** `$$.takeWhile(p)` with no sort before it — a MongoDB stream has no order until it is given one. */
export const needsPrecedingSort = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}(predicate)' keeps the ${name === "takeWhile" ? "LEADING" : "TRAILING"} run of the stream, and a MongoDB stream has no order until you give it one. Sort first, then '.${name}(…)': '$$.toSorted({ t: 1 }).${name}(o => o.ok)' — any sort spelling works ('.sort', '.toSorted', '.sortBy', '.orderBy', '.$sort({ … })').`,
    pos,
  );

// ── the update-document target ───────────────────────────────────────────────

/** `$set({ a: $.b })` in a document-form update — the server would store the string "$b". */
export const readInUpdateDocument = (pos: number): CodegenError =>
  new CodegenError(
    "A document-form update takes constants: the server reads '$b' there as the string, not the field. To compute from the document, use the pipeline form ('jsmql.pipeline(\"$.a = $.b + 1;\")'), which 'updateOne' accepts as well.",
    pos,
  );

export const updateCopyNeedsPipeline = (from: string, to: string, pos: number): CodegenError =>
  new CodegenError(
    `'$.${to} = $.${from}' copies a field, which a document-form update cannot do. To MOVE it, delete the source as well ('$.${to} = $.${from}; delete $.${from};' is a $rename); to copy it, use the pipeline form.`,
    pos,
  );

export const updateConflict = (path: string, held: string, op: string, pos: number): CodegenError =>
  new CodegenError(
    `'${path}' is written twice in one update ('${held}' and '${op}'), which the server refuses as a conflict. Write each field once.`,
    pos,
  );

export const updateHasNoDocumentForm = (what: string, pos: number): CodegenError =>
  new CodegenError(
    `${what} has no document-form update: an update document sets, increments, renames, unsets, or pushes and pops. Use the pipeline form for anything computed.`,
    pos,
  );

export const updateNeedsNumber = (op: string, what: string, pos: number): CodegenError =>
  new CodegenError(`'${op}' in a document-form update takes ${what} as a compile-time constant.`, pos);

export const updateKeyNotOperator = (key: string | null, pos: number): CodegenError =>
  new CodegenError(
    `An update document's keys are update operators ('$set', '$inc', …)${key === null ? "" : `, and '${key}' is not one`}. To set a field, write '$.${key ?? "field"} = …' or '{ $set: { ${key ?? "field"}: … } }'.`,
    pos,
  );

export const updateNeedsFields = (op: string, pos: number): CodegenError =>
  new CodegenError(`'${op}' takes a document of fields to write ('${op}({ field: value })').`, pos);

export const updateTargetNeedsField = (pos: number): CodegenError =>
  new CodegenError(
    "A document-form update writes a field of the document: '$.a = …', '$.a.b += 1', 'delete $.a'.",
    pos,
  );

export const notAnUpdate = (pos: number): CodegenError =>
  new CodegenError(
    "An update document is made of writes — '$.a = 1', '$.n += 2', 'delete $.b', '$.tags.push(x)' — or of update operators ('$inc({ n: 2 })', '{ $set: { a: 1 } }'). This is neither.",
    pos,
  );

/** `Math.abs` as a value — a function, not a number. */
export const unappliedReference = (ns: string, name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${ns}.${name}' is a function, not a value. Call it ('${ns}.${name}(…)'), or hand it to a callback slot ('.map(${ns}.${name})').`,
    pos,
  );

/** `$match({ loc: { $near: … } })` — the proximity operators query a `find()` alone. */
export const nearInMatch = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is not allowed inside an aggregation '$match' — the server refuses it there. Use the '$geoNear' stage as the first stage instead ('$geoNear({ near: …, distanceField: "d", spherical: true })'), or run the proximity query with 'find()'.`,
    pos,
  );

/** `$$.reduce(…, [])` whose body is not an append — a total, which the wrap form computes. */
export const arrayReduceShape = (pos: number): CodegenError =>
  new CodegenError(
    "'$$.reduce((acc, d) => …, [])' keeps documents by appending: write 'acc.concat(<doc>)' (or '[...acc, <doc>]') to reshape each document, and 'cond ? acc.concat(<doc>) : acc' to filter first. A total — a sum, a count, a maximum — is the wrap form: '$$ = [{ total: $$.reduce((acc, d) => acc + d.amount, 0) }]'.",
    pos,
  );
