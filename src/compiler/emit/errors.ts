import { CodegenError, UnknownIdentifierError, internalError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import type { ArgType, Arity, Family, Kind, Position, SlotForm, Type } from "../../registry/vocabulary.ts";
import type { Expr } from "../../registry/vocabulary.ts";
import type { Where } from "../passes/position.ts";
import { stringify } from "../../stringify.ts";
import { isPlainObject, isRegExp } from "../../bson.ts";
import { TYPEOF_HINTS } from "../../registry/vocabulary.ts";
import { consult, refusalSentence } from "./consult.ts";
import { hint, takesOf, wrongKind } from "./check.ts";
import type { Selected } from "./select.ts";
import { kindOfValue, type KindFault, type Proven } from "../kinds.ts";
import { constantOf } from "../passes/evaluate.ts";
import type { Unreadable } from "./type.ts";
import {
  callbackParamsOf,
  diagnosticOf,
  familiesOf,
  isFieldProperty,
  isKnownName,
  isStageName,
  positionsOf,
  siblingOf,
  spreadAlternativeOf,
  streamReceiverNames,
  suggestedAs,
  valueMethodNames,
  valueTwinOf,
} from "../rows.ts";

export { CodegenError, UnknownIdentifierError };

const signature = (spelled: string, args: Arity): string => `${spelled}(${args.sig})`;

const RUNS_ON: Readonly<Record<string, { sigil: string; place: string } | undefined>> = {
  stream: { sigil: "$$", place: "the root stream, run on 'db.coll.aggregate()'" },
  collection: { sigil: "$$", place: "the root stream, run on 'db.coll.aggregate()'" },
  cluster: { sigil: "$$$$", place: "the cluster reference, run on the admin database" },
};

const sugarOf = (name: string): string => (name.startsWith("$") ? name.slice(1) : name);

const runsOnFor = (name: string): { sigil: string; place: string } | undefined =>
  RUNS_ON[(diagnosticOf(name) ?? diagnosticOf(`$${name}`))?.scope ?? ""];

const countList = (ns: readonly number[]): string =>
  ns.length === 2 ? `${ns[0]} or ${ns[1]}` : `${ns.slice(0, -1).join(", ")}, or ${ns[ns.length - 1]}`;

const countWord = (args: Arity): string => {
  if (args.none === true) return "takes no arguments";
  if (args.exact !== undefined) return `requires exactly ${args.exact} argument${args.exact === 1 ? "" : "s"}`;
  if (args.allowed !== undefined) return `requires ${countList(args.allowed)} arguments`;
  if (args.atLeast !== undefined) return `requires at least ${args.atLeast} argument${args.atLeast === 1 ? "" : "s"}`;
  return "takes a different number of arguments";
};

const NO_CELL: Readonly<Record<Position, (quoted: string, bare: string) => string>> = {
  value: (q) => `${q} has no value form here — see its 'where'.`,
  filter: (q, b) => `${q} is a value, not a test. Compare it: '$.<field> === ${b}'.`,
  stream: (q) => `${q} produces a value, not a stream of documents.`,
  statement: (q, b) => `${q} computes a value, and a statement writes one. Assign it to a field: '$.<field> = ${b};'`,
  group: (q) => `${q} is not an accumulator. Inside '$group' write the MongoDB operator.`,
  window: (q) => `${q} is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
  updateDoc: (q, b) =>
    `${q} is computed on the server. A document-form update takes constants only. Use the pipeline form ('jsmql.pipeline("$.<field> = ${valueStart(b)};")'). 'updateOne' also accepts this form. Or pass the value from your code.`,
};

function valueStart(bare: string): string {
  if (bare.startsWith(".")) return `<value>${bare}(…)`;
  return /^[A-Za-z$_]/.test(bare) ? `${bare}…` : `<a> ${bare} <b>`;
}

export function refusalFor(
  sel: Selected,
  spelled: string,
  container: string,
  position: Position,
  pos: number,
  near: readonly string[],
  format: (candidate: string) => string = (s) => `.${s}()`,
  subjects: Subjects = { args: [] },
): CodegenError {
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
        `Unknown ${container === "" ? "name" : "method"} '${spelled}${container === "" ? "" : "()"}' at position ${pos}.${didYouMean(sel.name, near, (c) => format(suggestedAs(c) ?? c))}`,
        pos,
      );
    case "wrongReceiver": {
      const accepts = sel.accepts === "any" ? "any value" : sel.accepts.map((f) => `'${f}'`).join(", ");
      const got =
        sel.got === null
          ? "a receiver whose type JSMQL cannot prove"
          : sel.got
              .split(" or ")
              .map((k) => `${/^[aeiou]/i.test(k) ? "an" : "a"} '${k}'`)
              .join(" or ");
      const takesString = sel.accepts !== "any" && sel.accepts.includes("string");
      const oneRef =
        position === "statement" && sel.accepts !== "any" && sel.accepts.length === 1
          ? RUNS_ON[sel.accepts[0]]
          : undefined;
      const sibling = sel.got === null ? null : siblingOf(sel.name, sel.got);
      const hint =
        oneRef !== undefined
          ? ` Write '${oneRef.sigil}.${bare.replace(/^\./, "")}()' — ${oneRef.place}.`
          : sibling !== null
            ? ` ${sibling}`
            : sel.got === "array" && sel.accepts !== "any" && !sel.accepts.includes("array")
              ? ` Map over the array first — '.map(x => x${bare}(…))' — or take one element ('[0]').`
              : sel.got === "date" && takesString
                ? ` Render the date as a string first: '.format("%Y-%m-%d")' or '.toISOString()'.`
                : sel.got === "number" && takesString
                  ? ` Render the number as a string first: '.toString()'.`
                  : sel.got === "stream" && sel.accepts !== "any" && !sel.accepts.includes("stream")
                    ? ` A stream is not an array. Chain a method the stream has ('$$.filter(…)', '$$.orderBy(…)'), or call this one on an array the document carries ('$.<field>.<method>()').`
                    : sel.got === "string" && sel.accepts !== "any" && sel.accepts.includes("array") && !takesString
                      ? ` A string is not a list. For one element per character, write '<string>.length().range().map(i => <string>.charAt(i))'; to keep the string whole, read it as it is.`
                      : sel.got === "object" && sel.accepts !== "any" && sel.accepts.includes("array")
                        ? ` A document is not a list. To count its fields, write '.keys().size()'; to read one field, write '.<field>'; to keep the array, remove the '.head()', '.find(…)' or '[0]' that took one element from it.`
                        : sel.got === "bool"
                          ? ` A boolean has no methods. Use it as a condition ('cond ? a : b').`
                          : "";
      const shown = isFieldProperty(sel.name) ? `'${bare}'` : `'${bare}()'`;
      return new CodegenError(`${shown} is not available on ${got} — it is defined on ${accepts}.${hint}`, pos);
    }
    case "wrongCount": {
      const most = sel.args.exact ?? (sel.args.allowed === undefined ? undefined : Math.max(...sel.args.allowed));
      const thisArg =
        callbackParamsOf(sel.name, position) !== undefined && most !== undefined && sel.got === most + 1
          ? " — JavaScript's trailing 'thisArg' has no meaning in MQL; drop it"
          : "";
      return new CodegenError(`'${signature(bare, sel.args)}' ${countWord(sel.args)}, got ${sel.got}${thisArg}`, pos);
    }
    case "rejectedCount":
      return new CodegenError(sel.message, pos);
    case "wrongKind":
      return kindRefusal(sel.fault, spelled, subjects, pos);
    case "spreadRefused": {
      const alt = spreadAlternativeOf(sel.name);
      const fix =
        alt !== undefined
          ? `${alt}, or pass a single array (${spelled}([a, b]))`
          : bare.startsWith("$")
            ? `pass operands directly (${spelled}(a, b)) or as a single array (${spelled}([a, b]))`
            : `pass each argument on its own: '${spelled}(${sel.sig})'`;
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
      return new CodegenError(
        `jsmql internal error (please report to the jsmql maintainers): refusalFor received a '${sel.kind}' answer for ${spelled}`,
        pos,
      );
  }
}

export const undefinedAsValue = (pos: number): CodegenError =>
  new CodegenError(
    `'undefined' is only meaningful in a comparison — 'x === undefined' / 'x !== undefined' test whether a field is present. As a value it has no MongoDB equivalent: use 'null' for the present-but-null case, or 'delete $.field' to remove a field.`,
    pos,
  );

export const bigIntTooLarge = (digits: string, pos: number): CodegenError =>
  new CodegenError(
    `The BigInt ${digits} does not fit in a 64-bit integer (-9223372036854775808 … 9223372036854775807). MQL stores only this range. Write 'Decimal128("${digits}")' instead.`,
    pos,
  );

export const regexAsValue = (pos: number): CodegenError =>
  new CodegenError(
    `In JavaScript code, a regex literal is valid only as an argument of .match(), .test(), .exec(), .matchAll() or .search(). In MQL that you write, a regex literal is a BSON regex: '{ name: /^a/ }', '$regexMatch({ input: $.name, regex: /^a/ })'. To pass a pattern as a string, use a string literal.`,
    pos,
  );

export const lambdaAsValue = (pos: number): CodegenError =>
  new CodegenError(
    "A function (=>) is only valid as the callback to an array method that iterates (.map, .filter, .some, .every, .find, .reduce, …), or as the second argument to $let.",
    pos,
  );

export const callableAsValue = (spelled: string, pos: number): CodegenError =>
  new CodegenError(`'${spelled}' is a function, not a value. Write a call: '${spelled}(…)'.`, pos);

/**
 * A declared function read as a VALUE. MQL expressions carry no function
 * value. So the way out is the explicit lambda that calls it. The tracking
 * id stays in this comment and out of the message: a developer reading the
 * error has no use for it. [DEF-032]
 */
export const functionAsValue = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is a reusable function, and a function is not a value MQL can carry. Call it — '${name}(x)' — or, to hand it to a higher-order method, write the lambda that calls it: '.map((x) => ${name}(x))'.`,
    pos,
  );

export const droppedBinding = (ref: { readonly message: string }, pos: number): CodegenError =>
  new CodegenError(ref.message, pos);

export const afterReplace =
  (by: string) =>
  (name: string, mutable: boolean): string =>
    mutable
      ? `\`${name}\` is a \`let\` binding. It cannot be read after \`${by}\`, because that stage replaced the document that carried it. Assign it again after the stage (\`${name} = …\`), or carry the value as a field of the new document.`
      : `\`${name}\` is a \`const\` binding. It cannot be read after \`${by}\`, because that stage replaced the document that carried it. Carry the value as a field of the new document, or declare it with \`let\` and assign it again after the stage.`;

export const clearedForRawRoot = (name: string): string =>
  `\`${name}\` cannot be read here. A stage before this read reads the whole document as \`$$ROOT\` in raw MQL. So the compiler removed its own fields from the document ahead of that stage, and \`${name}\` was one of them. Read \`${name}\` before that stage, or write \`$\` in place of \`"$$ROOT"\`: \`$\` is the document without the compiler's fields, and \`${name}\` stays.`;

export const rawRootReadsNamespace = (pos: number): CodegenError =>
  new CodegenError(
    'This statement reads the whole document as `$$ROOT` in raw MQL, and it also reads a value that the compiler keeps in a field of the document: a `let` binding, a stream count or a join. `$$ROOT` would then hold that field. Write `$` in place of `"$$ROOT"`: `$` is the document without the compiler\'s fields.',
    pos,
  );

export const unfilledParam = (name: string, method: string, why: string): string =>
  `\`${name}\` has no value inside \`.${method}()\` — ${why}`;

export const negativeIndex = (index: number, pos: number): CodegenError =>
  new CodegenError(
    `Negative bracket index '[${index}]' is not allowed. In JavaScript that reads a property named "${index}" (normally 'undefined'), not the element ${-index} from the end. Use '.at(${index})' to index from the end. This method works on both arrays and strings.`,
    pos,
  );

export const looseEqualityNotNull = (op: "==" | "!=", pos: number): CodegenError =>
  new CodegenError(
    `'${op}' is only allowed against null in JSMQL. Use '${op === "==" ? "===" : "!=="}' for JS-like strict equality (no surprising type coercion). To match "null or missing", write '$.x ${op} null'.`,
    pos,
  );

export const inNeedsList = (pos: number): CodegenError =>
  new CodegenError(
    "The right side of 'in' must be a list, as in 'x in [1, 2, 3]'. For an element of an array value, write '<array>.has(x)'; for a key of an object, write '<object>.key !== undefined' or '<object>.keys().has(k)'.",
    pos,
  );

export const recursiveFunction = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `Recursive function calls are not supported. A MongoDB expression cannot call itself. '${name}' calls itself while the compiler still expands it (direct or mutual recursion). Rewrite it without recursion.`,
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

const SUBJECT: Readonly<Record<Kind, string>> = {
  string: "a string",
  array: "an array",
  number: "a number",
  object: "an object",
  date: "a date",
  bool: "a boolean",
  stream: "the stream",
  objectId: "an ObjectId",
  binData: "a binary value",
  minKey: "MinKey",
  maxKey: "MaxKey",
};

const FAMILY_OF: Readonly<Partial<Record<Kind, Family>>> = {
  string: "string",
  array: "array",
  number: "number",
  object: "object",
  date: "date",
  stream: "stream",
};

const EXAMPLE_METHOD: Readonly<Partial<Record<Family, string>>> = {
  string: "trim",
  number: "round",
  date: "getFullYear",
  object: "keys",
};

const spelledField = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;

const methodsOf = (family: Family): string[] =>
  valueMethodNames().filter((n) => {
    const shown = suggestedAs(n);
    return shown !== undefined && familiesOf(shown)?.includes(family) === true;
  });

const spelledMethod = (name: string): string => `.${suggestedAs(name) ?? name}()`;

function methodFix(name: string, family: Family): string | null {
  if (methodsOf(family).includes(name)) return `Write '${spelledMethod(name)}' to call the method.`;
  const sibling = siblingOf(name, family);
  if (sibling !== null) return sibling;
  if (family === "array") return `To read the field of each element, write '.map(e => e${spelledField(name)})'.`;
  return null;
}

function readFix(name: string, kinds: readonly Kind[]): string {
  const family = kinds.length === 1 ? FAMILY_OF[kinds[0]] : undefined;
  if (family === undefined) return "Read the field from an object instead.";
  const near = methodFix(name, family) ?? didYouMean(name, methodsOf(family), spelledMethod).trim();
  if (near !== "") return near;
  const example = EXAMPLE_METHOD[family];
  return example === undefined
    ? "Read the field from an object instead."
    : `Call a method instead, for example '.${example}()'.`;
}

export function unreadableField(
  name: string,
  why: Unreadable,
  read: string,
  holder: string | null,
  pos: number,
): CodegenError {
  if (why.kind === "closed") {
    const shown = why.keys.slice(0, 6).map((k) => `'${k}'`);
    const list = `${shown.join(", ")}${why.keys.length > 6 ? ", …" : ""}`;
    const fix = methodFix(name, "object") ?? didYouMean(name, why.keys, (k) => spelledField(k)).trim();
    const subject = holder ?? "this object";
    const [owner, holds] =
      why.elements === true
        ? [
            `the elements of ${subject} do not have`,
            why.keys.length === 0 ? "They hold no fields." : `They hold ${list}.`,
          ]
        : [`${subject} does not have`, why.keys.length === 0 ? "It holds no fields." : `It holds ${list}.`];
    return new CodegenError(`'${read}' reads a field that ${owner}. ${holds}${fix === "" ? "" : ` ${fix}`}`, pos);
  }
  if (why.kinds.length === 0) return alwaysAbsent(read, holder, pos);
  const subject = why.kinds.map((k) => SUBJECT[k]).join(" or ");
  return new CodegenError(`'${read}' reads a field, and ${subject} has no fields. ${readFix(name, why.kinds)}`, pos);
}

export function alwaysAbsent(read: string, holder: string | null, pos: number): CodegenError {
  const subject = holder ?? "this value";
  const sentence = subject.charAt(0).toUpperCase() + subject.slice(1);
  return new CodegenError(
    `${sentence} is always null or missing here, so '${read}' has no value to read. Remove the read, or write a value before the read.`,
    pos,
  );
}

export const noNewKeyword = (name: string | null, pos: number): CodegenError =>
  new CodegenError(
    name === null
      ? "JSMQL has no 'new' keyword. Call a constructor such as 'Date(…)', or a declared function, without 'new'."
      : `JSMQL has no 'new' keyword. Write '${name}(…)'.`,
    pos,
  );

export const unknownClass = (name: string, known: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `JSMQL has no 'new' keyword, and it knows no class '${name}'.${didYouMean(name, known, (s) => `${s}(…)`)} MQL has no classes of its own. Write the value as an object literal ('{ … }'), or declare a function that returns one, and call it.`,
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

export const rootIsArray = (root: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      `'${root} = …'`,
      "",
      "a document",
      "got an array",
      ` Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '${root}.<field> = <array>;'.`,
    ),
    pos,
  );

export const joinNeedsPipeline = (pos: number): CodegenError =>
  new CodegenError(
    "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline — for example, `({ $ }) => { $.n = $$$.<coll>.filter(…).size(); }`. It has no meaning in a Filter or in 'jsmql.expr'.",
    pos,
  );

export const needsPipeline = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'$$.${name}()' (the current stream's document count) needs Pipeline mode — it materialises a '$setWindowFields' stage. Use it inside a pipeline — for example, \`({ $ }) => { $.n = $$.${name}(); … }\`. It has no meaning in a Filter or in 'jsmql.expr'.`,
    pos,
  );

export const spreadInOperatorBody = (pos: number): CodegenError =>
  new CodegenError("MQL has no spread in an object. Write '<a>.assign(<b>)' instead.", pos);

export const computedKeyInOperatorBody = (pos: number): CodegenError =>
  new CodegenError("Computed object keys are not allowed here. An operator argument key must be a literal name.", pos);

export const tooManySortKeys = (who: string, count: number, limit: number, pos: number): CodegenError =>
  new CodegenError(
    `'${who}' sorts by at most ${limit} keys, and this sort names ${count}. The server refuses a longer compound sort. Keep the ${limit} keys that decide the order, or put the last keys into one document field ('$.tie = { c: $.c, d: $.d }') and sort by 'tie'.`,
    pos,
  );

export const spreadInCall = (label: string, pos: number): CodegenError =>
  new CodegenError(
    `${label}: spread arguments are not supported. Pass each argument explicitly, or use $op($let, ...) to build the bindings by hand.`,
    pos,
  );

export const expressionInQueryValue = (pos: number): CodegenError =>
  new CodegenError(
    "The value of a key in a query document is a VALUE or a query operator. This is a computed expression instead. The query language reads it as a value to compare against. For example, '{ a: $.b > 1 }' becomes '{ a: { $gt: [\"$b\", 1] } }'. The server accepts this and matches nothing. Write the predicate itself ('$.a > 1', or '$match($.a > 1)'), or put the expression in '$expr'.",
    pos,
  );

export const aggregationOperatorInQuery = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is an aggregation operator. A query document has no such operator. The server answers "unknown operator: ${name}". Put it in '$expr' ('$expr($eq(${name}(…), …))'), or use the query operator that says the same thing.`,
    pos,
  );

export const queryOnlyInsideElement = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' applies to the top-level document only. The server refuses it inside an array element test. Move it out of the '.some(…)' body: '$.items.some(…) && ${name}(…)'.`,
    pos,
  );

