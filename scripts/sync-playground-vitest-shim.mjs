// Vitest shim used by `sync-playground.mjs` to enumerate every `describe()`
// / `it()` in `test/realistic.test.ts` without booting vitest itself. The
// loader hook (`sync-playground-loader.mjs`) resolves the test file's
// `import { describe, it, expect } from "vitest"` to this module; the
// recorded tree is exposed via the `tree` export and consumed by the sync
// script.
//
// We RUN every `describe(title, fn)` body so nested `describe` / `it` calls
// register, but we do NOT run any `it(title, fn)` body — `fn.toString()` is
// captured so the sync script can inspect the source. That keeps the shim
// honest (no test assertions ever execute) while still surfacing the full
// test tree.
//
// `expect`, `vi`, and the lifecycle hooks (`beforeAll`, `afterAll`,
// `beforeEach`, `afterEach`) are noop'd through a chained-call Proxy so any
// stray usage in an executed describe body doesn't throw. Test-body
// assertions never reach them (we don't run `it` bodies).

const root = { kind: "root", children: [] };
const stack = [root];

function pushChild(node) {
  stack[stack.length - 1].children.push(node);
}

/**
 * Resolve the (optional) middle-arg metadata object from vitest's
 * `(name, optionsOrFn, fn)` signature. Returns `[meta, fn]` so the caller
 * can record metadata uniformly regardless of which form the user wrote.
 */
function splitMetaAndFn(arg2, arg3) {
  if (typeof arg2 === "function") return [null, arg2];
  if (typeof arg2 === "object" && arg2 !== null) return [arg2, typeof arg3 === "function" ? arg3 : null];
  return [null, typeof arg3 === "function" ? arg3 : null];
}

export function describe(title, arg2, arg3) {
  const [meta, fn] = splitMetaAndFn(arg2, arg3);
  const node = { kind: "describe", title, meta, children: [] };
  pushChild(node);
  if (fn) {
    stack.push(node);
    try {
      fn();
    } finally {
      stack.pop();
    }
  }
}
describe.only = describe;
describe.skip = () => {};
describe.todo = () => {};

export function it(title, arg2, arg3) {
  const [meta, fn] = splitMetaAndFn(arg2, arg3);
  pushChild({
    kind: "it",
    title,
    meta,
    source: typeof fn === "function" ? Function.prototype.toString.call(fn) : null,
  });
}
it.only = it;
it.skip = () => {};
it.todo = () => {};

// Chained-call Proxy so `expect(x).toEqual(y).not.toBe(z)` shapes don't
// throw if a describe body happens to call them at module scope.
const chain = new Proxy(() => chain, {
  get() {
    return chain;
  },
});

export const expect = () => chain;
expect.objectContaining = () => chain;
expect.arrayContaining = () => chain;
expect.any = () => chain;
expect.anything = () => chain;
expect.stringMatching = () => chain;
expect.stringContaining = () => chain;
expect.assertions = () => {};
expect.hasAssertions = () => {};

export const beforeAll = () => {};
export const afterAll = () => {};
export const beforeEach = () => {};
export const afterEach = () => {};

export const vi = {
  fn: () => chain,
  mock: () => {},
  unmock: () => {},
  spyOn: () => chain,
  resetAllMocks: () => {},
  clearAllMocks: () => {},
  restoreAllMocks: () => {},
  useFakeTimers: () => chain,
  useRealTimers: () => chain,
};
export const vitest = vi;

export const tree = root;
