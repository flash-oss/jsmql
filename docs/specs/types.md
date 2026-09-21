# The type tracker

The compiler proves a type for every value it touches: a field the program
writes, a `let`, a callback parameter, a call's result. It carries that proof to
every later read, and each consumer emits the smallest document the proof allows.
This spec is the single source of truth for the model, the sources of a proof, the
rules that combine two proofs, and each consumer's rule. The user-facing rule and
its examples live in [LANGUAGE.md § Type-aware dispatch](../LANGUAGE.md#type-aware-dispatch).

A proof is never a guess. The compiler answers `ANY` wherever the registry and the
program cannot show a type, and a consumer then emits the runtime form it emits
today. So the tracker only ever removes a test that cannot fail; it never adds an
assumption.

## The model

`Type` in [src/registry/vocabulary.ts](../../src/registry/vocabulary.ts) is one
record for every proof:

| Field | Holds |
|---|---|
| `kinds` | The set of `Kind` values the value can have, or `"any"` when nothing is proven. A set, because `c ? "a" : [1]` is a string or an array, and a dispatch over two kinds still beats a dispatch over every kind. |
| `absent` | `true` when the value may be null or missing. One flag for both: every guard the compiler writes folds the two with `$ifNull`, and the truthiness rule reads them alike. |
| `element` | What one element is, when `kinds` holds `array`. |
| `items` | What each position holds, when the array has a fixed length — an `.entries()` pair. |
| `props` | The properties the compiler has seen, when `kinds` holds `object`. |
| `open` | `true` when the object may hold properties `props` does not name. |
| `values` | What a property `props` does not name holds, when `open` — a `.groupBy()` record. |

Three proofs have names in [src/compiler/emit/type.ts](../../src/compiler/emit/type.ts):
`ANY` (nothing known), `NOTHING` (certainly null or missing: a `null` literal, a
closed object's property nobody wrote), and `DOCUMENT` (a present, open object
nothing else is known about: the root document, a foreign collection's document).

### The algebra

`type.ts` holds every operation over two proofs. It reads no node and no row.

- **`join(a, b)`** — one of `a` or `b`: the branches of a `? :`, the operands of
  `??`, `&&` and `||` read as values. The kinds unite, `absent` is either's,
  elements and properties join pairwise. A branch that is `NOTHING` makes the
  other maybe-absent.
- **`merge(a, b)`** — `{ ...a, ...b }`: `b`'s properties win. An open `b` may hold
  any of `a`'s names, so those join with `b`'s unnamed value. A `b` that may be
  absent spreads as `{}`, so its properties may be missing. MEASURED:
  `$mergeObjects` skips a null operand.
- **`propOf(t, name)`** — property `name` of a value. A closed object without it
  holds `NOTHING`. A value that may be an array reads the property of every
  element, as an array: MEASURED, `"$a.b"` over `a: [{ b: 1 }, { b: 2 }]` is
  `[1, 2]`. So `propOf` joins the object's property with an array of the element's.
- **`at(doc, path)`** — `propOf` along a dotted path; `""` is the document.
- **`written(doc, path, value)`** and **`removed(doc, path)`** — the write rules below.
- **`evaluate(expr, site)`** — a row's `returns` term at one call site, below.

## The sources

### The document

`Env.documents` holds one document `Type` per document level: index 0 is the root
pipeline's document, and each body over another collection (`$lookup`,
`$graphLookup`) adds one, the same levels `Binding.level` counts. A `FieldRef`
reads level 0 at every depth, because `$` is the root document (HR4). A
document-kind binding (a stream callback's parameter) reads its own level.

**The write rules.** The statement target records each write of `$.<path> = v`
on the document, right after the write, so the next op in the same statement and
every later statement read it. The `$set` grouping already ends a group when a
later write reads a path an earlier write touched, so the proof and the stage
order agree.

1. **A whole-field write replaces the field's proof.** `$.a = <string>` makes `a`
   a string, with the value's `absent`, and any properties recorded under `a` are
   gone.
2. **A dotted write keeps the parent's other properties.** `$.address.full = <s>`
   makes `address` a present object, open when it was not known, with `full` set
   inside it. MEASURED with `{ $set: { "a.b": 1 } }`: a scalar, null or missing `a`
   becomes `{ b: 1 }`; an object `a` keeps its other fields; an **array** `a` gets
   `b` written into every element, so `[1, 2]` becomes `[{ b: 1 }, { b: 1 }]`. So
   a dotted write into a parent that may be an array proves the parent an object
   OR an array whose elements carry the property, and a read of `a.b` then proves
   a number or an array of numbers.
3. **`delete $.a`** removes the property. On an open document the property becomes
   `NOTHING`; on a closed one it is gone.
4. **A write of a join** (`$.o = $$$.c.filter(p)`) proves `o` a present array of
   documents, because the server always writes the `as` array; a `.find` may find
   nothing, so it proves a maybe-absent document.
5. **A stage that replaces the document** takes every proof about it away: the
   document on that level is `DOCUMENT` again. The same reset runs inside a
   statement, so a write after `$ = …` in the same statement lands on a fresh
   document. Which stages replace the document is the `document` fact below.

### A binding

`Binding.type` carries what the value proved. A `let` or `const` takes its
value's proof. `x = <value>` on a `let` gives it the new value's proof from that
statement on: JSMQL has no `if` and no loop at statement level, so a binding's
type is one straight line. A `let` a document-replacing stage dropped and then
assigned again is revived with the new value's proof.

A callback parameter takes the receiver's element proof through the row's
`binds`. A declared function is inlined per call, so its parameter takes the
argument's proof at that call. A parameter is never proven present: `$$x` is
bound to the value, and the value may be null.

### A row's `returns`

A row states its result as a `TypeExpr`, a closed data grammar the compiler
evaluates at the call site. The terms and their meaning are documented on the type
in [vocabulary.ts](../../src/registry/vocabulary.ts); `evaluate` in `type.ts` is
the one reader. A term is data, not a function, so
[test/compiler-returns-agrees.test.ts](../../test/compiler-returns-agrees.test.ts)
measures its top kind on mongod, the registry audits read it, and the globals
generator can turn it into a TypeScript signature. A row whose result no term
describes states `"unknown"`.

The receiver's family picks the term of a per-family map. For an **unproven**
receiver the call is on one of the families the row names, or the server raises
an error; so the result is the row's answers over its field families, joined.
`.size()` is a number on an array and on an object, so it is a number; a receiver
that may be several kinds proves several.

### Presence

A proof's `absent` flag comes from the row or the source where either states it
(`statedPresence` in [prove.ts](../../src/compiler/emit/prove.ts)): a literal is
present; a call is present when its row states `neverNull` and its receiver and
value arguments are present; an `Injected` value is present unless it is null. A
`? :` is present when both branches are; a property read carries the object's
proof; a binding carries what its value proved. `a ?? b` is present exactly when
`b` is. MEASURED: `{ $size: null }` and `{ $in: [x, null] }` abort the command, so
a cell guards with `$ifNull` exactly where the proof says `absent`.

### The document after a stage

Every stage row states a `document` fact, from the `DocumentEffect` vocabulary:
`keeps`, `fields`, `value`, `projection`, `element`, `unknown`. `StageFacts` in
[names.ts](../../src/registry/names.ts) pairs it with `body` at the type level, so
a stage row cannot omit it. The scope tracker drops every field-carried binding,
resets the document proof and skips the trailing namespace cleanup after a stage
whose effect is `fields`, `value` or `unknown`, and after a `projection` that
names fields to keep. MEASURED: a `let` binding survived `{ $project: { x: 0 } }`
and went away under `{ $project: { x: 1 } }`.

## The consumers

### The dispatch

`receiverOf` in [lower.ts](../../src/compiler/emit/lower.ts) hands `select.ts`
the receiver's proof as a closed `Receiver`:

- one field family → `value`: the row's cell for that family runs, with no test;
- several kinds → `opaque` with `possible` (the field families among them),
  `exact` (does `possible` name every kind?) and `present`;
- a kind no family covers (`bool`, `objectId`) → `opaque` with `proved`, and every
  field-family row refuses it, naming what it takes;
- nothing proven → `opaque`, today's full runtime dispatch.

`fromPerFamily` in [select.ts](../../src/compiler/emit/select.ts) then applies four rules:

1. **Branches for the possible families only.** The dispatch runs over the row's
   families that the receiver can be, in the row's order.
2. **The default only when it can fire.** A dispatch is `complete` when the value
   is present and every kind it can be has a branch. A complete dispatch is a
   `$switch` with **no `default`**. It is never a `$cond`: MEASURED, the server
   optimises a `$cond`'s branches before it reads the test, so
   `{ $cond: [<is array>, { $size: v }, { $strLenCP: v }] }` over a constant `v`
   (a `$let` variable, a `$literal`) fails with "Failed to optimize pipeline", while
   the same branches under `$switch` run on every receiver (`switchOver` in
   [mql.ts](../../src/compiler/emit/mql.ts)).
3. **Refuse at compile time only when no possible kind is accepted.** `$.b.trim()`
   after `$.b = $.arr.includes("x")` is a compile error. A partial overlap is not:
   `{string, number}` under `.trim()` runs the string branch and the number falls
   to the null default, because "possible" is not "proven".
4. **`ANY` on a one-family row is that family**, by the row's claim, as before.

```js
$.v = $.flag ? "abc" : [1, 2];  $.len = $.v.length;
// → …, { $set: { len: { $switch: { branches: [{ case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $size: "$v" } }, { case: { $in: [{ $type: "$v" }, ["string"]] }, then: { $strLenCP: "$v" } }] } } } }

$.v = $.flag ? 5 : [1, 2];  $.len = $.v.length;   // a number has no `.length` form → the default stays
// → …, { $set: { len: { $switch: { branches: [{ case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $size: "$v" } }], default: null } } } }
```

### The null guard

A cell that would abort or answer a value on null tests the receiver first
(`nullOr` in `names.ts`) exactly where the proof says `absent`. A written field
whose value was present takes no test: `$.s = "abc"; $.t = $.s.toUpperCase();`
emits `{ $toUpper: "$s" }` alone.

## What proves this spec

[test/compiler-types.test.ts](../../test/compiler-types.test.ts) states each rule
as a JSMQL program with its MQL, and runs that MQL on the project's mongod. Every
`MEASURED` note above has a case there or in the module it names.