export const arrayOfArrays = (method: string, holder: string, pos: number): CodegenError =>
  new CodegenError(
    `.${method}() cannot stringify an array of arrays. ${holder} holds arrays, and the server refuses to stringify an array element. Flatten first ('.flat().join()'), or map each inner array to a string ('.map(a => a.join(",")).join()').`,
    pos,
  );

export const streamHandleAfterReplace = (name: string, stage: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is the body's own stream. This body runs '${stage}', which changes what its count means. The compiler stamps '${name}.size()' into a field ahead of the body. That stage either drops the field or changes the number of documents. Only a stage that leaves both alone keeps the count true. Take the count in a statement ahead of this chain, or drop '${name}' from the parameter list.`,
    pos,
  );

export const streamHandleAsValue = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is the body's own stream, the callback's third parameter: read its count ('${name}.size()') or chain on it ('${name}.filter(…)'). It is not a document or a value on its own.`,
    pos,
  );

export const bareContextRef = (ref: string, pos: number): CodegenError => {
  const what =
    ref === "$$"
      ? "'$$' is the stream — chain what to do with it: '$$.filter(…);', '$$.push({ … });', '$$ = $$.take(10);'"
      : ref === "$$$"
        ? "'$$$' is the current database — name a collection after it: '$.o = $$$.<coll>.find(…);' reads one, '$$$.<coll> = $$;' writes one"
        : "'$$$$' is the cluster — name a database and a collection after it: '$$$$.<db>.<coll> = $$;' writes one; '$$$$.currentOp();' is a source stage";
  return new CodegenError(`${what}. Alone it is not a statement.`, pos);
};

export const notAStatement = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline statement writes something: a field ('$.total = …;'), the document ('$ = { … };'), a deletion ('delete $.x;'), or a stage ('$match(…);'). This expression only computes a value — assign it to a field, or wrap a predicate as '$match(…)'.",
    pos,
  );

export const notAStage = (name: string, stages: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is not an aggregation stage, so it cannot stand as a statement.${didYouMean(name, stages, (s) => s)}`,
    pos,
  );

