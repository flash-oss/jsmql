# The differential harness

## Overview

`npm run diff:compilers` runs a reference compiler and the working-tree compiler over one
corpus and reports every place they disagree.

The test suite proves the working tree is self-consistent. It cannot prove the working
tree still *means* what it meant, because a refactor rewrites the assertions along with
the code — a suite can go green on a changed behaviour simply because someone changed the
expectation. The reference lives in a separate checkout, so it cannot be edited from here.

```
node scripts/diff-compilers.mjs             # summary; exit 1 while anything is unclassified
node scripts/diff-compilers.mjs --verbose   # every divergence, accepted ones included
node scripts/diff-compilers.mjs --ref PATH  # a different reference checkout
node scripts/diff-compilers.mjs --accept    # record the current divergences for classification
```

## The rule

**No divergence may stay unclassified.** Each one is either a regression to fix, or an
intended change recorded in `test/accepted-divergences.json` with the reason it is
correct. The command exits non-zero while any row is unclassified, or while any recorded
row still carries a `TODO` reason, so it gates the same way a test does.

A recorded row keeps the before and after values, not just the input:

```json
"expr $ = { a: 1 }": {
  "entry": "expr",
  "src": "$ = { a: 1 }",
  "kind": "now-rejected",
  "was": "[{\"$replaceWith\":{\"a\":1}}]",
  "now": "jsmql.expr() returns one aggregation expression, but received a root-replace …",
  "reason": "Intended, commit 42d3d7a. jsmql.expr() returns ONE aggregation expression. …"
}
```

A reviewer judges whether a change was right by reading what it did, so the evidence
belongs beside the reason.

## The four kinds

| Kind | Meaning |
|---|---|
| `output` | both compile, and the emitted MQL differs |
| `message` | both reject, and the wording differs |
| `now-rejected` | the reference compiled it; the working tree rejects it |
| `now-accepted` | the reference rejected it; the working tree compiles it |

`now-accepted` deserves the most scrutiny. A newly accepted input is a shape nobody has
run against a server, so it needs a live `mongod` check before its row is written.

## The corpus

Two sources, because either alone has a blind spot.

**Harvested from the test suite.** Every `jsmql(…)` / `jsmql.expr(…)` / … string literal in
`test/*.test.ts`. This inherits every input anyone thought worth a test — far more than a
list written by hand, and it grows on its own as tests are added.

**Generated.** Each method against each receiver shape, the stream and statement forms,
the predicate surface, and a hand-kept `EDGES` list. `EDGES` exists because a corpus
harvested from tests inherits the tests' blind spots: `.take(2)` appears in the suite and
`.take(1.5)` did not, so the fractional-count fix would have been invisible. **When a
change moves a shape the suite never spelled, add that shape to `EDGES`.**

Every corpus source runs through all five entry points, so an entry point that treats a
shape differently from its siblings shows up without anyone predicting it.

## BSON values

`JSON.stringify` flattens the values jsmql deliberately emits in place — `RegExp`, `Date`,
`ObjectId`, `Uint8Array` all collapse to `{}`, which would make two different regexes
compare equal. The harness tags them instead (`«regexp:^a/i»`, `«date:…»`, `«oid:…»`), so
a change to one is visible.

This is the same trap the CLI has: it prints JSON, so it cannot show a BSON value either.
Probe those through the JS API.

## Limits

The harness compares the one-shot entry points. It does not cover `jsmql.compile(…)(params)`,
whose divergences need a params fixture per case, nor the template-tag form. A change to
binding resolution needs its own test — the `.reduce` binding fix is the worked example.

## The reference is pinned, not assumed

The reference defaults to the checkout this worktree hangs off — a checkout that belongs to
whoever else is working in it, and that can move under a run. A sibling session checking out
a branch changes what "no divergence" means, and every neutrality claim measured against it
changes silently with it.

So the harness reads the reference's identity and prints it: the commit, and the git TREE
hash of its `src/`. Only `src/` counts — a reference that moved for docs or a landing page is
the same compiler, and the tree hash says so directly.

`--accept` stamps that identity into `test/accepted-divergences.json`. A later run whose
reference has a different `src/` tree, or uncommitted edits in `src/`, **fails with exit 3**
and says so, because every accepted row is a judgement about one specific compiler: against a
different one, a real regression can read as an already-accepted divergence.

Restore the reference, or re-judge the rows against the new one with `--accept`.
