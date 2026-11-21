import type { Expr, PipelineStmt, Program } from "../../registry/ast.ts";
import type { NodeName } from "../../registry/vocabulary.ts";
import { ParseError } from "../parse/cursor.ts";
import type { Constants } from "./evaluate.ts";
import { asDeclaredFunction, evaluate, writeBack } from "./evaluate.ts";
import { bindsFor, declaredIn } from "./naming.ts";
import type { Where } from "./position.ts";
import { edge, STATEMENT } from "./position.ts";
import { substitute } from "./substitute.ts";
import { mapTree, mapTreeIn } from "./walk.ts";

type Any = { type: string } & Record<string, unknown>;

const isNode = (v: unknown): v is Any =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

function rootName(node: unknown): string | null {
  let cursor = node;
  while (isNode(cursor) && (cursor.type === "MemberAccess" || cursor.type === "IndexAccess")) {
    cursor = cursor.object;
  }
  return isNode(cursor) && cursor.type === "Ident" && typeof cursor.name === "string" ? cursor.name : null;
}

function unfoldable(stmts: readonly PipelineStmt[]): ReadonlySet<string> {
  const excluded = new Set<string>();
  const declared = new Set<string>();
  const readSoFar = new Set<string>();

  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (readSoFar.has(stmt.name)) excluded.add(stmt.name);
    }
    for (const name of freeNamesIn(stmt as Any)) readSoFar.add(name);
  }

  const order = declaredIn(stmts);
  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (declared.has(stmt.name)) excluded.add(stmt.name);
      declared.add(stmt.name);
      const body = (stmt.type === "LetDecl" ? (stmt as Any).value : (stmt as Any).lambda) as Any | undefined;
      const later = new Set(order.slice(order.indexOf(stmt.name)));
      if (body?.type === "Lambda" && [...freeNamesIn(body)].some((n) => later.has(n))) excluded.add(stmt.name);
    }
    for (const [node, where] of everyNodeWithPosition(stmt as Any)) {
      if (node.type === "AssignExpr" || node.type === "DeleteStmt") {
        const name = rootName(node.target);
        if (name !== null) excluded.add(name);
      }
      if (node.type !== "MethodCall") continue;
      if (where.at === "statement") {
        const receiver = rootName(node.object);
        if (receiver !== null) excluded.add(receiver);
      }
    }
  }
  return excluded;
}

function freeNamesIn(stmt: Any): ReadonlySet<string> {
  const out = new Set<string>();
  const step = (node: object, key: string, here: ReadonlySet<string>): ReadonlySet<string> => {
    const names = bindsFor(node, key);
    if (names.length === 0) return here;
    const next = new Set(here);
    for (const n of names) next.add(n);
    return next;
  };
  mapTreeIn(stmt as object, new Set<string>() as ReadonlySet<string>, step, (node, bound) => {
    const n = node as Any;
    if (n.type === "Ident" && typeof n.name === "string" && !bound.has(n.name)) out.add(n.name);
    return node;
  });
  return out;
}

function everyNodeWithPosition(stmt: Any): readonly (readonly [Any, Where])[] {
  const out: (readonly [Any, Where])[] = [];
  mapTreeIn(stmt as object, STATEMENT, edge, (node, where) => {
    out.push([node as Any, where]);
    return node;
  });
  return out;
}

function foldConstantParts<T extends object>(node: T, known: Constants = EMPTY): T {
  const step = (n: object, key: string, here: Constants): Constants => {
    const names = bindsFor(n, key);
    if (names.length === 0) return here;
    const next = new Map(here);
    for (const name of names) next.delete(name);
    return next;
  };

  return mapTreeIn(node, known, step, (inner, env) => {
    const n = inner as Any;
    if (n.type === "KeyValueEntry") {
      const key = n.key as { kind: string; expr?: Expr };
      if (key.kind !== "computed" || key.expr === undefined) return inner;
      const computed = evaluate(key.expr, env);
      return computed.ok && typeof computed.value === "string"
        ? ({ ...n, key: { kind: "static", name: computed.value } } as object)
        : inner;
    }
    if (!EVALUABLE.has(n.type) || n.type === "RegexLiteral") return inner;
    const result = evaluate(n as unknown as Expr, env);
    if (!result.ok) {
      if (result.unspellable !== undefined) throw noLiteralFor(result.unspellable, n.pos as number);
      return inner;
    }
    return writeBack(result.value, n.pos as number) as object;
  });
}

function foldPartsIn(stmts: readonly PipelineStmt[], known: Constants): readonly PipelineStmt[] {
  const out = stmts.map((stmt) => foldConstantParts(stmt as unknown as object, known) as unknown as PipelineStmt);
  return out.some((stmt, i) => stmt !== stmts[i]) ? out : stmts;
}

const EMPTY: Constants = new Map();