export const multiKeyStageDocument = (name: string, keys: number, pos: number): CodegenError =>
  new CodegenError(
    `A raw stage document holds exactly one stage, and this one holds ${keys} keys. Write '{ ${name}: … }' on its own, and the next stage as its own statement.`,
    pos,
  );

export const rootMustBeDocument = (root: string, noun: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      `'${root} = …'`,
      "",
      "a document",
      `got ${noun}`,
      ` Put the value under a field ('${root} = { value: … };'), or write to a field instead ('${root}.value = …;').`,
    ),
    pos,
  );

export const cannotDeleteRoot = (root: string, pos: number): CodegenError =>
  new CodegenError(
    root === "$$"
      ? "'delete $$' would delete the root stream itself. To keep no documents, write '$$ = [];'; to keep some, write '$$.filter(d => …);'."
      : `'delete ${root}' would delete the document itself. To replace it, write '${root} = { … };'; to drop every field but one, write '${root} = { keep: ${root}.keep };'.`,
    pos,
  );

export const notAWriteTarget = (pos: number): CodegenError =>
  new CodegenError(
    "A write names a field: '$.total = …', '$.a.b = …', or the document itself, '$ = { … }'. A computed destination ('$[expr] = …') has no field name at compile time. Use '$setField({ field: <expr>, input: $, value: … })' when the name is a value.",
    pos,
  );

