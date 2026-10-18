# src/compiler/interpret/

An in-process interpreter for MQL expressions.

A constant is an expression whose lowered MQL reads nothing from the document and
nothing from the environment. The compiler lowers a closed subtree to MQL. It gives
that MQL to `interpret(mql)`, and the interpreter answers with the value. One rule
for each MongoDB operator replaces a hand-written JavaScript function for each method.

## The one invariant

A value that the interpreter answers equals the value that the server answers for
the same MQL. Where the server answer is not exactly specified, the rule refuses.
A refusal is never a failure: the expression then stays a runtime expression.

The interpreter runs on MQL that already passed the kind check of HR7. So it has no
path for a type error. A wrong kind of operand is a refusal, and never an exception.

`interpret` answers `{ ok: true, value }`, or `{ ok: false }` for a refusal, or
`{ ok: false, unspellable }` for a NaN or an infinity. `unspellable` propagates: a NaN
or an infinity in any part that the answer needs makes the whole answer unspellable.
The caller reports it.

## Layout

```
index.ts       the walk: a literal, a variable, a document, an array, an operator call.
               The limits of depth, size and steps. The scope of the variables.
rules.ts       RULES, the operators that the interpreter runs, joined from the family
               files. REFUSED, every other operator that it knows, with one reason.
values.ts      the value model: kinds, truthiness, equality, order, the numeric rules.
operand.ts     how a rule reads the operand: `positional` and `keyed`.
arithmetic.ts  compare.ts  logic.ts  array.ts  object.ts  string.ts  type.ts  accumulate.ts
               one file for each family. Each exports its part of RULES.
regex.ts       the three regular-expression operators, and the small pattern syntax that
               PCRE2 and JavaScript share. A pattern outside it is a refusal.
dates.ts       the date, timestamp and ObjectId-time operators, in UTC only.
```

The module imports nothing from `emit/` or `passes/`. It reads MQL and never the tree.
It may import `src/bson.ts`, `src/errors.ts` and `src/registry/mql.ts`.

## How a rule reads a value

- A literal is its own value. A string that starts with `$` is a field path, so it has
  no value. The one exception is `$$name`, a variable that a `$let`, `$map`,
  `$filter` or `$reduce` bound. A system variable always has no value.
- A number has no kind in the value. An integer within 32 bits is an int and every
  other number is a double when the query WRITES it. A number that an operator COMPUTES
  has the kind that the server gives it. So `$type` answers for a written number only.
- Every integer result beyond 2^53 is a refusal. MongoDB is exact in 64 bits and a
  double is not. An operand beyond 2^53 is always a double, so its arithmetic is double arithmetic on both sides.
- A `-0` is a refusal. A NaN and an infinity are `unspellable`. `$divide` answers a double.
- A list of three or more fractions is a refusal for `$sum` and `$avg`. The server adds it
  with a compensated sum, and the interpreter does not. `$add` and `$multiply` fold from left
  to right on the server, so they run on any list. A randomized test on the server shows the same bits as JavaScript.
- A string compares by code point, which is the UTF-8 byte order. A string operator
  counts code points or bytes, never UTF-16 units. A string with a lone surrogate has no
  value.
- A document keeps its key order. A JavaScript object moves a key that reads as an array
  index (`"1"`) to the front, so `spellable` refuses a document of two or more keys with such a key.
  `$arrayToObject` is the one rule that still answers such a document. Its answer is an `OrderedDocument`,
  the pairs in order. The value is opaque. A rule that reads its keys refuses it.
- A read that finds nothing is MISSING on the server, and no literal spells missing.
  So `$arrayElemAt` out of range, `$first` of `[]` and `$getField` of an absent key are refusals.
- An opaque value (a Long, a Decimal128, a Binary, a regex) passes through. No rule computes with it.

## The set answer

A set operator gives each value once, in an order that the server does not specify. The
interpreter keeps the order of first occurrence. So a rule must never read the order of
a set answer. `walk.at` refuses a value that holds a set answer, at any depth. A rule
uses `walk.raw` when it only passes the value on, or when it reads nothing of the order.
`positional(…, anyOrder)` is the same choice for a positional rule.

The order of a set answer passes on to a value that an operator builds from the elements, one
by one and in no order that it reads. The rule marks that value with `walk.markSet`, and the
mark follows the value by identity:

- `$map` and `$filter` mark the list that they build from a marked input. `$filter` with a
  `limit` keeps the first elements, so it refuses a marked input.
- `$arrayToObject` marks the document that it builds, and its key order is the order of the
  set. A key that two pairs share keeps the value of the last pair, so a marked list with a
  repeated key is a refusal. `$objectToArray` marks the list that it builds from a marked document.
- `$mergeObjects` marks its answer when an operand is marked. A marked list of documents that
  share a key is a refusal, because the last document wins.
- `$concatArrays` marks its answer when every operand is marked or empty. A marked operand beside a
  non-empty list is a refusal, because the position of each element depends on the set.
- `$cond`, `$switch`, `$ifNull` and `$let` pass a marked value on. A rule that reads no order
  (`$size`, `$in`, `$allElementsTrue`, `$anyElementTrue`, `$sum`, `$avg`, `$max`, `$min`, the set operators) accepts one.
- `$sortArray` removes the mark, because the order of its answer is specified. A tie keeps the order of
  the input, so a marked input with two different elements of one sort key is a refusal.

