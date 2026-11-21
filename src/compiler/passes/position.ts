import type { Position } from "../../registry/vocabulary.ts";
import type { BodyPath, BodySlot } from "../rows.ts";
import { blockBodyOf, bodySlotAt, isStageName } from "../rows.ts";
import { chainBase, isContextRef, namedRow, namesSomething, readsAContextRef, staticKey } from "./naming.ts";

export type Where =
  | { at: Position; written?: { stage: string; path: BodyPath } }
  | { at: "target" }
  | { at: "stageBody"; stage: string; path: BodyPath }
  | { at: "stageEntry"; stage: string };

export const STATEMENT: Where = { at: "statement" };
export const VALUE: Where = { at: "value" };
export const STREAM: Where = { at: "stream" };
export const FILTER: Where = { at: "filter" };
export const WINDOW: Where = { at: "window" };
export const UPDATE_DOC: Where = { at: "updateDoc" };
export const TARGET: Where = { at: "target" };

type Any = { type: string } & Record<string, unknown>;

const stageMayStand = (here: Where): boolean => here.at === "statement" || here.at === "stream";

function reached(stage: string, path: BodyPath, slot: BodySlot, child: unknown): Where {
  const type = typeof child === "object" && child !== null ? (child as Any).type : undefined;
  if (slot.deeper && type === "ObjectLiteral") return { at: "stageBody", stage, path };
  const at = type === "ArrayLiteral" ? slot.at : slot.otherwise;
  return at === "value" && !slot.evaluated ? { at, written: { stage, path } } : { at };
}

export function edge(node: object, key: string, here: Where): Where {
  const n = node as Any;

  if (n.type === "Pipeline" && key === "stmts") return here.at === "updateDoc" ? here : STATEMENT;

  if (n.type === "UpdateFilter" && key === "ops") return here.at === "updateDoc" ? here : STATEMENT;

  if (n.type === "ArrayLiteral" && key === "elements" && here.at === "statement") return STATEMENT;

  if ((n.type === "OperatorCall" || n.type === "MethodCall") && key === "args") {
    const onStream = n.type === "MethodCall" && readsAContextRef(n.object as object);
    if (stageMayStand(here) || onStream) {
      const stage = namedRow(n);
      if (stage !== null && isStageName(stage)) {
        const slot = bodySlotAt(stage, []);
        if (slot !== undefined) return reached(stage, [], slot, (n.args as readonly unknown[] | undefined)?.[0]);
      }
    }
    if (n.type === "MethodCall" && typeof n.name === "string" && blockBodyOf(n.name) === "stages") return STATEMENT;
  }
  if (n.type === "ObjectLiteral" && key === "entries" && stageMayStand(here)) {
    const stage = namedRow(n);
    if (stage !== null && isStageName(stage)) return { at: "stageEntry", stage };
  }
  if (here.at === "stageEntry") {
    if (n.type !== "KeyValueEntry") return here;
    if (key !== "value") return VALUE;
    const slot = bodySlotAt(here.stage, []);
    return slot === undefined ? VALUE : reached(here.stage, [], slot, n.value);
  }
  if (here.at === "stageBody") {
    if (n.type === "ObjectLiteral") return here;
    if (n.type === "KeyValueEntry") {
      if (key !== "value") return here;
      const path: BodyPath = [...here.path, staticKey(n)];
      const slot = bodySlotAt(here.stage, path);
      return slot === undefined ? VALUE : reached(here.stage, path, slot, n.value);
    }
  }

  if (namesSomething(n, key)) return TARGET;

  if (n.type === "AssignExpr" && key === "value") {
    const target = n.target as Any;
    if (target.type === "StreamRef") return STREAM;
  }

  if ((n.type === "MethodCall" || n.type === "MemberAccess" || n.type === "IndexAccess") && key === "object") {
    const receiver = n.object as Any;
    if (isContextRef(chainBase(receiver))) {
      return receiver.type === "DatabaseRef" || receiver.type === "ClusterRef" ? VALUE : STREAM;
    }
  }

  if (here.at === "updateDoc") return here;

  if (here.at === "value" && here.written !== undefined) {
    if (n.type !== "KeyValueEntry" || key !== "value") return here;
    const { stage, path } = here.written;
    return { at: "value", written: { stage, path: [...path, staticKey(n)] } };
  }

  return VALUE;
}
