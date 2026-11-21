# 0095. One position, one cell, and the cell kinds

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

A row answers per position. Each position requires its renderer, and each renderer requires its position.

## Decision

- Positions and cells: `value` → `expr`; `filter` → `filter` (a native query; a row that omits it does not forbid the filter position, see `ViaFallback`); `stream` → a link in a `$$ = $$…` chain; `statement` → a statement that is never a value; `group` → a `$group` output slot; `window` → `$setWindowFields.output`; `updateDoc` → the update DOCUMENT (the object form of the second argument of `updateOne`). `{ $inc: { quantity: -2 } }` runs there, and the server refuses the same document in a pipeline, because no stage has the name `$inc`. Without this position, `$inc` would have to claim that it is valid nowhere.
- ONE POSITION, ONE CELL, because each pair that shared a cell held opposite answers. `$$.push(...$$$.archive);` is a legal statement (`$unionWith`), and the same call inside a chain is refused. MEASURED: `$rank` is refused in `$group` and accepted in a window; `$mergeObjects` is accepted in `$group` and refused in a window. An accumulator is unary in a `$group` slot and variadic in a window slot (`{ $avg: ["$a", "$b"] }` is refused in `$group`, and `{ $max: ["$a", "$b"] }` runs in a window). So `args` lives on the CELL, never on the entry.
- `SlotPosition`: a stage body slot is one position, or a pair where a BRACKETED LIST means one position and any other shape another. `$merge.whenMatched` takes an update pipeline or one of a set of words.
- `Only`: rules no renderer implies. `stageFirst`, `stageLast`; `update` (one of the stages that an update pipeline accepts, the whitelist of `jsmql.update`; this is the array form, and `updateDoc` is the object form); `afterSort` (a chain link that needs an order that already exists: `$$ = $$.takeWhile(…)` is refused, and `$$ = $$.sortBy("x").takeWhile(…)` runs). There is no `streamEnd`: a link that cannot continue a chain says so in its own `stream` cell.
- `Binds`: the variables that an operator brings into scope, and the keys where they are visible. The compiler applies one scope rule to a developer's `$let` and to a lowering's `$let`, so a minted name keeps clear of a declared one. MEASURED: the server refuses a read of a variable outside `visibleIn` (`$$this` in `$filter.limit`, `$$this` in `$reduce.initialValue`). `keysOf` reads the keys of an object (`$let.vars`, `$lookup.let`). `valueAt` reads the one name at a key, with a `default` (`$map.as`). `fixed` holds names that the operator chooses (`this` and `value` of `$reduce`).
- `Truth`: a brand, not a wrapper. Only the mode module mints one, and every slot that reads a boolean takes one, so a VALUE cannot land in a condition slot by mistake. `$.name ? … : …` tests missing, null, false, `""` and 0; `$cond($.name, …)` hands `"$name"` on as it is; `Boolean($.a > 1)` adds no test, because `>` states `returns: "bool"`.
- `MongoExprIn`: a MongoDB row gets no `truth` and no `predicate`. The `$op(…)` escape hatch keeps MongoDB's truth rules (`""` is true). The JavaScript rules apply to the JavaScript spellings only.
- `FilterOut`: a row that also lists `value` can answer null, which means "wrap the value form in `$expr`" (`$.s.startsWith("A")` gives `{ s: /^A/ }`; `$.s.trim().startsWith("A")` gives null and an `$expr`). A filter-only row has no value form, so its emit is total, and a null there is a type error.
- `Emit` is total. The one null answer is typed on `FilterOut`, so a dispatcher never reads a value renderer's result for a signal.
- `InCode`: the renderer is code, by design, and the cell names the file. The lowering reads its NEIGHBOURS (the operand types of `+`, the truth of the left side of `&&`, the receiver shape of `x[0]`), and one row cannot see them. Its `args` states the operand kinds for HR7, and the compiler reads no count from it, because the pass owns the count.
- `subjectFromCaller` (`because(…)`): the message gives the REASON only, and the caller names the subject. One reason serves every spelling that reaches it (`$$ = $$.toReversed()`: the caller names `.toReversed()` and `$$`). The row states the flag, and no pass guesses it from the first letter of the message.
- `ViaFallback` is not a refusal: `$.s.trim() === "x"` is a legal filter that cannot use an index. It stays separate from `Refusal`, because the two mean opposite things to a user, and a count of these lists the surface that scans.
- `composedInto`: the entry has no native form alone, and it folds into a native form when another entry composes it. `$.a % 2 === 0` gives `{ a: { $mod: [2, 0] } }`, and `$.a % 2 !== 0` gives `{ a: { $not: { $mod: [2, 0] } } }`. The cell lists EVERY owner, because one owner states a true but partial fact. It differs from `viaFallback`, which means no native form in any composition (`$.a[0] === 1` is `$expr`).

## Consequences

A new position needs edits in `Position`, `OutOf`, `CELL_OF` and every spec type (see `src/registry/CLAUDE.md`). Two positions never share a cell.