export const needsStageList = (pos: number): CodegenError =>
  new CodegenError(
    "This stage's body is a sub-pipeline: write it as a bracketed list of stages, '[$match(…), $sort(…)]'.",
    pos,
  );

export const spreadInStageList = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline is written out stage by stage; '...' cannot spread stages into it. List each stage.",
    pos,
  );

export const mustBeFirstStage = (name: string, pos: number, why?: string): CodegenError =>
  new CodegenError(
    why ??
      `'${name}' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.`,
    pos,
  );

export const firstStageNeedsHoist = (
  name: string,
  hoisted: string,
  pos: number,
  carrier: string | null,
): CodegenError => {
  const value = hoisted === "$lookup" ? "$$$.<coll>.find({ … }).<field>" : "$$.size()";
  const later = `$match($.<field> === ${value});`;
  return new CodegenError(
    carrier === null
      ? `'${name}' has to be the FIRST stage of the pipeline. A value in its body needs a '${hoisted}' stage of its own to run BEFORE it. Nothing may stand ahead of '${name}'. Read that value in a LATER statement instead — '${name}({ … }); ${later}'. Or, when the value is one of the stage's settings, give it a constant or a 'jsmql.compile' parameter: the server reads a setting before it has any documents.`
      : `'${name}' only runs in the pipeline's FIRST '${carrier}'. A value in that body needs a '${hoisted}' stage of its own to run BEFORE it. Nothing may stand ahead of that '${carrier}'. Keep the '${name}' test on its own, and make the other one a later stage: '${carrier}(${name}(…)); ${later}'.`,
    pos,
  );
};

export const terminalReadsScratch = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' writes the pipeline's output and has to be its LAST stage. JSMQL clears its scratch fields in the stage right before it. So a value this body reads ('$$.size()', a '$$$.<coll>' read) is already gone by the time the server evaluates it. Put the value in a field of the document first, and read that field: '$.n = $$.size(); ${name}({ … let: { v: $.n } … });'.`,
    pos,
  );

export const twoTerminalStages = (name: string, already: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' writes the pipeline's output and has to be its last stage, and '${already}' already is. A pipeline writes to one destination — keep one of them.`,
    pos,
  );

export const notAPipeline = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline is one or more statements: `;`-separated ('$match(…); $sort({…});') or a bracketed list of stages ('[$match(…), $sort({…})]'). This source is a single expression — pass it to jsmql() for a filter, or jsmql.expr() for an aggregation expression.",
    pos,
  );

export const noStages = (pos: number): CodegenError =>
  new CodegenError(
    "This program produces no stages, so it would leave the documents untouched. Write at least one statement that reads or changes them.",
    pos,
  );

const KIND_NOUN: Readonly<Record<string, string>> = {
  number: "a number",
  string: "a string",
  bool: "a boolean",
  array: "an array",
  object: "a document",
  date: "a date",
  objectId: "an ObjectId",
  binData: "binary data",
  stream: "a stream",
  minKey: "a MinKey",
  maxKey: "a MaxKey",
  null: "null",
};

const ELEMENT_NOUN: Readonly<Record<string, string>> = {
  number: "numbers",
  string: "strings",
  bool: "booleans",
  array: "arrays",
  object: "documents",
  date: "dates",
  objectId: "ObjectIds",
  binData: "binary data",
  null: "null",
};

const nounFor = (k: Kind, table: Readonly<Record<string, string>>): string => table[k] ?? `a ${k}`;

export type Subjects = {
  readonly receiver?: { readonly pos: number };
  readonly args: readonly { readonly pos: number }[];
  readonly slots?: readonly string[];
};

const orList = (items: readonly string[]): string => {
  const once = [...new Set(items)];
  return once.length < 2 ? (once[0] ?? "") : `${once.slice(0, -1).join(", ")} or ${once[once.length - 1]}`;
};

const kindNoun = (k: Proven): string => KIND_NOUN[k] ?? `a ${k}`;
const kindsNoun = (ks: readonly Proven[], join: string): string => ks.map(kindNoun).join(join);
const pluralKind = (k: Proven): string => ELEMENT_NOUN[k] ?? `${k}s`;

function spellArray(e: { readonly pos: number } | undefined): string {
  const node = e as { type?: string; path?: string; argument?: { pos: number } } | undefined;
  if (node?.type === "SpreadElement") return spellArray(node.argument);
  return node?.type === "FieldRef" && node.path !== undefined && node.path !== "" ? `'${node.path}'` : "an array";
}

function gotKinds(e: { readonly pos: number } | undefined, kinds: readonly Proven[], viaElements: boolean): string {
  const nouns = orList(kinds.map(kindNoun));
  return viaElements ? `an element of ${spellArray(e)} that is ${nouns}` : nouns;
}

function operandAt(subjects: Subjects, slot: number): { readonly pos: number } | undefined {
  const only =
    subjects.args.length === 1 ? (subjects.args[0] as { type?: string; packed?: true; elements?: unknown }) : null;
  if (only !== null && only.type === "ArrayLiteral" && only.packed === true) {
    return (only.elements as readonly { readonly pos: number }[])[slot];
  }
  return subjects.args[slot];
}

const slotName = (subjects: Subjects, slot: number): string => subjects.slots?.[slot] ?? `argument ${slot + 1}`;

function shownName(spelled: string): string {
  if (spelled.startsWith("'")) return spelled;
  if (spelled.startsWith("$")) return `'${spelled}'`;
  return `'${spelled.replace(/\(\)$/, "")}()'`;
}

