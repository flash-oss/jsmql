# 0120. The mongoose plugin tests use a mock Model, not a real connection

Status: Accepted
Applies to: `test/mongoose.test.ts`

## Context

The plugin in `src/mongoose.ts` patches static methods of `mongoose.Model`. A unit test must see the arguments that the original static receives after the plugin transforms them. A real mongoose Model needs a connection and hides those arguments.

## Decision

`test/mongoose.test.ts` builds a mock with `buildMockMongoose()`. The mock holds only the shape the plugin reads: `mongoose.Model` with the static methods the plugin patches. Each mock static records its method name, its arguments and its `this` value in `recorded`. A test then asserts on the arguments the original method got.
A subclass test relies on the prototype chain. The lookup reaches the patched static, so it runs with the subclass as `this`. Real mongoose behaves the same way, so the mock is faithful here.
The idempotence test reads the patched statics directly. A second wrap does not show in the output: the outer wrapper lowers the string, and the inner wrapper passes the lowered object through. So the test compares each static after the second call of the plugin with the static after the first call. Each static must stay the same function, with no second wrapper.

## Consequences

A new patched static needs a matching mock static in `buildMockMongoose()`. The type-level checks against the real mongoose types stay in `test/types/mongoose-augmentation.ts` (see docs/specs/mongoose-plugin.md). A double-wrap check must compare function identity, not output.
