type Any = { type: string } & Record<string, unknown>;

export function staticKey(entry: object): string | null {
  const key = (entry as Any).key as { kind?: string; name?: string } | undefined;
  return key?.kind === "static" && typeof key.name === "string" ? key.name : null;
}

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

export function isContextRef(node: object): boolean {
  const t = (node as Any).type;
  return t === "StreamRef" || t === "DatabaseRef" || t === "ClusterRef";
}

export function readsAContextRef(node: object): boolean {
  return isContextRef(chainBase(node));
}

export function bindsFor(node: object, key: string): readonly string[] {
  const n = node as Any;
  if (n.type === "Lambda") return (n.params as readonly string[] | undefined) ?? [];
  if (n.type === "ExprBlock") return ((n.decls as readonly Any[] | undefined) ?? []).map((d) => d.name as string);
  if (n.type === "Pipeline" && key === "stmts") return declaredIn(n.stmts);
  if (n.type === "ArrayLiteral" && key === "elements") return declaredIn(n.elements);
  return [];
}

export const declaredIn = (list: unknown): readonly string[] =>
  ((list as readonly Any[] | undefined) ?? [])
    .filter((s) => s?.type === "LetDecl" || s?.type === "FuncDecl")
    .map((s) => s.name as string);

export function introducedNames(node: object): readonly string[] {
  const n = node as Any;
  if (n.type === "Lambda") return (n.params as readonly string[] | undefined) ?? [];
  if ((n.type === "LetDecl" || n.type === "FuncDecl") && typeof n.name === "string") return [n.name];
  return [];
}

export function namesSomething(node: object, key: string): boolean {
  const n = node as Any;
  return (
    ((n.type === "AssignExpr" || n.type === "DeleteStmt") && key === "target") ||
    ((n.type === "CallExpression" || n.type === "NewExpression") && key === "callee")
  );
}

export type AstNode = { type: string; pos: number } & Record<string, unknown>;

export function writtenField(node: object): AstNode | null {
  const recv = (node as Any).object;
  if (!isNode(recv)) return null;
  if (recv.type === "Ident") return recv;
  if (recv.type !== "FieldRef" || recv.path === "") return null;
  return recv;
}

export function couldWriteItsReceiver(node: object): boolean {
  const start = (node as Any).object;
  if (!isNode(start)) return false;
  let recv: AstNode = start;
  while ((recv.type === "MemberAccess" || recv.type === "IndexAccess") && isNode(recv.object)) {
    recv = recv.object;
  }
  return writtenField({ object: recv }) !== null;
}

function isNode(v: unknown): v is AstNode {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";
}
