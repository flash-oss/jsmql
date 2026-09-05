// Phase 5 — EMIT. Every message the emit phase can produce, worded once.
//
// A refusal is either a row's own text (`unsupported(…)`, handed on through
// `refusalSentence`) or one of the shapes below, each built from what the row
// states — a signature, a receiver list, a position. No sentence here says
// something a row could have carried.

import { CodegenError, UnknownIdentifierError, internalError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import type { Arity, Position } from "../../registry/vocabulary.ts";
import { TYPEOF_HINTS } from "../../registry/vocabulary.ts";
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

/** A stage body that must be a bracketed list of stages. */
export const needsStageList = (pos: number): CodegenError =>
  new CodegenError(
    "This stage's body is a sub-pipeline: write it as a bracketed list of stages, '[$match(…), $sort(…)]'.",
    pos,
  );

/** A spread inside a stage list: the pipeline is written out, stage by stage. */
export const spreadInStageList = (pos: number): CodegenError =>
  new CodegenError(
    "A pipeline is written out stage by stage; '...' cannot spread stages into it. List each stage.",
    pos,
  );

/**
 * The statement CONSTRUCTS this compiler has not built yet, each naming the
 * module it still lives in.
 *
 * Stated as data for two reasons. The differential harness can VERIFY a "not
 * yet" instead of trusting one — a lowering cannot dodge a comparison by
 * claiming to be pending. And the list emptying is what finishing the statement
 * target means, so the work left is countable rather than remembered. A name a
 * ROW could carry belongs in the row's own cell instead; these are constructs,
 * which no row names.
 */
export const PENDING_CONSTRUCTS: Readonly<Record<string, string>> = {
  "a function declaration": "src/codegen.ts",
  "the reducer wrap ('$$ = [{ k: $$.reduce(…) }]')": "src/stream-methods.ts",
  "a read of the stream ('$$.filter(…)') as a value": "src/pipeline.ts",
  "a write to another collection ('$$$.<coll> = …')": "src/out-translation.ts",
};

/** A statement form this compiler does not lower yet. See `PENDING_CONSTRUCTS`. */
export function pendingStatement(what: string, pos: number): CodegenError {
  const livesIn = PENDING_CONSTRUCTS[what];
  if (livesIn === undefined) internalError(`'${what}' is not a stated pending construct`);
  return new PendingLowering(what, "statement", livesIn, pos);
}

/** A stage the server accepts only as the pipeline's first, written after something else. */
export const mustBeFirstStage = (name: string, pos: number): CodegenError =>
  new CodegenError(
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

/** A statement after the stage that writes the pipeline's output. */
export const afterTerminalStage = (already: string, pos: number): CodegenError =>
  new CodegenError(
    `Nothing can follow '${already}': it writes the pipeline's output and the server requires it last. Move this statement above it.`,
    pos,
  );

/** A stage written inside a container its row forbids. */
export const forbiddenInContainer = (name: string, container: string, pos: number): CodegenError =>
  new CodegenError(
    `'${name}' cannot stand inside '${container}' — the server refuses this stage in that body. Run it as a stage of the outer pipeline instead.`,
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

/** `$$ = <something that is not a chain on the stream>`. */
export const notAStreamChain = (pos: number): CodegenError =>
  new CodegenError(
    "'$$ = …' replaces the stream with a chain on it: '$$ = $$.filter(d => d.x > 1).take(10);'. Write the right side as a chain that starts from '$$'.",
    pos,
  );

/** A link in a stream chain whose name is not a method the stream has, nor a stage. */
export const notAStreamLink = (name: string, candidates: readonly string[], pos: number): CodegenError =>
  new CodegenError(
    `'.${name}()' is not a method of the stream '$$'.${didYouMean(name, candidates, (s) => `.${s}()`)} A stage is a link too: '$$.$match(…)'.`,
    pos,
  );

/** A stage cell asked for a callback and the argument is not an arrow. */
export const notAnArrow = (name: string, what: string, got: { type: string; pos: number }): CodegenError =>
  new CodegenError(
    `'.${name}()' takes ${what} as a one-parameter arrow here — 'd => …' — and got ${got.type === "Ident" ? `the name '${(got as { name?: string }).name}'` : "something else"}.`,
    got.pos,
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
    "A read of another DATABASE isn't supported: a '$lookup' joins a collection of the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>.find(…)' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    pos,
  );

/** `{ tags: { $all: [$.x] } }` — a query operator whose expression twin does not take `[field, operand]`. */
export const runtimeInQueryOperator = (op: string, pos: number): CodegenError =>
  new CodegenError(
    `'${op}' compares against a constant in a query document, and this operand is read at run time. Write the test as an expression — '$match($.field …)' — or give '${op}' a constant.`,
    pos,
  );

/** `$$$[$.name].find(…)` — the collection a `$lookup` reads is fixed when the pipeline is written. */
export const collectionNameMustBeConstant = (pos: number): CodegenError =>
  new CodegenError(
    "The collection to join is fixed when the pipeline is written: name it, '$$$.<coll>' or '$$$[\"<coll>\"]'. To choose it at run time, build the pipeline with 'jsmql.compile' and pass the name in.",
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

/** `$$ = [{ a: 1 }, 5]` — a document list holds documents. */
export const notADocumentInList = (noun: string, pos: number): CodegenError =>
  new CodegenError(
    `'$$ = [ … ]' lists the DOCUMENTS the stream starts from, and ${noun} is not a document. Write each as '{ … }'.`,
    pos,
  );
