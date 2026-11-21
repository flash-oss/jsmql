# 0017. Internal $let and as names never capture a user name

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

Many lowerings bind the receiver in a `$let`, or bind a synthetic callback parameter, and then splice a user expression into the body. An internal name can equal a name that the user gives a lambda parameter or a pipeline binding. Then the spliced `$$name` silently points at the wrong value. The result is wrong values, not an error.

## Decision

- An internal binding name is a gensym against the names in scope. A lambda parameter named `jsmqlArr` pushes the internal binding to `jsmqlArr2`, and the user's name stays the `as`. The common case keeps the base name, so the output stays stable.
- A callback with no parameters still takes an `as` name in the emitted MQL. The compiler gensyms it, so an inner callback does not shadow the outer element: in `$.a.map(v => $.b.map(() => v))`, `$$v` reads the outer element.
- The `.fill(value, start)` lowering builds the value inside a synthetic `(el, idx)` map callback. A pipeline binding with the same name as a synthetic parameter, for example `let x = 5; $.arr.fill(x, 1)`, still reads as 5.
- An iteratee's `$let` must not enclose the `$reduce` accumulator reads. A parameter named `value` would shadow `$$value`, so the dedupe test of `.uniqBy` would read `.seen` off the element, and every element would survive.
- A string lowering such as `.truncate()` or `.endsWith()` binds and coerces the receiver once in a `$let`. It emits the receiver once, not once per use, and an absent field reads as `""`, not as null.

## Consequences

A new lowering that binds a name must draw it from the gensym, never a fixed string. Test each new lowering with a user parameter that has the internal base name.
