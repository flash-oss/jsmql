const root = { kind: "root", children: [] };
const stack = [root];

function pushChild(node) {
  stack[stack.length - 1].children.push(node);
}

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
