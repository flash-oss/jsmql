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
  `test/probe` (or the MongoDB MCP) against the project's own mongod on :27018 —
  never MongoDB's default port, which is the developer's own instance. Trigger even when the
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
seeds sample docs, runs the MQL, and prints what the server returned — through
`jsmql.stringify`, so a Date or an ObjectId in the result reads as the value it is. When mongod
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
- **`--uri <uri>`** overrides the connection string. The default is the project's
  own instance on `:27018`, which is the ONLY server this project may connect to —
  see [test/no-default-port.test.ts](../../../test/no-default-port.test.ts). Never
  point it at MongoDB's default port: that instance is the developer's own and
  holds their real work.

## Preconditions — check before running, don't guess around them

1. **`node_modules` present?** A fresh worktree starts without it (probe needs the
   `mongodb` driver, a devDependency). If missing, run `npm install` first. Do
   **not** symlink `node_modules` from another checkout — it breaks the byte-equal
   `globals.ts` drift test.
2. **Is the project's mongod running?** It listens on `:27018` and `npm run
   fixture:up` starts it. That instance is the ONLY server this project may
   connect to — MongoDB's default port belongs to the developer's own instance and
   their real work. If mongod is **not installed, stop and ask the developer to
   install it** — point them at the official
   [MongoDB Community installation guide](https://www.mongodb.com/docs/manual/administration/install-community/).
   Do not fall back to their own instance, and do not fall back to guessing whether
   a shape is valid; guessing is the exact failure mode HR3 forbids.

## Alternative runner: the MongoDB MCP plugin

When the `plugin:mongodb:mongodb` MCP is connected, its `aggregate` / `find` /
`aggregate-db` / `explain` tools run an emitted pipeline/filter directly against a
server — a faster path than probe when the MCP is already connected. Same caveats:

- Use `$addFields` (not `$project`) to wrap a bare `jsmql.expr` fragment.
- The MCP data tools need a connection string and are **not** connected by default.
  Call `connect` with the project's `:27018` instance (after `npm run fixture:up`) —
  the read-only identity to read the fixture dataset, the scratch identity to write,
  both in [test/fixtures/config.ts](../../../test/fixtures/config.ts). **Never invent
  a connection string, and never connect to any other server.**
- `search-knowledge` (no connection required) is a *reference* cross-check for
  operator field tables / valid enums / version differences — it is secondary to
  the vendored spec YAML and never a substitute for actually running the shape.

The MCP is a convenience layer, not a dependency: `test/probe` is always the
fallback, so nothing breaks when the MCP is absent.

## `test/probe` vs. the integration fixture — one server, two identities

Both run on the project's `:27018` instance, which `npm run fixture:up` starts.
There is no second server, and MongoDB's default port is never used.

- **`test/probe`** — ad-hoc checks with throwaway documents, in a scratch database
  the scratch identity may write. This is what you reach for during development.
- **`test/integration.test.ts`** — the stable, deterministic dataset, read through a
  **server-enforced read-only** identity that cannot mutate it (see
  [test/fixtures/CLAUDE.md](test/fixtures/CLAUDE.md)). When a feature's realistic
  test benefits from *live data and asserted results*, add a case there instead of
  trusting a green `toEqual`. Derive expected values from a real run — never
  hand-guess them (HR3).

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
