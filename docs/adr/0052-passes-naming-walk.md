# 0052. Binders, minted parameter names, and the context walk (naming.ts, fresh.ts, walk.ts)

Status: Accepted
Applies to: `src/compiler/passes/fresh.ts`, `src/compiler/passes/naming.ts`, `src/compiler/passes/walk.ts`

## Context

Every pass asks which names a node binds and where a node stands. `src/compiler/passes/naming.ts` answers the binder questions once. `src/compiler/passes/fresh.ts` mints a lambda parameter that cannot capture a name. `src/compiler/passes/walk.ts` carries a context down the tree. A wrong answer in any of them gives valid MQL with a wrong answer.

## Decision

- `bindsFor` lists every binder, not only lambdas and blocks. A `Pipeline` binds every name that it declares: `$$.aggregate(() => { const a = 2; … })` is a scope of its own. A block binds its declarations for later declarations as well as for its result. A nested statement list is a scope: a `;` run under `stmts`, or a bracketed sub-pipeline under `elements` (`declaredIn`). If a pass misses a binder, an outer constant goes through an inner declaration of the same name. The answer is then wrong, and the inner declaration stays in place, unread.
- `introducedNames` gives the names that a node introduces on its own: the parameters of a lambda, or the name of a declaration. This is a different set from the names that a node binds for a subtree.
- `namesIn` (fresh.ts) counts the parameters of an inner lambda as mentions, through `introducedNames`. A new parameter that shadows one changes which binding the body of the inner lambda sees.
- `freshParam` gives `base` when nothing uses it, else `base` with the lowest free suffix, from 2. So the common answer is the bare name. A shorthand such as `$.items.map("name")` reads as `x => x.name`, and its MQL reads as `$$x`, not as a compiler name.
- `writtenField` returns an `Ident` receiver as is. The receiver is a binding or a callback parameter, and the emitter judges whether the write is legal.
- `mapTreeIn` gives each element of a list the context of its parent, so `stmts[0]` and `stmts[1]` stand alike.
- `transformIn` asks `edge` with the ORIGINAL node, before any child changes. A context that depends on a rewritten child differs between rounds of the desugar fixpoint.

## Consequences

A new node type that binds a name must answer in `bindsFor` and `introducedNames`. A change to `edge` must not read a rewritten child. `freshParam` must keep the bare name as the first choice, because the emitted variable names are part of the readable output.
