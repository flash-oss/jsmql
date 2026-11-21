# 0035. Which names the fold may replace, and how a program collapses to a Filter

Status: Accepted
Applies to: `src/compiler/passes/fold.ts`, `src/compiler/passes/substitute.ts`

## Context

The fold (`src/compiler/passes/fold.ts`) replaces a `const` and each constant subexpression with its value. A fold can go wrong in two ways. It can replace a name that means a different variable at that place. It can also replace a name whose value changes. Each wrong fold gives valid MQL with a wrong answer. The fold also decides whether a program with a `const` prelude is a Filter. `docs/specs/desugar-pass.md § Constant folding` states the user-level rules. [ADR 0007](0007-constant-engine-internals.md) records why a declared function stays out of the substitution.

## Decision

- `unfoldable` collects each name that keeps its runtime binding. A name changes value in these ways: a write (`a = 2`), a second declaration (`const a = …` again), a write through a path (`a.p = 9`), and a call that mutates (`a.sort()`), which is a write with no `=`.
- A name that the program reads before its declaration keeps its binding. In JavaScript such a read is a `ReferenceError`. The later value would give the read a meaning that the language does not have. A later phase reports the read.
- A name that a lambda inside a statement binds is not a read of the outer name. So `$.items.some(k => k > 1); const k = 5` folds `k` (`freeNamesIn`).
- The fold does not settle a function whose body reads its own name, or a name that the program declares only later. Its substitution would recurse forever, or would carry a name with no value yet. It stays a binding. The compiler inlines it at each call, and refuses the recursion there. A call of an earlier function folds.
- `unfoldable` walks with positions (`everyNodeWithPosition`). A call that IS a statement (`a.sort();`) mutates its receiver. The same call in a value slot gives a new array and leaves the binding alone. The node shape alone cannot tell the two apart. Without the position, `[xs.slice(1)]` in a value slot reads as a bracketed pipeline of mutations, and the fold keeps a constant that it must replace.
- `foldConstantParts` replaces each constant subexpression with its value. A read of a constant at run time cannot change its answer. For `const o = { a: 1 }; $.x === o.a`, the fold gives `{ x: 1 }`, which can use an index. With no fold the output is an `$expr` with `$getField`, which cannot. A constant that the engine cannot settle stays a runtime expression.
- The environment shrinks at each binder (`bindsFor`). A lambda parameter with the name of a declared function is a different variable. A fold of `f(1)` inside `map(f => f(1))` against the outer `f` gives the wrong answer.
- A computed key with a constant key expression (`{ [k]: 1 }`) folds to the key that JavaScript computes. So a stage rule that takes only a written key (`$sort({ [field]: 1 })`) sees one, and a document literal stays a document.
- The fold does not write a `RegexLiteral` again. A new spelling loses the fact that the call supplied the regex.
- The fold works on one statement at a time (`foldPartsIn`), never on the list around it. A descent through the `Pipeline` node makes `bindsFor` hide the scope's own declarations together with nested ones.
- `NOT_ASKED_TYPES` and `EVALUABLE_TYPES` together cover every `Expr` type. Two type-level lines make a new node type a compile error in `fold.ts`. Without them, the fold silently never asks about a node of the new type. A literal is not asked about, because a new spelling rebuilds the node each round and the fixpoint never settles. A reference, a lambda and a block are not values. The emit phase refuses `NewExpression` (HR8).
- `fold` walks the statements in source order. It substitutes each statement with only what is known at that point (`folded`, the names known so far).
- Each nested statement list is a scope of its own and folds on its own. `$$.aggregate(() => { const a = 2; $match({ b: a }) })` reads 2. An outer constant reaches into a nested list through the substitution, which stops at any binder of the same name.
- The nested fold does not walk the root list. The root pass decides whether the program collapses to one expression. If the nested fold also walked the root, it would do that work first, and the collapse would never happen.
- One expression left after the fold is a Filter, not a pipeline of one predicate. So `const a = 1; $.x === a` gives `{ x: 1 }`. Only an expression collapses. A write or a declaration stays a pipeline, because an unwrap throws away the `;` that the source wrote and gains nothing.
- A name that did not fold leaves `folded` and `env`, so that no later statement reads it as a constant.
- `substitute` (`src/compiler/passes/substitute.ts`) never crosses a binder of the same name: a lambda parameter or a nested declaration is a different variable. It also never replaces an identifier that names something (`namesSomething`): the target of `a.p = 9`, or the callee of `g(1)`. Its value there gives `1 = 9` or `3(1)`, which is not a program.

## Consequences

A new binder node type must answer in `bindsFor`, or constants leak through it. A new `Expr` type must go into one of the two type lists. A change to the collapse rule changes which document a program becomes, so `docs/specs/filter-mode.md` must change with it.
