// Two spellings of one meaning differ only in the names the compiler chose for
// its own bindings. To compare them, rename every binding to the order it is
// introduced — structure-identical trees introduce bindings in the same order,
// so the numbering is stable while a sort by name is not.
//
// A structural walk, not a string substitution: `$$value` is MongoDB's own and
// must survive, and a `{k, v}` pair inside `$arrayToObject` is data, not a scope.

/** MongoDB's own variables. Never renamed, never shadowed by a compiler binding. */
const MONGO = new Set([
  "this",
  "value",
  "ROOT",
  "CURRENT",
  "NOW",
  "CLUSTER_TIME",
  "REMOVE",
  "DESCEND",
  "PRUNE",
  "KEEP",
  "SEARCH_META",
  "USER_ROLES",
]);

/** The operators that bind a name in `as`, and read it in their body. */
const BINDS_AS = new Set(["$map", "$filter", "$reduce", "$sortArray", "$zip", "$anyElementTrue", "$allElementsTrue"]);

export function canon(mql: unknown): string {
  const scope = new Map<string, string>();
  let next = 0;
  const intro = (name: string): string => {
    if (MONGO.has(name)) return name;
    if (!scope.has(name)) scope.set(name, `B${next++}`);
    return scope.get(name) as string;
  };
  const readPath = (s: unknown): unknown => {
    if (typeof s !== "string" || !s.startsWith("$$")) return s;
    const [head, ...rest] = s.slice(2).split(".");
    const mapped = MONGO.has(head) ? head : (scope.get(head) ?? head);
    return "$$" + [mapped, ...rest].join(".");
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "string") return readPath(node);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$let" && value !== null && typeof value === "object") {
        // The vars are introduced BEFORE `in` is read, in written order.
        const let_ = value as { vars?: Record<string, unknown>; in?: unknown };
        const vars: Record<string, unknown> = {};
        for (const [n, v] of Object.entries(let_.vars ?? {})) vars[intro(n)] = walk(v);
        out.$let = { vars, in: walk(let_.in) };
        continue;
      }
      const bound = value as { as?: unknown } | null;
      if (BINDS_AS.has(key) && bound !== null && typeof bound === "object" && typeof bound.as === "string") {
        const renamed: Record<string, unknown> = { ...(bound as Record<string, unknown>), as: intro(bound.as) };
        out[key] = Object.fromEntries(Object.entries(renamed).map(([k, v]) => [k, k === "as" ? v : walk(v)]));
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  };
  return JSON.stringify(walk(mql));
}
