// What a node NAMES, and what it BINDS — answered once, for every pass.
//
// "Which row does this node name?" and "which node types bind a name?" are each
// answered in ONE place. Spread across the passes that ask them, each answer would
// be a node-type list of its own — right on the day it was written and
// wrong the day a node type was added, silently — the walk in walk.ts is
// reflective precisely so that no pass has to enumerate node types, and these
// lists reintroduced the enumeration. So each fact is stated here once.

type Any = { type: string } & Record<string, unknown>;

/** The static key an object entry was written with, or null if computed. */
export function staticKey(entry: object): string | null {
  const key = (entry as Any).key as { kind?: string; name?: string } | undefined;
  return key?.kind === "static" && typeof key.name === "string" ? key.name : null;
}

/**
 * The row a node names, or null when it names none.
 *
 * `$.items.sort()` names `sort`, `$match(…)` names `$match`, `$$.$match(…)`
 * names `$match` through its method, `assert(…)` names `assert`, and
 * `{ $match: … }` names `$match` through its single key — that last one is raw
 * MQL pasted in, which the language accepts as itself (HR2).
 */
export function namedRow(node: object): string | null {
  const n = node as Any;
  if (n.type === "MethodCall" || n.type === "OperatorCall") {
    return typeof n.name === "string" ? n.name : null;
  }
  if (n.type === "CallExpression") {
    const callee = n.callee as { type?: string; name?: string } | undefined;
    return callee?.type === "Ident" && typeof callee.name === "string" ? callee.name : null;
  }
  if (n.type === "ObjectLiteral") {
    const entries = n.entries as readonly object[] | undefined;
    if (entries?.length !== 1) return null;
    const key = staticKey(entries[0]);
    return key !== null && key.startsWith("$") ? key : null;
  }
  return null;
}

/**
 * The node a chain of accesses bottoms out in: `$$.a.b(…)[0]` → the `$$`.
 *
 * Every node whose `object` property is its receiver is walked through — a
 * member access, an index, a call — so `$$$["archive"].find(…)` reaches the
 * same base as `$$$.archive.find(…)`. A reader that walked two of the three
 * gave two different documents for one collection.
 */
export function chainBase(node: object): object {
  let cursor = node as Any;
  while (
    (cursor.type === "MethodCall" || cursor.type === "MemberAccess" || cursor.type === "IndexAccess") &&
    typeof cursor.object === "object" &&
    cursor.object !== null
  ) {
    cursor = cursor.object as Any;
  }
  return cursor;
}

/** Is this node one of the three context references — `$$`, `$$$`, `$$$$`? */
export function isContextRef(node: object): boolean {
  const t = (node as Any).type;
  return t === "CollectionRef" || t === "DatabaseRef" || t === "ClusterRef";
}

/**
 * Does this chain read from a context reference?
 *
 * `$$.take(10)` and `$$.$sort({ a: -1 }).take(3)` are streams however they end,
 * because what they read is the stream.
 */
export function readsAContextRef(node: object): boolean {
  return isContextRef(chainBase(node));
}

/**
 * Every name `node` binds for the subtree under its property `key`.
 *
 * All of them, not the obvious two. A `Pipeline` binds every name declared
 * anywhere in it — `$$.aggregate(() => { const a = 2; … })` is a scope of its
 * own — and a block binds its declarations for the later declarations as well as
 * for the result. Missing either one lets an outer constant be pushed through an
 * inner declaration of the same name, which answers with the wrong value and
 * leaves the inner declaration standing, unread, one line above.
 */
export function bindsFor(node: object, key: string): readonly string[] {
  const n = node as Any;
  if (n.type === "Lambda") return (n.params as readonly string[] | undefined) ?? [];
  if (n.type === "ExprBlock") return ((n.decls as readonly Any[] | undefined) ?? []).map((d) => d.name as string);
  // A nested statement list is a scope: a `;`-run, or a bracketed sub-pipeline.
  if (n.type === "Pipeline" && key === "stmts") return declaredIn(n.stmts);
  if (n.type === "ArrayLiteral" && key === "elements") return declaredIn(n.elements);
  return [];
}

/** The names a statement list declares. */
export const declaredIn = (list: unknown): readonly string[] =>
  ((list as readonly Any[] | undefined) ?? [])
    .filter((s) => s?.type === "LetDecl" || s?.type === "FuncDecl")
    .map((s) => s.name as string);

/**
 * The names a node INTRODUCES on its own — a lambda's parameters, a
 * declaration's name — as opposed to the names it binds for a subtree.
 * `namesIn` (fresh.ts) reads this so a minted parameter never shadows one.
 */
export function introducedNames(node: object): readonly string[] {
  const n = node as Any;
  if (n.type === "Lambda") return (n.params as readonly string[] | undefined) ?? [];
  if ((n.type === "LetDecl" || n.type === "FuncDecl") && typeof n.name === "string") return [n.name];
  return [];
}

/**
 * Two places an identifier NAMES something instead of valuing it: the left of a
 * write, and the callee of a call. Replacing either with a value produces
 * something that is not a program — `1 = 9`, or `3(1)` — and neither is a
 * position a row can be legal in.
 */
export function namesSomething(node: object, key: string): boolean {
  const n = node as Any;
  return (
    ((n.type === "AssignExpr" || n.type === "DeleteStmt") && key === "target") ||
    ((n.type === "CallExpression" || n.type === "NewExpression") && key === "callee")
  );
}

/** Any AST node, seen as the two properties every node carries. */
export type AstNode = { type: string; pos: number } & Record<string, unknown>;

/**
 * The field a mutator on `node` writes back to, or null when it has none.
 *
 * A field PATH and nothing else: MQL writes a path, so `$.items[0].push(1)` and
 * `$.items.filter(p).sort()` have no destination. `$$` lands here too, and
 * declining it is what keeps `$$.push(…)` ($unionWith) and `$$.sort(…)` ($sort)
 * out of a rule meant for fields.
 *
 * Read AFTER the field-path fold, which is what makes `$.a.b.sort()` arrive here
 * with a single `FieldRef("a.b")` receiver. Before the fold the question is
 * `couldWriteItsReceiver`, below.
 */
export function writtenField(node: object): AstNode | null {
  const recv = (node as Any).object;
  if (!isNode(recv)) return null;
  if (recv.type === "Ident") return recv; // a binding or a callback parameter: the emitter judges the write
  if (recv.type !== "FieldRef" || recv.path === "") return null;
  return recv;
}

/**
 * Could a mutator on `node` write its receiver — is that receiver a PLACE?
 *
 * The same question as `writtenField`, asked one phase earlier, where `$.a.b` is
 * still a chain of accesses and not yet the path it folds to. So the chain is
 * walked to its base, and only an access link is walked through: a call in the
 * middle (`$.items.filter(p).sort()`) makes a fresh array, and a fresh array is
 * a VALUE, whatever the row says the name does.
 *
 * It answers yes wherever the fold MIGHT reach a path, which is wider than the
 * set the fold really reaches. That direction is the safe one: a receiver
 * admitted here and declined there is refused by name on the statement road,
 * while the reverse would read a whole program as the wrong document.
 */
export function couldWriteItsReceiver(node: object): boolean {
  const start = (node as Any).object;
  if (!isNode(start)) return false;
  let recv: AstNode = start;
  while ((recv.type === "MemberAccess" || recv.type === "IndexAccess") && isNode(recv.object)) {
    recv = recv.object;
  }
  return writtenField({ object: recv }) !== null;
}

/** Is this value an AST node? */
function isNode(v: unknown): v is AstNode {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";
}
