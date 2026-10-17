# The constant engine

The fold replaces a constant with its value. This spec states what a constant is, how the engine
computes it, and what goes back into the tree. The fold itself (the names that never fold, the
substitution, the collapse to a Filter) is in [desugar-pass.md](desugar-pass.md) § Constant
folding. The user-facing statement is in
[LANGUAGE.md § Compile-time constants](../LANGUAGE.md#compile-time-constants-folding).

## The definition

A constant is an expression whose LOWERED MQL reads nothing from the document and nothing from
the environment. The engine does not compute with a table of JavaScript methods. It lowers a
closed subtree with the real emitter, gives the MQL to the interpreter, and answers with the
value. So one lowering states the meaning of each JavaScript method, and one rule states the
meaning of each MQL operator. A method and its value cannot drift apart, because the value is
the answer of the MQL that the server would run.

```
const xs = (5).range().map(i => i * i).filter(x => x % 2 === 0); $.total = xs.sum() + xs.size();
  → [{ $set: { total: 23 } }]

const a = (3).range().map(() => 7); $.x = a;
  → [{ $set: { x: [7, 7, 7] } }]
```

## The steps of `evaluate`

`evaluate(node, env)` is in `src/compiler/passes/evaluate.ts`. `env` holds the constants already
known, and the declared functions.

1. **Read.** A literal is its own value. So is a date that the source spells with literal parts
   (`src/compiler/passes/date-literal.ts`), and a value that a call supplied, unless it reads as
   MQL. A `"$…"` string below the top is a field path, so it holds no value (HR1).
2. **Scan.** The engine refuses a subtree that holds the document, a stream or an operator call.
   HR2 says an escape hatch never folds, even inside. The engine also refuses a name that nothing
   binds, a write, a declaration, a pipeline, and a lambda at the root. The lambda names come from `bindsFor`.
3. **Substitute.** A name that `env` binds to a value becomes that value, with the shadowing
   rules of `src/compiler/passes/substitute.ts`. A name that `env` binds to a declared function
   stays, and goes to the lowering as a function.
4. **Settled check.** The engine runs the desugar rules once over the subtree. When one rule
   rewrites it, the engine refuses, and the next round of the fixpoint asks again.
5. **Lower.** The emitter lowers the subtree under a value `Env` with `settling` set. A throw
   means "not constant": the emit phase reports the error later, at the real site, with the real
   position. This includes a kind refusal (HR7), which the emitter raises again at the real site.
6. **Interpret.** `interpret(mql)` gives the value, or refuses, or says that the value has no
   literal. `unspellable` propagates, and the fold reports it at the position of the constant.

The engine also refuses a value larger than a fixed size, and a tree nested deeper than the
stack allows.

## The provided lowering

`evaluate.ts` cannot import the emitter, because the emitter reads constants. So the emitter provides
one function at load: `provideLowering`, called at the foot of `src/compiler/emit/lower.ts`, as
`statement.ts` provides `provideJoin`. The function binds each declared function the way a
declaration binds it, and lowers the node. A program that reaches the engine before the emitter
is loaded is an internal error.

A lowering that only asks for a value has no need of a check that exists to refuse MQL which the
server rejects. `Site.settling` is that fact. A literal zero divisor, for example, is then no error
in the lowering. The interpreter answers `Infinity` or `NaN`, and the fold reports the constant
that has no literal.

A constructor with a constant argument (a BSON number, an ObjectId, a sentinel such as
`MinKey()`) builds the live value in its row (`construct` service of the cell). The server has no
expression for some of these values, so the value goes into the MQL as itself, and the interpreter
passes it through.

## The write-back

The fold writes back EVERY value that the engine computes (`writeBack` in `evaluate.ts`). The
node is the literal that spells the value, so that later rules match on it. When the language has
no spelling for the value, the node is an `Injected` node: a Date, an ObjectId, a Decimal128 or a
Long. A query compares such a node as written, and an expression passes it through. The compiler checks
an ObjectId against the plausibility rule of the literal, so a typo reports at its position.

A node that a lowering builds itself (a stream cell that makes `list.map(key)` from its
arguments) is a node that the fold does not visit. The services that hand a node to the lowering call `settled`.

After the fold, a reader of the emit phase asks only whether a node is a literal. `constantOf` reads
a literal, an `Injected` node, and a list or a document of them. It never lowers.

## What the interpreter refuses

Where the server answer is not exactly specified, the interpreter refuses, and the expression
stays a runtime expression. The rule, the numeric model and the table of refusals are in
[src/compiler/interpret/CLAUDE.md](../../src/compiler/interpret/CLAUDE.md). The numeric model is
in `src/compiler/interpret/values.ts`.

## What never folds

These never fold:

- an escape-hatch call
- a name that its scope writes or mutates
- a name that the source reads before its declaration
- a subtree that reads the document, the clock or a random number
- a callback that reads the document
- a value that no node can carry (`undefined`, a NaN, an infinity)

A declaration whose constant is an infinity or a NaN is a positioned error.