A rule that reads a position refuses a marked value: `$arrayElemAt`, `$first`, `$last`,
`$firstN`, `$lastN`, `$slice`, `$indexOfArray`, `$reverseArray`, `$reduce`, `$zip`, `$getField`.

A marked document has no key order to lose. So `spellable` does not refuse one that has a key which
reads as an array index (`"1"`), and a JavaScript object lists such keys first. The answer at the
root is the value as the interpreter holds it, in the order of first occurrence. A suite that compares a
marked answer with the server compares it as a set (test/support/set-answer.ts).

## The branch that the answer does not need

The interpreter never evaluates it. `$cond: [true, 1, { $divide: [1, 0] }]` is 1. The
server folds each constant part before it runs the expression, so it fails on that
division. This is the one place where the interpreter answers and the server fails.
`DIVERGE` in test/compiler-interpret-agrees.test.ts lists such cases, with the reason.
The interpreter follows JavaScript here: a guard such as `d === 0 ? 0 : 1 / d` works.
The same holds for a `$let` variable that nothing reads: its failure has no effect.

## How to add a rule

1. Measure the server on every edge of the operator: null, empty, negative, a fraction,
   a character beyond U+FFFF, a large integer. `./test/probe --expr` runs one case.
2. Add the rule to the file of its family, and let the rule refuse where the server
   answer is not exactly specified. Never write a refusal of a name inside a rule: put the
   operator in `REFUSED` with its reason.
3. Add a table of four to twelve cases to `BATTERIES` in
   test/compiler-interpret-agrees.test.ts. The suite fails until the table exists.
4. Add unit cases to test/compiler-interpret.test.ts. Add each refusal there too.
   `test/compiler-interpret-rows.test.ts` fails until the new operator has a rule or a refusal.

A name in this directory is a key of a table. No branch tests the name of an operator.

## The measured facts that look arbitrary

- Two values of different kinds compare by the place of their kinds in the BSON order. The places, in order,
  are: MinKey, null, a number, a string, a document, an array, a binary, an ObjectId, a boolean, a
  date, a timestamp, a regular expression, MaxKey. So `$eq` is false and `$ne` is true across kinds,
  and an order across kinds always has an answer. All numeric types share one place. A document
  compares field by field, and each field by its place, then its name, then its value. Two opaque
  values of one place (a Long beside a number) are a refusal.
- `$trim` removes a fixed list of code points by default. The documentation lists more
  of them than the server removes. A string with one of the disputed code points is a
  refusal, so the answer does not depend on the version of the server.
- `$indexOfCP` has an end bound that the interpreter does not model, so an end bound is a refusal. A start at or past the end gives -1, also for an empty search string, unless the start is 0.
- A 32-bit integer that `$round` or `$trunc` takes past 32 bits wraps around on the server. That is a refusal.
- A `timezone` operand runs only when it names UTC (`UTC`, `+00:00`, `+0000`). The server
  fails on `Z`. Every other zone is a refusal, because the interpreter holds no zone table.
- `$dateTrunc` bins from 2000-01-01, not from the epoch. A week bin starts on `startOfWeek`.
- A date string runs only in the ISO 8601 forms that dates.ts lists. The server parser is
  far more lenient, and some of its answers differ from the ISO reading, so every other string is a refusal. A
  `format` operand is a refusal.
- `$toDate` of an int fails on the server, and of a double or a long it does not. The kind
  of a computed number is not known, so only a fraction or an integer beyond 32 bits runs.
- A date beyond the range of a JavaScript Date is a refusal, as is a `$dateDiff` beyond 2^53.
- `$toString` answers an integer below 10^16, a string, a boolean, null, an ObjectId (its 24 hex
  digits), a Decimal128 and an integer Long or Int32. Every other number prints in a form that
  differs from JavaScript, and its text is a `NumberText`. A `NumberText` is a value with no text. The interpreter knows
  only that it starts with an optional minus sign and a digit. It differs from every string that does not
  start so. That is all that the finite-number test of a lowering reads (`$in` against `"NaN"` and
  `"Infinity"`). No other rule reads one, and an answer that holds one is a refusal. An unsigned
  Long above the signed range prints in a wrapped form on the server, so it is a refusal.
- `$toInt` cuts the fraction of a number toward zero. The server checks the number itself, so
  `2147483647.5` fails there, and a number outside the 32-bit range is a refusal. A boolean is 1 or 0. A
  string runs when it is ASCII digits with an optional sign and no space, within 32 bits. The other
  conversions (`$toLong`, `$toDouble`, `$toDecimal`, `$convert`) stay in `REFUSED`.
- The regular-expression operators run only for a pattern in the syntax of regex.ts. The `options` operand is
  empty or `i`. The syntax has these parts:
  - a literal ASCII character, and an escaped punctuation character
  - a class of ASCII ranges, and `\d`, `\w` and `\s` as the ASCII sets
  - the quantifiers `?`, `*`, `+` and `{n,m}`
  - a group, `(?:…)`, `|`, `^`, `$`, `(?=…)` and `(?!…)`

  The server differs from JavaScript in these measured ways:
  - `$` also matches before a final newline.
  - A capture inside a repeated group keeps the value of an earlier pass.
  - `$regexFindAll` never reports an empty match at the end of the string. The exception is a match that the
    search before it found there. After an empty match, it steps one code point forward.
  - `idx` counts code points.
  - With `i`, U+017F and U+212A fold to an ASCII letter in JavaScript. So a string that holds either one is a refusal.

  A string that is long for the cost of its pattern, and a match inside a surrogate pair, are refusals too.
