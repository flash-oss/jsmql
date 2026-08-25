// A transform over the tree, used by every pass that rewrites it.
//
// REFLECTIVE on purpose. The tree has 35 node types and a hand-written switch
// over them would compile fine while silently skipping whichever one a later
// commit adds — the same failure that let `NodeName` drift from the shapes it
// described. Walking own properties cannot skip a node, because it never names
// one.
//
// Bottom-up: children are rewritten before their parent, so a rule sees a
// subtree that is already reduced and never has to recurse itself.

/** Anything the tree holds: a node, a list, or a leaf. */
type Slot = unknown;

const isNode = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

/** A plain object that is part of the tree without being a node — an ObjectKey. */
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
    // A carrier holds nodes without being one — `{ kind: "computed", expr }`.
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

/**
 * Rewrite every node, children first. `fn` returns its argument unchanged to
 * leave a node alone, or a new node to replace it.
 *
 * Returns the SAME object when nothing changed, so a caller can compare by
 * identity to know whether another round is needed.
 */
export function mapTree<T extends object>(root: T, fn: (n: object) => object): T {
  return transform(root as Record<string, unknown>, fn).value as T;
}

// ── the same walk, carrying an inherited value down ──────────────────────────
//
// A rule that must know WHERE a node sits cannot be handed a set of nodes to
// look up: this walk rebuilds a parent as soon as one of its children changes,
// so by the time the rule runs the object it holds is not the object anyone
// recorded. The position has to arrive with the node, computed on the way down.

/** What edge the walk is about to take: from `node`, along its property `key`. */
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
      // A list shares its parent's context: `stmts[0]` and `stmts[1]` sit alike.
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
    // The edge is consulted with the ORIGINAL node, before any child moved: a
    // context that depended on a rewritten child would differ between rounds.
    const r = mapSlotIn(value, edge(node, key, ctx), edge, fn);
    if (r.changed) changed = true;
    rebuilt[key] = r.value;
  }
  const withNewChildren = changed ? rebuilt : node;
  const replaced = fn(withNewChildren, ctx);
  return { value: replaced, changed: changed || replaced !== withNewChildren };
}

/**
 * `mapTree`, plus a value that flows DOWN the tree.
 *
 * `edge` says what the context becomes along one parent-to-property step; `fn`
 * receives each node together with the context that reached it. Same identity
 * guarantee as `mapTree`: the root comes back unchanged when no rule fired.
 */
export function mapTreeIn<C, T extends object>(root: T, seed: C, edge: Edge<C>, fn: (n: object, c: C) => object): T {
  return transformIn(root as Record<string, unknown>, seed, edge, fn).value as T;
}
