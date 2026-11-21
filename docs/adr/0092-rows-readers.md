# 0092. Decisions inside the registry readers (rows.ts)

Status: Accepted
Applies to: `src/compiler/rows.ts`

## Context

`src/compiler/rows.ts` holds the registry readers that every phase shares. Each reader is a projection of `src/registry/names.ts` and `src/registry/productions.ts`. Some readers make a choice that the row data alone does not show.

## Decision

- `ROWS` is a null-prototype object, because `toString` and `valueOf` are real rows. A plain object answers those names from `Object.prototype`.
- `FIELD_FAMILIES` holds the families that the value of a document field can have. `Math`, `Object`, `Number`, `Date` and `Array` are also families, but a program reaches them through a bare name, never through `$.<path>`. So `Math.PI` is a read on a namespace, and `$.Math.PI` is a field path of two segments.
- `isFieldProperty` is the one question that the field-path fold asks. `$.a.b` is the path `a.b`, but `$.a.length` is the size of `a`. Only the row of `length`, which says that the name is read and not called, separates the two.
- In a `BodyPath`, a `null` segment stands for a computed key (`{ [k]: … }`).
- `isCallable` and `acceptsArgumentCount` refuse only what a row refuses. A name with no row is for the caller to judge, so both answer yes for it.
- `isMutator` is true when a row states any of the three write forms: `immutableTwin`, `asArrayLiteral` or `mutatorForm`. With one function, no caller repeats the list. A caller that knew only two of the three read a mutator as an ordinary method.
- `slotFormsOf` resolves the short spellings of an iteratee slot in the same order as the rewrite. The order is: the name's own layout, then the row that the name runs as on a stream, then the array layout that a stream borrows. An empty answer means the slot takes only an arrow, and the refusal must say so.
- `receiverFamily` uses no type inference. A stream is a stream, a receiver that names a static namespace is that namespace, and any other receiver is the one value family that the row lists. This is enough for a rewrite, because the receiver gate of the row refuses a receiver of another family.
- `elements: "scalar"` on a row means that the server refuses an element that is an array. Any other value of `elements` is the one kind that each element must have (HR7).
- `argCountOf` takes the receiver family, because a row with `perFamily` states one count per family. A reader of only the first branch refuses a call that the receiver's own family accepts.
- For a cell with `byArgs`, `argCountOf` gives the union of the counts of its rules. So the compiler refuses a call such as `Date` with eight arguments, because the union of the counts does not hold eight. A rule with no count accepts any count, so the reader then gives no rule. The refusal keys of `byArgs` state no count: the rule for its class counts a constant call, and no rule counts the rest.
- `emitRow` reads a NAME row or a PRODUCTION row by one key. The two key sets cannot collide.
- `soleFieldFamilyOf` gives the one field family of a method row. A receiver that the registry cannot type still has this family when the call is valid: `.map` on an unproven field is a call on an array, or a server error, never a call on a string. The reader skips a namespace family, and a family that the row refuses, because neither can be the receiver of a program that compiles. So `.keys()` on an unproven field is a call on an object.
- `emptyValueOf` returns a new Date each time for a stated date value. An emitted document never shares the row's own Date object.
- `everyOperatorName` leaves out a name that `onlyInside` confines to the body of another operator in every legal position. Such a name cannot stand alone, so nothing offers it as an operator.
- A global row that lists no position is a namespace or a refusal (for example `RegExp`, `Math`). `constructorGlobals` and `bareCallableNames` skip it, so no suggestion and no ambient constructor names it.
- `rowForNodeType` reads both registries: the production that builds a node type, and its first token. So the code never lists a root spelling beside the node type that it builds.
- `operandRuleOf` reads the value cell of the production also when the lowering is in code (`inCode`), because such a row states the rule too.
- `lowersOn` is true only for a rule cell, not a refusal. For example, `Object.groupBy` parses so that its cell can refuse it, and a suggestion never names it.
- `streamMethodNames` includes a union link (`.concat(…)` to `$unionWith`). The union road lowers it, not a stream cell, but it also chains on a stream.
- `topKindOf` gives a coarse kind for a `TypeExpr`. The globals generator and the server measurement read it. The compiler evaluates the full term instead, in `src/compiler/emit/type.ts`.

## Consequences

A new row field that a phase reads needs one reader here, not a second copy in a phase. A change to the union rule for `byArgs` counts changes which calls get the arity refusal. A change to `ROWS` must keep the null prototype.
