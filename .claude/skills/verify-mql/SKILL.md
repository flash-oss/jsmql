---
name: verify-mql
description: >-
  Verify that jsmql's emitted MQL actually runs on a real MongoDB before trusting
  or asserting it. Use this whenever you are about to (a) assert an expected MQL
  output in a test, (b) add or change an operator, stage, method alias, or a
  stage-lowering, or (c) claim a shape is valid — and whenever there is the
  slightest doubt that an emitted document would run. This enforces language rule
  HR3 (jsmql never knowingly emits invalid MQL): a green `toEqual` proves only
  what jsmql *emits*, never that mongod *accepts* it. Runs the MQL through
  `test/probe` (or the MongoDB MCP) against a local `mongod`. Trigger even when the
  user only says "does this run?", "is this valid MQL?", or "check this against Mongo".
---

# verify-mql

## Why this exists

jsmql's whole pitch is that it produces *runnable* MQL. HR3 (see
[docs/LANG_RULES.md](docs/LANG_RULES.md)) says jsmql never *knowingly*
emits invalid MQL — and the only way to *know* a shape is valid is to run it on a
real server. A passing `toEqual(...)` in a test proves only that jsmql emitted a
given document; it says nothing about whether MongoDB would accept it. Multiple
real bugs (the `$arrayToObject` double-array bug, constant-only-slot rejections)
hid for a long time behind green `toEqual`s for exactly this reason.

So: **whenever there is the slightest doubt that an emitted document would run,
execute it against a local `mongod` before trusting it.** Don't guess.

## The fast path: pipe the CLI into `test/probe`

[`test/probe`](test/probe) is the canonical runner — one reusable script
instead of a throwaway `tmp/*.mjs` per check. It connects to the local `mongod`,
seeds sample docs, runs the MQL, and prints the server's JSON result. When mongod
*rejects* a shape, it prints the rejection verbatim and exits non-zero — **that
refusal is the signal you are probing for.**

It composes directly with the `jsmql` CLI. Pick the CLI flag that matches the
shape you're producing, and pass matching `--doc` seed data:

```sh
# Filter (no top-level ';')  — find(filter)
echo '$.age > 18'      | node src/cli.ts            | ./test/probe --doc '[{"age":20},{"age":5}]'

# Pipeline (has a ';')       — aggregate([...])
echo '$match($.x > 0)' | node src/cli.ts --pipeline | ./test/probe --doc '{"x":1}'

# Bare expression fragment   — aggregate([{ $addFields: { __v: <expr> } }])
echo '$.name.trim()'   | node src/cli.ts --expr     | ./test/probe --doc '{"name":"  a  "}'

# Update doc                 — updateMany({}, <doc>) then show resulting docs
echo '$.qty = $.qty + 1' | node src/cli.ts --update | ./test/probe --update --doc '{"qty":1}'
```

`./test/probe --help` prints the full usage. Key points:

- **Shape auto-detection:** array → `--pipeline`; an object whose top-level keys
  *all* start with `$` → `--expr`; otherwise → `--filter`. An update doc like
  `{$set:…}` looks like `--expr` to the detector, so pass `--update` explicitly.
- **`--expr` uses `$addFields`, never `$project`** — `$project` reinterprets `{}`,
  `0`, and `true` values as projection flags and produces false-positive
  "successes". If you hand-drive the driver instead of probe, do the same.
- **`--doc <json>`** seeds an object or JSON array; repeatable. Default `{}`.
- **`--uri <uri>`** overrides the connection string (default
  `mongodb://127.0.0.1:27017`).

## Preconditions — check before running, don't guess around them

1. **`node_modules` present?** A fresh worktree starts without it (probe needs the
   `mongodb` driver, a devDependency). If missing, run `npm install` first. Do
   **not** symlink `node_modules` from another checkout — it breaks the byte-equal
   `ops.ts` drift test.
2. **Is a local `mongod` running?** Probe defaults to `127.0.0.1:27017`. If mongod
   is **not installed or not running, stop and ask the developer to install and
   start it** — point them at the official
   [MongoDB Community installation guide](https://www.mongodb.com/docs/manual/administration/install-community/).
   Do not fall back to guessing whether a shape is valid; guessing is the exact
   failure mode HR3 forbids.

## Alternative runner: the MongoDB MCP plugin

When the `plugin:mongodb:mongodb` MCP is connected, its `aggregate` / `find` /
`aggregate-db` / `explain` tools run an emitted pipeline/filter directly against a
server — a faster path than probe when the MCP is already connected. Same caveats:

- Use `$addFields` (not `$project`) to wrap a bare `jsmql.expr` fragment.
- The MCP data tools need a connection string and are **not** connected by default.
  Call `connect` with one the developer provides (the local `mongod`, or the
  read-only fixture on `:27018` after `npm run fixture:up`). **Never invent a
  connection string.**
- `search-knowledge` (no connection required) is a *reference* cross-check for
  operator field tables / valid enums / version differences — it is secondary to
  the vendored spec YAML and never a substitute for actually running the shape.

The MCP is a convenience layer, not a dependency: `test/probe` is always the
fallback, so nothing breaks when the MCP is absent.

## `test/probe` vs. the `:27018` integration fixture

- **`test/probe`** — ad-hoc checks against the developer's *primary* mongod
  (`:27017`) with throwaway docs. This is what you reach for during development.
- **`npm run fixture:up` + `test/integration.test.ts`** — a dedicated,
  server-enforced **read-only** mongod on `:27018` with a stable, deterministic
  dataset (see [test/fixtures/CLAUDE.md](test/fixtures/CLAUDE.md)). When a
  feature's realistic test benefits from *live data and asserted results*, add a
  case there instead of trusting a green `toEqual`. Derive expected values from a
  real run — never hand-guess them (HR3).

## Known server-rejection traps

Watch for these — a `toEqual` that produces any of them is a red flag. The
canonical, maintained list (with rationale) lives in
[test/CLAUDE.md](test/CLAUDE.md) under "Known server-rejection traps";
read it when auditing a new shape. In brief: `$$` variable names must start with a
lowercase ASCII letter; `$limit`/`$skip` need a positive constant integer (never
`0`, never a field path); regex `options` may only carry `imxs` (a JS `g`/`y` flag
is rejected); a literal array where an operator wants a *single* array argument
gets miscounted as multiple args; and constant-required slots
(`$bucket.boundaries`, `$sample.size`, `$lookup.pipeline`, date-typed inputs, …)
reject field paths and expressions.

## After you find and fix a bug in this class

Lock it in so it can't regress: add the offending shape to
[test/literal-passthrough.test.ts](test/literal-passthrough.test.ts) (or
the relevant topic suite) as a guard, and — when the fix confirms a shape that was
previously in doubt — consider adding an assertion in `test/integration.test.ts`
so the *server* keeps proving it, not just a `toEqual`.