function kindRefusal(fault: KindFault, spelled: string, subjects: Subjects, pos: number): CodegenError {
  const name = shownName(spelled);
  switch (fault.rule) {
    case "slot": {
      const e = operandAt(subjects, fault.slot);
      return new CodegenError(
        wrongKind(
          name,
          slotName(subjects, fault.slot),
          takesOf(fault.expected),
          `got ${gotKinds(e, fault.got, fault.viaElements === true)}`,
          fault.hint ?? hint(fault.expected, fault.got),
        ),
        e?.pos ?? pos,
      );
    }
    case "element": {
      const e = operandAt(subjects, fault.slot);
      return new CodegenError(
        wrongKind(
          name,
          slotName(subjects, fault.slot),
          takesOf("element"),
          `got ${gotKinds(e, fault.got, fault.viaElements === true)}, and the array holds ${orList(fault.held.map(pluralKind))}`,
        ),
        e?.pos ?? pos,
      );
    }
    case "elements":
      return new CodegenError(
        wrongKind(name, "", pluralKind(fault.expected), `the array holds ${kindsNoun(fault.held, " and ")}`),
        subjects.receiver?.pos ?? pos,
      );
    case "homogeneous": {
      const e = operandAt(subjects, fault.slot);
      return new CodegenError(
        wrongKind(
          name,
          "",
          "operands of one kind",
          `got ${gotKinds(operandAt(subjects, fault.first), fault.firstKinds, fault.firstViaElements === true)} and ${gotKinds(e, fault.got, fault.viaElements === true)}`,
        ),
        e?.pos ?? pos,
      );
    }
  }
}

export function nounOfKinds(t: Type): string {
  if (t.kinds === "any") return "a value";
  if (t.kinds.size === 0) return "null";
  return [...t.kinds].map((k) => nounFor(k, KIND_NOUN)).join(" or ");
}

export function pluralNounOfKinds(t: Type): string {
  if (t.kinds === "any") return "values";
  if (t.kinds.size === 0) return "null";
  return [...t.kinds].map((k) => ELEMENT_NOUN[k] ?? `${k}s`).join(" or ");
}

export const spreadNotAnArray = (noun: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      "'...'",
      "argument 1",
      "an array",
      `got ${noun}`,
      " To keep the value whole, drop the '...'. To spread its elements, give it an array.",
    ),
    pos,
  );

export const spreadNotADocument = (noun: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      "'...'",
      "argument 1",
      "a document",
      `got ${noun}`,
      " Put the value under a field ('{ value: … }'), or spread a document.",
    ),
    pos,
  );

export const spreadOfString = (pos: number): CodegenError =>
  new CodegenError(
    "'...' spreads a string into its characters in JavaScript. MongoDB has no operator that does this — '$concatArrays' takes arrays only. For one character per element, write '<string>.length().range().map(i => <string>.charAt(i))'. To keep the string whole, drop the '...'.",
    pos,
  );

export function noReceiver(name: string, pos: number): CodegenError {
  if (isStageName(name)) {
    const twin = valueTwinOf(name);
    return new CodegenError(
      `'.${name}()' is a pipeline stage, and a stage runs on a stream, not on a value. Write it as a chain link ('$$.${name}(…)') or as a pipeline statement ('${name}(…);').${twin === undefined ? "" : ` For the value form, use '${twin}(…)'.`}`,
      pos,
    );
  }
  if (!name.startsWith("$") && positionsOf(name)?.length === 0) {
    const verdict = consult(name, "value");
    if (verdict.kind === "refused") return new CodegenError(refusalSentence(verdict, `'.${name}()'`, "a value"), pos);
  }
  return new CodegenError(
    name.startsWith("$")
      ? `'.${name}()' takes no receiver. A '$' name is a MongoDB operator or stage, and each one is a call: write '${name}(…)' with every operand inside the parentheses.`
      : `'.${name}()' takes no receiver. '${name}' is a global function: write '${name}(…)' with the value inside the parentheses.`,
    pos,
  );
}

export const afterTerminalStage = (already: string, pos: number): CodegenError =>
  new CodegenError(
    `Nothing can follow '${already}': it writes the pipeline's output and the server requires it last. Move this statement above it.`,
    pos,
  );

export const forbiddenInContainer = (name: string, container: string, pos: number, instead?: string): CodegenError =>
  new CodegenError(
    `'${name}' cannot stand inside '${container}' — the server refuses it in that body. ${instead ?? "Run it as a stage of the outer pipeline instead."}`,
    pos,
  );

export const bannedNested = (spelled: string, stage: string, container: string, instead: string, pos: number) =>
  new CodegenError(
    `'${spelled}' makes a '${stage}' stage, and the server refuses that anywhere inside a '${container}' — however deeply it is nested. ${instead}`,
    pos,
  );

export const notAMongoType = (spelling: string, aliases: readonly string[], pos: number): CodegenError => {
  const lower = spelling.toLowerCase();
  const hint = TYPEOF_HINTS[lower];
  const byCase = aliases.find((a) => a.toLowerCase() === lower);
  const realOf = new Map(aliases.map((a) => [a.toLowerCase(), a]));
  const fix =
    hint === undefined
      ? byCase !== undefined
        ? ` Did you mean '${byCase}'?`
        : didYouMean(lower, realOf.keys(), (s) => realOf.get(s) ?? s)
      : "name" in hint
        ? ` Did you mean '${hint.name}'?`
        : ` For ${hint.test}, write '${hint.write}'.`;
  return new CodegenError(
    `'typeof' compares against one of MongoDB's type names, and "${spelling}" is not one, so the comparison is never true.${fix}`,
    pos,
  );
};

export const writeToOwnStream = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is the body's own stream, and a stream is not a value a statement writes to. Append documents with '.concat(…)' ('${name}.concat([{ … }]);'), keep some with '.filter(…)', or run a stage on it ('${name}.$match(…);').`,
    pos,
  );

export const streamElementsNotDocuments = (noun: string, written: string, pos: number): CodegenError =>
  new CodegenError(
    `'${written}' makes documents from the array's ELEMENTS, one each, and these elements are ${noun}. Put each under a field — '<array>.map((v) => ({ value: v }))' — or write to a field of the document you have ('$.<field> = <array>;').`,
    pos,
  );

export const notAStreamChain = (
  pos: number,
  noun?: string,
  lead = "'$$ = …' replaces the STREAM, so the right side has to be MANY documents",
  how = "Write a chain that starts from '$$' ('$$ = $$.filter(d => d.x > 1).take(10);'), a list of documents ('$$ = [{ a: 1 }, { a: 2 }];'), or an array whose elements are the documents ('$$ = $.items;').",
): CodegenError => new CodegenError(`${lead}${noun === undefined ? "" : ` — ${noun} is one value`}. ${how}`, pos);

export const notAStreamLink = (name: string, candidates: readonly string[], pos: number): CodegenError => {
  const spell = (s: string): string => {
    const runsOn = runsOnFor(s);
    return runsOn === undefined ? `.${s}()` : `${runsOn.sigil}.${sugarOf(s)}()`;
  };
  return new CodegenError(
    `'.${name}()' is not a method of the stream '$$'.${didYouMean(name, candidates, spell)} A stage is a link too: '$$.$match(…)'.`,
    pos,
  );
};

const SPELLING: Readonly<Record<SlotForm, string>> = {
  propertyPath: `a field name ('"status"')`,
  propertyIndex: "an index ('0')",
  matchesObject: `a matcher object ('{ status: "paid" }')`,
  matchesPropertyPair: `a '[field, value]' pair ('["status", "paid"]')`,
  bareCallable: "a callable ('Boolean')",
  omitted: "no argument at all",
};

