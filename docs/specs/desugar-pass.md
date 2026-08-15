# The desugar pass

## Overview

jsmql carries 17 sugar forms — surfaces that look like ordinary JavaScript but
lower to specific pipeline stages. `$ = <expr>` becomes `$replaceWith`,
`$$$.<coll>.find(p)` becomes `$lookup`, `$$.push(…)` becomes `$unionWith`, and
so on.

The desugar pass rewrites every one of them into an explicit AST node, before
any lowering runs. After the pass no sugar remains.

That property is the point. Sugar recognised during lowering must be recognised
by every loop that lowers, and a loop that does not know a form mis-lowers it
silently. Sugar removed by a pass cannot be missed, because by the time any loop
runs there is nothing left to miss.

Each form's own lowering rules stay in its own spec — see
[docs/CLAUDE.md](../CLAUDE.md) for the index. This file owns the pass: what it
recognises, in what order, and the constraints that order must respect.

## The forms

| Form | Trigger | Becomes |
|---|---|---|
| `let` / `const` declaration | `const cutoff = 18;` | a binding node — [let-bindings.md](let-bindings.md) |
| reusable function | `function adult(d) { … }` | a function node — [reusable-functions.md](reusable-functions.md) |
| `let` reassignment | `n = n + 1;` | a rebind node |
| replace root | `$ = { a: 1 };` | `$replaceWith` — [replace-root-stage.md](replace-root-stage.md) |
| root fan-out | `$ = [{ a: 1 }, { a: 2 }];` | a fan-out node |
| root lookup pivot | `$ = $$$.orders.find(…);` | `$lookup` + `$replaceWith` |
| facet | `$ = { hi: $$.filter(…), lo: $$.filter(…) };` | `$facet` — [replace-root-stage.md](replace-root-stage.md) |
| replace stream | `$$ = $$.filter(…);` | `$match` — [replace-stream-stage.md](replace-stream-stage.md) |
| dict-build wrap | `$$ = [{ [d.k]: $$.reduce(…) }];` | a group node — [stream-methods.md](stream-methods.md) |
| object reduce wrap | `$$ = [{ total: $$.reduce(…) }];` | a group node |
| array reduce wrap | `$$ = $$.reduce((a,d) => a.concat(d.items), []);` | a group node |
| foreign source switch | `$$ = $$$.orders.filter(…);` | `$match` + `$unionWith` |
| write out | `$$$.archive = $$;` | `$out` — [out-stage.md](out-stage.md) |
| lookup | `$.o = $$$.orders.find(…);` | `$lookup` — [lookup-stage.md](lookup-stage.md) |
| union | `$$.push({ … });` | `$unionWith` — [union-stage.md](union-stage.md) |
| system source stage | `$$.indexStats();` | a diagnostic stage — [system-stages.md](system-stages.md) |
| guard | `assert(cond, msg);` | a conditional-error `$match` — [assert.md](assert.md) |

## Order constraints

Some forms overlap: one input matches more than one detector. The pass must
resolve those in a fixed order, and each constraint below is load-bearing —
reverse it and the output changes.

**Facet before plain replace-root.** A facet right-hand side also satisfies the
replace-root test, which looks only at the target.

```
$ = { hi: $$.filter(t => t.x > 1), lo: $$.filter(t => t.x <= 1) };
  facet first  → [{"$facet":{"hi":[{"$match":{"x":{"$gt":1}}}],"lo":[{"$match":{"x":{"$lte":1}}}]}}]
  reversed     → throws "'$$' (current collection) is statement-only …"
```

**Write-out before lookup.** The write-out test reads the left-hand side and the
lookup test reads the right-hand side, so an input with both matches both.

```
$$$.dst = $$$.src.find(t => t.a === 1);
  write-out first → "The right-hand side of '$$$.<coll> = …' must be a chain rooted at '$$' …"
  reversed        → an internal error, because the write target is not a field path
```

**Lookup before the general fallback.** The fallback is unconditional, so it
makes the direct lookup form unreachable if it runs first.

```
$.o = $$$.orders.find(o => o.uid === $._id);
  lookup first → 2 stages: $lookup as:"o", then $set {o:{$first:"$o"}}
  reversed     → 4 stages through a scratch slot, plus the trailing $unset
```

**Replace-root and replace-stream before lookup.** Both re-detect a lookup
inside their own right-hand side and place it against their own destination. The
general lookup form would build an empty `as` target.

**System source stages before stream chains.** A system stage call has the same
shape as a one-method stream chain.

```
$$.indexStats();
  system stage first → [{"$indexStats":{}}]
  reversed           → "'.indexStats(...)' is not a chainable stream method on '$$'"
```

## Constraints that hold only by exclusion

The union form and the system-stage form do not overlap, but only because a
hand-maintained set of reserved collection method names keeps them apart. Remove
that set and the pair becomes order-sensitive.

An exclusion list is a coupling between two forms that neither form declares.
The grid removes it: each form declares its own trigger, and an overlap is
resolved by declared precedence rather than by a list one form keeps about
another. See [lowering-grid.md](lowering-grid.md).

## Why a pass and not a hub

Sugar recognised during lowering has to be recognised at every place lowering
begins. jsmql assembles stages from more than one place — the top-level
statement sequence, the bracketed array form, a literal sub-pipeline array, and
each container that lowers a chain.

A form that one of those places does not test for is not rejected. It falls
through to whatever the generic path does with it, which is how a root-replace
inside a literal sub-pipeline can become a `$set` on an empty field path — a
document the server refuses.

The pass removes the class. Every entry to lowering receives a tree with no
sugar in it, so no entry can fail to test for a form.

## Adding a sugar form

1. Declare its trigger shape and the node it rewrites into.
2. If the trigger overlaps an existing form, declare the precedence, and add the
   input that discriminates them to the test suite.
3. Write its spec, and add a row to the index in [docs/CLAUDE.md](../CLAUDE.md).
4. New sugar keeps the destination visible. Root-replacing sugar starts with
   `$ =`; everything else names where the result goes. See
   [replace-root-stage.md](replace-root-stage.md) for the convention.
