// Vitest shim used by `sync-playground.mjs` to enumerate every `describe()` and `it()` in
// `test/realistic.test.ts` without starting vitest itself. The loader hook (`sync-playground-loader.mjs`)
// resolves the test file's `import { describe, it, expect } from "vitest"` to this module.
// The recorded tree is exposed through the `tree` export and consumed by the sync script.
//
// This code RUNS every `describe(title, fn)` body so nested `describe` and `it` calls register.
// It does NOT run any `it(title, fn)` body. Instead, `fn.toString()` is captured so the sync
// script can inspect the source. This keeps the shim honest (no test assertions ever run)
// while still showing the full test tree.
//
// `expect`, `vi`, and the lifecycle hooks (`beforeAll`, `afterAll`, `beforeEach`, `afterEach`)
// are noop'd through a chained-call Proxy. Any stray usage in an executed describe body does not
// throw. Test-body assertions never reach them because this code does not run `it` bodies.

const root = { kind: "root", children: [] };
const stack = [root];

function pushChild(node) {
  stack[stack.length - 1].children.push(node);
}

/**
 * Resolve the (optional) middle-argument metadata object from vitest's
 * `(name, optionsOrFn, fn)` signature. Return `[meta, fn]` so the caller
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

// Chained-call Proxy. Calls like `expect(x).toEqual(y).not.toBe(z)` do not throw
// if a describe body calls them at module scope.
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