const spellings = (forms: readonly SlotForm[]): string => {
  const all = ["an arrow ('d => …')", ...forms.map((f) => SPELLING[f])];
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(", ")}, or ${all[all.length - 1]}`;
};

const ARG_NOUN: Readonly<Record<string, string>> = {
  NumberLiteral: "a number",
  StringLiteral: "a string",
  BooleanLiteral: "a boolean",
  NullLiteral: "null",
  ObjectLiteral: "an object",
  ArrayLiteral: "an array",
};

export const notAnArrow = (
  name: string,
  what: string,
  forms: readonly SlotForm[],
  got: { type: string; pos: number },
  slot: number,
): CodegenError => {
  if (got.type === "NullLiteral") return nullCallback(name, slot, what, got.pos);
  const index = (got as { value?: unknown }).value;
  if (got.type === "NumberLiteral" && forms.includes("propertyIndex") && typeof index === "number") {
    return notAWholeIndex(name, slot, index, got.pos);
  }
  return new CodegenError(
    `'.${name}()' takes ${what} here — ${spellings(forms)}. Got ${
      got.type === "Ident" ? `the name '${(got as { name?: string }).name}'` : (ARG_NOUN[got.type] ?? "something else")
    }.`,
    got.pos,
  );
};

export const nullCallback = (name: string, slot: number, takes: string, pos: number): CodegenError =>
  new CodegenError(wrongKind(`'.${name}()'`, `argument ${slot + 1}`, takes, "got null"), pos);

export const notAWholeIndex = (name: string, slot: number, index: number, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      `'.${name}()'`,
      `argument ${slot + 1}`,
      "a whole-number index",
      index < 0 ? "got a negative number" : "got a fraction",
      ` In JavaScript, 'x[${index}]' reads no element of an array.`,
    ),
    pos,
  );

export const indexNotHeld = (name: string, slot: number, found: string, pos: number): CodegenError =>
  new CodegenError(wrongKind(`'.${name}()'`, `argument ${slot + 1}`, "an index that each element holds", found), pos);

export const emptyMatcherObject = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}({ … })' matches a document by its fields, and '{}' names none. Write the field to match — '.${name}({ status: "paid" })' — or an arrow — '.${name}(d => d.status === "paid")'.`,
    pos,
  );

export const badMatchesPropertyPair = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}([field, value])' matches one field against one value. It takes exactly two elements, and the first is a field-name string: '.${name}(["status", "paid"])'. An arrow says the same thing: '.${name}(d => d.status === "paid")'.`,
    pos,
  );

export const blockWhereValueExpected = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' takes an arrow that returns a value — 'd => d.x', or 'd => { …; return d.x; }'. A body of pipeline stages belongs to '.aggregate(o => { … })'.`,
    pos,
  );

export const valueWhereBlockExpected = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' takes an arrow whose body is a block of stages — 'o => { $match(…); $limit(1); }' — or a bracketed list of them.`,
    pos,
  );

export const optionalOnStream = (pos: number): CodegenError =>
  new CodegenError(
    "'$$' is the stream of documents and is never null, so '?.' has nothing to guard. Write '$$.' instead.",
    pos,
  );

export const mapMustReturnDocument = (name: string, noun: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      `'.${name}()'`,
      "argument 1",
      "an arrow that returns a document",
      `the arrow returns ${noun}`,
      " The arrow replaces each document. Return '({ value: … })' to keep the value under a field.",
    ),
    pos,
  );

export const notAFieldOfTheDocument = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}(d => …)' names the ARRAY FIELD to flatten: 'd => d.items'. It lowers to '$unwind'. This stage takes a field path and nothing else.`,
    pos,
  );

export const shadowsOuterBinding = (kind: string, name: string, pos: number): CodegenError =>
  new CodegenError(
    `\`${kind} ${name}\` shadows the \`${name}\` declared outside this block, and both would live in the same document. Pick a different name, or assign the outer one (\`${name} = …\`).`,
    pos,
  );

export const noCorrelationSlot = (stage: string, pos: number): CodegenError =>
  new CodegenError(
    `'${stage}' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.`,
    pos,
  );

export const readsEnclosingVariable = (name: string, stage: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is bound by an enclosing callback. A read of another collection is a '${stage}' STAGE: the server runs it over the documents, outside that callback, where '${name}' has no value. Make the elements documents first — '$$ = $.<array>;' — then each one is a document the join reads: '$.<field> = $$$.<coll>.find(…)'. Or read the collection OUTSIDE the callback ('let <name> = $$$.<coll>.filter(…);') and use that binding inside it.`,
    pos,
  );

export const documentsNeedNoStage = (written: string, made: string, pos: number): CodegenError =>
  new CodegenError(
    `'${written}' writes the documents out as the program spells them. This value needs a '${made}' stage of its own to produce it, and the documents run where nothing may stand ahead of them. Append the other collection's documents themselves: '$$.push(...$$$.<coll>.filter(…))' for many, '$$.push($$$.<coll>.find({ … }))' for one. Or give the field a value the program already holds — a constant, or a 'jsmql.compile' parameter.`,
    pos,
  );

export const notInUpdateSpec = (
  name: string,
  container: string,
  allowed: readonly string[],
  pos: number,
): CodegenError =>
  new CodegenError(
    `'${name}' cannot stand inside '${container}'. That body is an UPDATE, not a pipeline. The server runs only ${allowed
      .slice(0, -1)
      .map((a) => `'${a}'`)
      .join(
        ", ",
      )} and '${allowed[allowed.length - 1]}' there. Reshape the document with one of those, or do the work in the pipeline BEFORE '${container}'. Its documents are what the update receives.`,
    pos,
  );

export const crossDatabaseRead = (pos: number): CodegenError =>
  new CodegenError(
    "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    pos,
  );

export const runtimeInQueryOperator = (op: string, pos: number): CodegenError =>
  new CodegenError(
    `'${op}' compares against a constant in a query document, and this operand is read at run time. Write the test as an expression — '$match($.field …)' — or give '${op}' a constant.`,
    pos,
  );

export const rootStreamInForeign = (pos: number): CodegenError =>
  new CodegenError(
    "'$$' is the root stream, and a body over another collection cannot reach it. Name the body's own stream through the callback's third parameter — '(o, _i, stream) => { stream.filter(…); }' — or write the stage: '$match(…)', '$sort(…)'.",
    pos,
  );

export const streamAsValue = (pos: number): CodegenError =>
  new CodegenError(
    "A chain on '$$' is a stream of documents, not a value. To branch the stream write '$ = { k: $$.filter(…), … }' (a '$facet'); for its size write '$$.size()'; to keep the documents, chain them as a statement: '$$.filter(…);'.",
    pos,
  );

export const facetMixed = (key: string, pos: number): CodegenError =>
  new CodegenError(
    `'$ = { … }' with a '$$' chain is a '$facet', and every entry must be one: '${key}' is not a chain on '$$'. Make it one ('${key}: $$.filter(…)'), or move it out of the object.`,
    pos,
  );

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

export const mergeNeedsArgument = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `Nothing to write into the collection: give the stream ('$$$.<coll>.${name}($$);'), an array of documents ('$$$.<coll>.concat(<array>);' or '$$$.<coll>.push(...<array>);'), or one document ('$$$.<coll>.push({ … });').`,
    pos,
  );

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

