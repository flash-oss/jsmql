type Slot = unknown;

const isNode = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

const isCarrier = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !isNode(v);

function mapSlot(slot: Slot, fn: (n: object) => object): { value: Slot; changed: boolean } {
  if (Array.isArray(slot)) {
    let changed = false;
    const out = slot.map((el) => {
      const r = mapSlot(el, fn);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed: true } : { value: slot, changed: false };
  }
  if (isNode(slot)) {
    const r = transform(slot, fn);
    return { value: r.value, changed: r.changed };
  }
  if (isCarrier(slot)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(slot)) {
      const r = mapSlot(v, fn);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return changed ? { value: out, changed: true } : { value: slot, changed: false };
  }
  return { value: slot, changed: false };
}

function transform(node: Record<string, unknown>, fn: (n: object) => object): { value: object; changed: boolean } {
  let changed = false;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const r = mapSlot(value, fn);
    if (r.changed) changed = true;
    rebuilt[key] = r.value;
  }
  const withNewChildren = changed ? rebuilt : node;
  const replaced = fn(withNewChildren);
  return { value: replaced, changed: changed || replaced !== withNewChildren };
}

export function mapTree<T extends object>(root: T, fn: (n: object) => object): T {
  return transform(root as Record<string, unknown>, fn).value as T;
}

export type Edge<C> = (node: object, key: string, here: C) => C;

function mapSlotIn<C>(
  slot: Slot,
  ctx: C,
  edge: Edge<C>,
  fn: (n: object, c: C) => object,
): { value: Slot; changed: boolean } {
  if (Array.isArray(slot)) {
    let changed = false;
    const out = slot.map((el) => {
      const r = mapSlotIn(el, ctx, edge, fn);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed: true } : { value: slot, changed: false };
  }
  if (isNode(slot)) return transformIn(slot, ctx, edge, fn);
  if (isCarrier(slot)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(slot)) {
      const r = mapSlotIn(v, ctx, edge, fn);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return changed ? { value: out, changed: true } : { value: slot, changed: false };
  }
  return { value: slot, changed: false };
}

function transformIn<C>(
  node: Record<string, unknown>,
  ctx: C,
  edge: Edge<C>,
  fn: (n: object, c: C) => object,
): { value: object; changed: boolean } {
  let changed = false;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const r = mapSlotIn(value, edge(node, key, ctx), edge, fn);
    if (r.changed) changed = true;
    rebuilt[key] = r.value;
  }
  const withNewChildren = changed ? rebuilt : node;
  const replaced = fn(withNewChildren, ctx);
  return { value: replaced, changed: changed || replaced !== withNewChildren };
}

export function mapTreeIn<C, T extends object>(root: T, seed: C, edge: Edge<C>, fn: (n: object, c: C) => object): T {
  return transformIn(root as Record<string, unknown>, seed, edge, fn).value as T;
}