const EVALUABLE_TYPES = [
  "UnaryExpr",
  "BinaryExpr",
  "TernaryExpr",
  "TemplateLiteral",
  "MemberAccess",
  "IndexAccess",
  "MethodCall",
  "CallExpression",
] as const;
const NOT_ASKED_TYPES = [
  "NumberLiteral",
  "BigIntLiteral",
  "StringLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "UndefinedLiteral",
  "RegexLiteral",
  "ObjectIdLiteral",
  "Injected",
  "ArrayLiteral",
  "ObjectLiteral",
  "FieldRef",
  "StreamRef",
  "DatabaseRef",
  "ClusterRef",
  "Ident",
  "OperatorCall",
  "Lambda",
  "ExprBlock",
  "NewExpression",
] as const;
type ExprType = Extract<Expr, { type: string }>["type"];
type Covered = (typeof EVALUABLE_TYPES)[number] | (typeof NOT_ASKED_TYPES)[number];
const _everyExprIsDecided: [Exclude<ExprType, Covered>] extends [never] ? true : Exclude<ExprType, Covered> = true;
const _onlyExprTypes: [Exclude<Covered, NodeName>] extends [never] ? true : Exclude<Covered, NodeName> = true;
void _everyExprIsDecided;
void _onlyExprTypes;
const EVALUABLE: ReadonlySet<string> = new Set(EVALUABLE_TYPES);

export function fold(program: Program): Program {
  const foldNested = (node: object): object => {
    const n = node as Any;
    if (n.type !== "Pipeline") return node;
    const inner = foldStatements(n.stmts as readonly PipelineStmt[]);
    const parts = foldPartsIn(inner.stmts, inner.env);
    return inner.changed || parts !== inner.stmts ? ({ ...n, stmts: parts } as object) : node;
  };

  const root = program as Any;
  if (root.type !== "Pipeline") return foldConstantParts(mapTree(program, foldNested) as object) as Program;

  const stmts = (root.stmts as readonly PipelineStmt[]).map(
    (stmt) => mapTree(stmt as unknown as object, foldNested) as unknown as PipelineStmt,
  );

  const top = foldStatements(stmts);
  const original = root.stmts as readonly PipelineStmt[];
  const nestedChanged = stmts.some((stmt, i) => stmt !== original[i]);
  if (!top.changed && !nestedChanged) {
    const parts = foldPartsIn(stmts, top.env);
    if (parts === stmts) return program;
    return { type: "Pipeline", stmts: parts, pos: root.pos as number } as unknown as Program;
  }

  const rewritten = { type: "Pipeline", stmts: foldPartsIn(top.stmts, top.env), pos: root.pos as number } as Any;
  const left = rewritten.stmts as readonly PipelineStmt[];
  if (left.length === 1) {
    const only = left[0] as Any;
    const isStatement = only.type === "UpdateFilter" || only.type === "LetDecl" || only.type === "FuncDecl";
    if (!isStatement) return only as unknown as Program;
  }
  return rewritten as unknown as Program;
}

function foldStatements(stmts: readonly PipelineStmt[]): {
  stmts: readonly PipelineStmt[];
  changed: boolean;
  env: Constants;
} {
  const excluded = unfoldable(stmts);
  const folded = new Map<string, unknown>();
  const env = new Map<string, unknown>();
  const survivors: PipelineStmt[] = [];
  let changed = false;

  for (const stmt of stmts) {
    const resolved =
      folded.size === 0
        ? stmt
        : (
            substitute({ type: "Pipeline", stmts: [stmt], pos: 0 }, folded) as unknown as {
              stmts: readonly PipelineStmt[];
            }
          ).stmts[0];
    if (resolved !== stmt) changed = true;

    if (resolved.type === "FuncDecl" && !excluded.has(resolved.name)) {
      env.set(resolved.name, asDeclaredFunction(resolved.lambda as unknown as object));
      survivors.push(resolved);
      continue;
    }
    if (resolved.type === "LetDecl" && !excluded.has(resolved.name)) {
      const result = evaluate(resolved.value, env);
      if (!result.ok && result.unspellable !== undefined) throw noLiteralFor(result.unspellable, resolved.pos);
      if (result.ok) {
        const at = (resolved.value as { pos: number }).pos;
        writeBack(result.value, at);
        folded.set(resolved.name, result.value);
        env.set(resolved.name, result.value);
        changed = true;
        continue;
      }
    }
    if (resolved.type === "LetDecl" || resolved.type === "FuncDecl") {
      folded.delete(resolved.name);
      env.delete(resolved.name);
    }
    survivors.push(resolved);
  }

  return { stmts: survivors, changed, env };
}

function noLiteralFor(what: string, pos: number): ParseError {
  return new ParseError(
    `This constant expression evaluates to ${what}, which has no MongoDB literal. Check the arithmetic — a division by zero, or an exponent out of range — or guard it with a condition.`,
    pos,
  );
}