export const noStageOnDatabase = (name: string, pos: number): CodegenError => {
  const sugar = sugarOf(name);
  const runsOn = runsOnFor(name);
  return new CodegenError(
    runsOn === undefined
      ? `'$$$' is the database, and no stage runs on it alone. Write '$$.${sugar}()' on the current collection, or '$$$$.${sugar}()' on the cluster.`
      : `'$$$' is the database, and no stage runs on it alone. Write '${runsOn.sigil}.${sugar}()' — ${runsOn.place}.`,
    pos,
  );
};

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
    `This reducer body spells no MongoDB accumulator. The shapes that do: '${acc} + ${d}.<field>' ($sum), '${acc} + 1' ($sum: 1), '[${acc}, ${d}.<field>].max()' / '.min()' ($max / $min), '${acc} ?? ${d}.<field>' ($first), '${d}.<field>' ($last), '[...${acc}, ${d}.<field>]' or '${acc}.concat(${d}.<field>)' ($push). For anything else write '$group({ … })'.`,
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
    "The initial value of a stream fold is a constant — 0, [], null — because MongoDB's accumulators start empty, and the seed folds in afterwards. A field cannot seed them.",
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

export const notAnArrowCallback = (name: string, pos: number): CodegenError =>
  new CodegenError(`'.${name}((x[, i[, arr]]) => …)' takes an arrow with an expression body.`, pos);

export const tooManyCallbackParams = (name: string, got: number, pos: number): CodegenError =>
  new CodegenError(`'.${name}()' callbacks take at most 3 parameters (element, index, array); got ${got}.`, pos);

export const objIterateeShape = (name: string, pos: number): CodegenError =>
  new CodegenError(`'.${name}((value[, key]) => …)' takes a one- or two-parameter arrow with an expression body.`, pos);

export const unionSpreadSource = (pos: number): CodegenError =>
  new CodegenError(
    "The stream takes another collection ('...$$$.<coll>', '...$$$.<coll>.filter(pred)') or documents the program spells out ('$$.push({ … })', '$$.push(...[{ … }, { … }])'). An array the DATA decides cannot be appended: '$documents' takes a written list, and the server refuses a field path there (measured: \"an array is expected\"). To make the stream FROM such an array, write '$$ = <array>;'.",
    pos,
  );

export const unionSpreadOfOne = (pos: number): CodegenError =>
  new CodegenError(
    "'.find(pred)' gives ONE document. JavaScript would not spread this. Drop the '...' to push the match, or write '...$$$.<coll>.filter(pred)' to push every match.",
    pos,
  );

export const unionNeedsSpread = (pos: number): CodegenError =>
  new CodegenError(
    "'$$.push($$$.<coll>.filter(pred))' would push the whole array as one document. Spread it — '$$.push(...$$$.<coll>.filter(pred))' — to push every match, or write '.find(pred)' for the first one.",
    pos,
  );

export const unionArg = (verb: string, slot: number, noun: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      `'$$.${verb}()'`,
      `argument ${slot + 1}`,
      "a document",
      `got ${noun}`,
      " Push a document ('$$.push({ … })'), a written list of them ('$$.push(...[{ … }])'), or another collection ('$$.push(...$$$.<coll>)').",
    ),
    pos,
  );

export const outNeedsStream = (pos: number): CodegenError =>
  new CodegenError(
    "A collection is written from the stream: '$$$.<coll> = $$' replaces it, '$$$.<coll> += $$' adds to it, and either takes more stages first ('… = $$.filter(…)'). To write an ARRAY of documents, name them: '$$$.<coll>.concat(<array>);' or '$$$.<coll>.push(...<array>);'.",
    pos,
  );

export const mergeNotADocument = (noun: string, pos: number): CodegenError =>
  new CodegenError(
    wrongKind(
      "'$$$.<coll>.push()'",
      "argument 1",
      "a document",
      `got ${noun}`,
      " The value becomes one document. Spread a list of them ('$$$.<coll>.push(...<array>);'), or put the value under a field ('$$$.<coll>.push({ value: … });').",
    ),
    pos,
  );

export const writeToCollectionOp = (op: string, pos: number): CodegenError =>
  new CodegenError(
    `A collection takes '=' or '+=', not '${op}'. '$$$.<coll> = $$' REPLACES what the collection holds (a '$out'). '$$$.<coll> += $$' ADDS to it: the server updates the documents whose '_id' matches (a '$merge').`,
    pos,
  );

export const mergeOneSource = (name: string, count: number, pos: number): CodegenError =>
  new CodegenError(
    `'$$$.<coll>.${name}()' writes ONE source into the collection, and this names ${count}. Write them one statement at a time, or join them first ('$$$.<coll>.${name}([...a, ...b]);').`,
    pos,
  );

export const outNeedsCollection = (pos: number): CodegenError =>
  new CodegenError(
    "'$$$$.<db>' names a database; write the collection too: '$$$$.<db>.<coll> = $$' — or '$$$.<coll> = $$' for the current database.",
    pos,
  );

export const outTooManySegments = (pos: number): CodegenError =>
  new CodegenError(
    "Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$').",
    pos,
  );

function holes(value: unknown): string {
  const hole = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(hole)
      : isPlainObject(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, hole(x)]))
        : "…";
  return stringify(hole(value)).split('"…"').join("…");
}

export function runTimeValueAsMql(
  value: unknown,
  where: Where,
  pos: number,
  lead = "A run-time value is a value, never MQL.",
): CodegenError {
  if (where.at === "value" && where.written !== undefined) {
    const { stage, path } = where.written;
    const key = path[path.length - 1];
    const slot = key === undefined ? "its body" : `'${path.join(".")}'`;
    if (typeof value === "string") {
      const inSource =
        key === undefined || key === null ? `${stage}(${stringify(value)})` : `${key}: ${stringify(value)}`;
      return new CodegenError(
        `${lead} '${stage}' reads ${slot} as written, and there the string ${stringify(value)} becomes part of the MQL. Write it in the source: '${inSource}'.`,
        pos,
      );
    }
    const inSource = key === undefined || key === null ? `${stage}(${holes(value)})` : `${key}: ${holes(value)}`;
    return new CodegenError(
      `${lead} '${stage}' reads ${slot} as written, and there this value becomes part of the MQL. Write it in the source, and pass only its values: '${inSource}'.`,
      pos,
    );
  }
  if (where.at === "group" || where.at === "window") {
    const kind = where.at === "group" ? "an accumulator" : "a window function";
    const keys = isPlainObject(value) ? Object.keys(value as Record<string, unknown>) : [];
    const shape = keys.length === 1 && keys[0].startsWith("$") ? `${keys[0]}(…)` : holes(value);
    return new CodegenError(
      `${lead} This slot takes ${kind}, and there the value becomes part of the MQL. Write ${kind} in the source, and pass only its values: '${shape}'.`,
      pos,
    );
  }
  if (where.at === "filter") return runTimeValueAsQuery(value, pos);
  if (where.at === "statement" || where.at === "stream") {
    return new CodegenError(
      "A run-time value is a value, never a stage. Write the stage in the source, and pass only its values.",
      pos,
    );
  }
  return new CodegenError(`${lead} Write this part in the source, and pass only its values.`, pos);
}

export const runTimeValueAsQuery = (value: unknown, pos: number): CodegenError =>
  new CodegenError(
    typeof value === "string"
      ? "A run-time value is a value, never a query. Write the query in the source, and pass only its values."
      : `A run-time document is a value, never a query. Write the query in the source, and pass only its values: '${holes(value)}'.`,
    pos,
  );

