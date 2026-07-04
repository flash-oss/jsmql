# CLI — the `jsmql` bin

The `jsmql` command-line tool transpiles JSMQL source to MongoDB MQL JSON, in
the spirit of `jq`: **source in (positional arg / `--file` / stdin), MQL JSON
out (stdout)**, errors on stderr with a non-zero exit code. It is a thin wrapper
over the public API in [src/index.ts](../../src/index.ts) — there is no
compilation logic in the CLI, only argument routing, output formatting, and
error rendering.

Source: [src/cli.ts](../../src/cli.ts). Bin name: `jsmql`
(`package.json#bin → dist/cjs/cli.cjs`).

## Input precedence

`resolveSource()` picks the source in this order:

1. the positional `[source]` argument, if present;
2. `--file <path>` (read with `readFileSync(path, "utf8")`);
3. stdin, read synchronously via `readFileSync(0, "utf8")` (fd 0).

If none of these is available **and** `process.stdin.isTTY` is true (an
interactive terminal with nothing piped), it is a **usage error** (exit 2) —
the CLI must not hang waiting on a TTY. The resolved source is `trimEnd()`-ed:
trailing whitespace (notably the newline a shell `echo`/heredoc appends) is
insignificant to the language, and trimming keeps an end-of-input error's caret
on the source line rather than a dangling blank one.

## Output shape

| Flag | Routes to | Output |
| --- | --- | --- |
| *(none)* | `jsmql(source)` | polymorphic — Filter object or Pipeline array (the `;` rule) |
| `--filter` | `jsmql.filter(source)` | Filter document (object) |
| `--pipeline` | `jsmql.pipeline(source)` | Pipeline (array of stages) |
| `--expr` | `jsmql.expr(source)` | raw aggregation expression |
| `--update` | `jsmql.update(source)` | update pipeline (whitelisted stages) |
| `--validate` / `--check` | `jsmql.validate(source)` | `{ valid, errors }` JSON |

The mode flags are mutually exclusive; two of them is a usage error. The strict
flags inherit the library's actionable wrong-shape errors verbatim (e.g. a bare
expression under `--pipeline` produces the same "wrap it as `$match(...)`"
message the JS `jsmql.pipeline()` throws) — the CLI invents no new wording.

## Formatting

Output is `JSON.stringify(result, null, indent)`. Default `indent` is `2`
(pretty, multiline — matching `jq`). `-c`/`--compact` sets `indent` to `0`
(single line); `--tab` sets it to `"\t"`; `--indent N` sets it to `N` (an
integer 0–10, validated). `--validate` output is formatted the same way.

## Parameters (`--arg` / `--argjson`)

Borrowed from `jq`. Presence of any `--arg`/`--argjson` switches the source
interpretation: instead of a bare query the source must be a **parameterised
arrow**, and it is routed through `jsmql.compile(source)(params)` (see
[function-form-params.md](function-form-params.md)):

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# → { "age": { "$gt": 18 } }
```

`--arg NAME VALUE` binds `NAME` to the string `VALUE`; `--argjson NAME VALUE`
binds it to `JSON.parse(VALUE)` (a malformed value is a usage error). Both are
repeatable and accumulate into one params object.

Params combine with any output-shape flag. With params present the source is a
parameterised arrow, so each mode routes through the matching `*.compile()`
builder — `jsmql.filter.compile` / `jsmql.pipeline.compile` /
`jsmql.expr.compile` / `jsmql.update.compile`, defaulting to `jsmql.compile` —
which binds the values and still enforces that mode's shape contract:

```sh
echo '({ minAge }, { $ }) => { $match($.age > minAge) }' | jsmql --pipeline --argjson minAge 18
# → [ { "$match": { "age": { "$gt": 18 } } } ]
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --pipeline --argjson minAge 18
# → exit 1: jsmql.pipeline() expects a Pipeline … (the arrow lowers to a Filter)
```

`--validate` with params validates the parameterised arrow's shape (the bound
values don't affect validity) — `jsmql.validate` accepts a parameterised-arrow
string directly.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success; or `--validate` with `valid: true` |
| `1` | compile/parse error; or `--validate` with `valid: false` |
| `2` | usage error — unknown/conflicting flags, a missing flag value, no input on a TTY, or an invalid `--argjson` value |

`main()` returns the code; the module sets `process.exitCode` (no mid-stream
`process.exit`).

## Error rendering

On a thrown compile error, `renderError()` writes to stderr:

```
jsmql: error: <err.message>
  <the source line containing err.pos>
  <spaces><caret ^ under the offending column>
```

Every jsmql compile error (`LexError` / `ParseError` / `CodegenError` /
`UnknownIdentifierError` / `FunctionInputError`) carries `pos: number`; the
caret column is `pos - lineStart`. When `pos` is absent or out of range, only
the `jsmql: error:` line is printed. Usage errors are formatted differently —
`jsmql: <message>` followed by `Try 'jsmql --help'.` — so the two error classes
are visually distinct.

## Versioning

`src/cli.ts` references `__JSMQL_VERSION__`, replaced at build time by esbuild's
`define` (in [scripts/build-cjs.mjs](../../scripts/build-cjs.mjs)) with
`package.json`'s version. A `typeof` guard falls back to `"0.0.0-dev"` so the
un-bundled `node src/cli.ts` run (no `define`) still works.

## Build & packaging

`src/cli.ts` stays in the strippable-TS subset and carries `#!/usr/bin/env
node` as its first line. The `cli` esbuild entry in `scripts/build-cjs.mjs`
bundles it to `dist/cjs/cli.cjs` (Node 14 target, shebang preserved), and the
script `chmod`s it `0o755`. `package.json#bin` maps the command name `jsmql` to
that file.

## Tests

- [test/cli.test.ts](../../test/cli.test.ts) — spawns `node src/cli.ts` (native
  type-stripping, no build needed): input sources, every output shape,
  formatting flags, `--validate` valid/invalid, params combined with each
  output-shape / `--validate` flag, error carets, and usage errors.
- [test/smoke.test.ts](../../test/smoke.test.ts) — a strippable-TS check
  (`node src/cli.ts --help`) plus a dist-gated case driving the built
  `dist/cjs/cli.cjs` (stdin → MQL, `--version`, shebang assertion).

## Deferred work and non-goals

A deliberate **non-goal** is `jq`'s `-S/--sort-keys`: reordering object keys can
change MQL semantics (e.g. `$project` computed-field order), so it is recorded
as a won't-implement decision in [DEFERRED.md](../DEFERRED.md) §B rather than
left as a TODO.
