# 0135. Projection-form operators in a `$project` body

Status: Rejected
Applies to: the `slice` and `some` rows in `src/registry/names.ts`, the `$project` stage, `docs/specs/aggregation-stages.md`

## Context

(delete the sentence) Inside `$project({ … })`, `.slice()` and `.some()` would lower to the projection-form operators: a single-argument `$slice`, and `$elemMatch`. A third switch, `$meta`, was part of the same idea.

## Decision

JSMQL does not do this, because the premise is wrong. JSMQL's `$project` is the aggregation pipeline stage, not a `find()` projection. The projection-form operators work only in a `find()` projection, and the aggregation stage refuses them. A test on a running mongod showed this:

- `{ $slice: N }` with a single argument fails. In an aggregation `$project`, `$slice` is always the expression operator, and that operator needs two or more operands.
- `{ $elemMatch: { … } }` fails, because the aggregation stage does not accept `$elemMatch`. `$elemMatch` is not an aggregation operator at all.
- Even in a `find()` projection, where `$elemMatch` is valid, it returns the matched element, not a boolean. So it would break the JavaScript meaning of `.some()`.

The expression forms that JSMQL emits already run correctly in `$project`. `$meta` already has a row in `src/registry/names.ts`. It is a normal aggregation expression, and `$op($meta("textScore"))` reaches it. So nothing valid remains to build. A build of the idea would make JSMQL knowingly emit invalid MQL, and that breaks HR3.

## Consequences

- Write `$.items.slice(0, 3)`. It becomes `{ $slice: ["$items", 3] }`.
- Write `$.items.some(i => i.x > 5)`. It becomes `{ $anyElementTrue: { $map: … } }`.
- Write `$meta(…)` for `$meta`.
- Reconsider only if the aggregation `$project` stage starts to accept the projection-form operators.