const LITERAL_NOUNS: Readonly<Partial<Record<Expr["type"], string>>> = {
  NumberLiteral: "a number",
  BooleanLiteral: "a boolean",
  NullLiteral: "null",
  ArrayLiteral: "an array",
  ObjectLiteral: "a document",
  BigIntLiteral: "a bigint",
  RegexLiteral: "a regular expression",
  ObjectIdLiteral: "an ObjectId",
};

const collectionNameOfWrongKind = (noun: string, pos: number): CodegenError =>
  new CodegenError(wrongKind("'$$$[…]'", "key", "a string", `got ${noun}`), pos);

const nounOfValue = (v: unknown): string => {
  if (v === null) return "null";
  if (isRegExp(v)) return "a regular expression";
  const k = kindOfValue(v);
  return k === null ? "a value of another kind" : kindNoun(k);
};

export function collectionNameFrom(index: Expr): CodegenError {
  if (index.type === "Injected") {
    return typeof index.value === "string"
      ? new CodegenError(
          `The run-time value ${stringify(index.value)} cannot name a collection: the server refuses a name that starts with '$'.`,
          index.pos,
        )
      : collectionNameOfWrongKind(nounOfValue(index.value), index.pos);
  }
  const noun = LITERAL_NOUNS[index.type];
  if (noun !== undefined) return collectionNameOfWrongKind(noun, index.pos);
  return collectionNameMustBeConstant(index.pos);
}

export const badOutTarget = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' cannot name a collection to write: the server refuses an empty name and one that starts with '$'.`,
    pos,
  );

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
      : " A stage runs on the current collection ('$$.<stage>()') or on the cluster ('$$$$.<stage>()').";
  const read = ` To read a collection called '${name}', write '$.<field> = ${sigil}.${name}.find(…)'.`;
  return new CodegenError(`${where}. '.${name}()' is not one of them.${tail}${read}`, pos);
};

export const noDestination = (pos: number): CodegenError =>
  new CodegenError(
    "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    pos,
  );

export const rootNeedsOneDocument = (root: string, pos: number): CodegenError =>
  new CodegenError(
    `The document can only become ONE document, and this chain gives an array. Write '${root} = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '${root}.<field> = $$$.<coll>.…'.`,
    pos,
  );

export const oneDocumentInStream = (pos: number): CodegenError =>
  new CodegenError(
    "'.find(…)' gives ONE document, and the stream is many. Write '$$ = $$$.<coll>.filter(pred).take(1)' for a stream of the first match, or '$ = $$$.<coll>.find(pred)' to make each document the one it finds.",
    pos,
  );

export const valueInStream = (name: string, pos: number): CodegenError =>
  isKnownName(name)
    ? new CodegenError(
        `'.${name}()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….${name}()'.`,
        pos,
      )
    : refusalFor({ kind: "unknown", name }, `.${name}`, "'$$$'", "stream", pos, streamReceiverNames());

export const outerWriteInForeign = (pos: number): CodegenError =>
  new CodegenError(
    "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.",
    pos,
  );

export const constReassigned = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is a 'const' and cannot be assigned again. Declare it with 'let' to write it more than once.`,
    pos,
  );

export const reducerShape = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}((acc, x[, i]) => …, seed)' takes a two- or three-parameter arrow with an expression body.`,
    pos,
  );

export const elementsShape = (name: string, count: number, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' takes an arrow with one parameter per zipped array — ${count} here — and an expression body.`,
    pos,
  );

export const mutatorNeedsField = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' changes its receiver in place, so as a statement it needs a field or a binding to write: '$.<field>.${name}(…);'. For a value, use its immutable form.`,
    pos,
  );

export class QueryFormError extends CodegenError {}

export const needsFieldPath = (name: string, pos: number): CodegenError =>
  new QueryFormError(
    `'${name}(field, …)' tests a field: its first argument is a field path ('$.a'), as in '${name}($.a, …)' or the document form '{ a: ${name}(…) }'.`,
    pos,
  );

export const needsLiteral = (name: string, pos: number): CodegenError =>
  new QueryFormError(
    `'${name}' compares against a compile-time constant in a query document, and this argument is read at run time. Give it a literal, or write the test as an expression ('$expr(…)').`,
    pos,
  );

export const elementNeedsQuery = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}(field, predicate)' takes a one-parameter arrow over the element whose body is a query test of the element alone ('x => x.q > 1'). A body that reads the outer document, or computes a value, has no query form here.`,
    pos,
  );

export const needsPrecedingSort = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'.${name}(predicate)' keeps the ${name === "takeWhile" ? "LEADING" : "TRAILING"} run of the stream, and a MongoDB stream has no order until you give it one. Sort first, then '.${name}(…)': '$$.toSorted({ t: 1 }).${name}(o => o.ok)' — any sort spelling works ('.sort', '.toSorted', '.sortBy', '.orderBy', '.$sort({ … })').`,
    pos,
  );

export const readInUpdateDocument = (ref: string, pos: number): CodegenError =>
  new CodegenError(
    `A document-form update takes constants: the server reads '${ref}' there as the string, not the field. To compute from the document, use the pipeline form ('jsmql.pipeline("$.a = $.b + 1;")'). 'updateOne' also accepts this form.`,
    pos,
  );

export const updateCopyNeedsPipeline = (from: string, to: string, pos: number): CodegenError =>
  new CodegenError(
    from === ""
      ? `'$.${to} = $' copies the whole document. A document-form update cannot do this. Use the pipeline form ('jsmql.pipeline("$.${to} = $;")'). 'updateOne' also accepts this form.`
      : `'$.${to} = $.${from}' copies a field. A document-form update cannot do this. To MOVE the field, delete the source as well: '$.${to} = $.${from}; delete $.${from};' (this is a $rename). To copy it, use the pipeline form.`,
    pos,
  );

export const updateConflict = (path: string, held: string, op: string, pos: number): CodegenError =>
  new CodegenError(
    `'${path}' is written twice in one update ('${held}' and '${op}'). The server refuses this as a conflict. Write each field once.`,
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

export const updateOperatorTwice = (op: string, pos: number): CodegenError =>
  new CodegenError(
    `'${op}' stands twice in one update, and one of its operands is not a document of fields, so the two cannot merge. Write '${op}' once.`,
    pos,
  );

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

export const unappliedReference = (ns: string, name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${ns}.${name}' is a function, not a value. Call it ('${ns}.${name}(…)'), or hand it to a callback slot ('.map(${ns}.${name})').`,
    pos,
  );

export const nearInMatch = (name: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' is not allowed inside an aggregation '$match' — the server refuses it there. Use the '$geoNear' stage as the first stage instead ('$geoNear({ near: …, distanceField: "d", spherical: true })'), or run the proximity query with 'find()'.`,
    pos,
  );

export const arrayReduceShape = (pos: number): CodegenError =>
  new CodegenError(
    "'$$.reduce((acc, d) => …, [])' keeps documents: it appends them. Write 'acc.concat(<doc>)' (or '[...acc, <doc>]') to reshape each document, and 'cond ? acc.concat(<doc>) : acc' to filter first. A total — a sum, a count, a maximum — is the wrap form: '$$ = [{ total: $$.reduce((acc, d) => acc + d.amount, 0) }]'.",
    pos,
  );
