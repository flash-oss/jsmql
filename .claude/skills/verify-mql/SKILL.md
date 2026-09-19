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
[docs/LANG_RULES.md](docs/LANG_RULES.md)) says jsmql never *knowingly* emits
invalid MQL. The only way to *know* a shape is valid is to run it on a real
server. A passing `toEqual(...)` in a test proves only that jsmql emitted a
given document. It says nothing about whether MongoDB would accept it. Many real
bugs — the `$arrayToObject` double-array bug and the constant-only-slot
rejections among them — hid for a long time behind green `toEqual`s for exactly
this reason.

So: **whenever there is the slightest doubt that an emitted document would run,
execute it against a local `mongod` before you trust it.** Do not guess.

## The fast path: pipe the CLI into `test/probe`

[`test/probe`](test/probe) is the canonical runner. It gives you one reusable
script, instead of a throwaway `tmp/*.mjs` file per check. It connects to the
local `mongod`, seeds sample documents, runs the MQL, and prints what the
server returned. It prints the result through `jsmql.stringify`, so a Date or
an ObjectId in the result reads as the value it is. When mongod *rejects* a
shape, `test/probe` prints the rejection word for word and exits with a
non-zero status. **That refusal is the signal you probe for.**

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

- **Shape auto-detection:** an array selects `--pipeline`; an object whose
  top-level keys *all* start with `$` selects `--expr`; any other shape
  selects `--filter`. An update document such as `{$set:…}` looks like
  `--expr` to the detector, so pass `--update` yourself.
- **`--expr` uses `$addFields`, never `$project`.** `$project` reads `{}`,
  `0`, and `true` values as projection flags, and this produces a false
  "success". Do the same when you drive the driver by hand instead of probe.
- **`--doc <json>`** seeds an object or a JSON array; you can repeat this flag.
  The default is `{}`.
- **`--uri <uri>`** overrides the connection string. The default points at the
  project's own instance on `:27018`, the ONLY server this project may connect
  to — see [test/no-default-port.test.ts](../../../test/no-default-port.test.ts).
  Never point it at MongoDB's default port: that instance is the developer's
  own, and it holds their real work.

## Preconditions — check these before you run probe, and never guess around them

1. **Is `node_modules` present?** A fresh worktree starts without it, and
   probe needs the `mongodb` driver, a devDependency. If it is missing, run
   `npm install` first. Do **not** symlink `node_modules` from another
   checkout; this breaks the byte-equal `globals.ts` drift test.
2. **Is the project's mongod running?** It listens on `:27018`, and `npm run
   fixture:up` starts it. This is the ONLY server this project may connect to.
   MongoDB's default port belongs to the developer's own instance and their
   real work. When mongod is **not installed, stop, and ask the developer to
   install it.** Point them at the official
   [MongoDB Community installation guide](https://www.mongodb.com/docs/manual/administration/install-community/).
   Do not fall back to their own instance, and do not guess whether a shape is
   valid; a guess is the exact failure mode HR3 forbids.

## Alternative runner: the MongoDB MCP plugin

When the `plugin:mongodb:mongodb` MCP is connected, its `aggregate`, `find`,
`aggregate-db`, and `explain` tools run an emitted pipeline or filter directly
against a server. This is a faster path than probe when the MCP is already
connected. The same warnings apply:

- Use `$addFields`, not `$project`, to wrap a bare `jsmql.expr` fragment.
- The MCP data tools need a connection string, and they are **not** connected
  by default. Call `connect` with the project's `:27018` instance, after `npm
  run fixture:up`. Use the read-only identity to read the fixture dataset, and
  the scratch identity to write; find both in
  [test/fixtures/config.ts](../../../test/fixtures/config.ts). **Never invent
  a connection string, and never connect to any other server.**
- `search-knowledge` needs no connection. It is a *reference* cross-check for
  an operator's field table, a valid enum, or a version difference. It is
  secondary to the vendored spec YAML, and it never substitutes for running
  the shape.

The MCP is a convenience layer, not a dependency. `test/probe` is always the
fallback, so nothing breaks when the MCP is absent.

## `test/probe` compared with the integration fixture — one server, two identities

Both run on the project's `:27018` instance, and `npm run fixture:up` starts
it. There is no second server, and this project never uses MongoDB's default
port.

- **`test/probe`** runs ad-hoc checks with throwaway documents, in a scratch
  database the scratch identity may write. Reach for this during development.
- **`test/integration.test.ts`** reads the stable, deterministic dataset
  through a **server-enforced read-only** identity that cannot change it (see
  [test/fixtures/CLAUDE.md](test/fixtures/CLAUDE.md)). When a feature's
  realistic test would benefit from *live data and asserted results*, add a
  case there instead of trusting a green `toEqual`. Derive each expected value
  from a real run; never guess a value by hand (HR3).

## Known server-rejection traps

Watch for these. A `toEqual` that produces any of them is a red flag. The
canonical, maintained list, with its rationale, lives in
[test/CLAUDE.md](test/CLAUDE.md) under "Known server-rejection traps". Read it
when you audit a new shape. In brief: a `$$` variable name must start with a
lowercase ASCII letter; `$limit` and `$skip` need a positive constant integer,
never `0` and never a field path; a regex `options` value may carry only
`imxs` (the server rejects a JS `g` or `y` flag); a literal array where an
operator wants a *single* array argument gets counted as several arguments by
mistake; and a constant-required slot (`$bucket.boundaries`, `$sample.size`,
`$lookup.pipeline`, a date-typed input, and others) rejects a field path or an
expression.

## After you find and fix a bug in this class

Lock in the fix so the bug cannot come back. Add the offending shape to
[test/literal-passthrough.test.ts](test/literal-passthrough.test.ts), or to
the matching topic suite, as a guard. When the fix confirms a shape that was
in doubt before, also consider an assertion in `test/integration.test.ts`, so
the *server* keeps proving the shape, not only a `toEqual`.
