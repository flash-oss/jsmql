# CLI — the `jsmql` bin

The `jsmql` command-line tool transpiles JSMQL source to MongoDB MQL. Source
goes in through the positional argument, `--file`, or stdin. MQL comes out on
stdout, as the JavaScript that rebuilds it. Errors go to stderr, with a
non-zero exit code. The CLI is a thin wrapper over the public API in
[src/index.ts](../../src/index.ts). It holds no compilation logic — only
argument routing, output formatting, and error rendering.

Source: [src/cli.ts](../../src/cli.ts). Bin name: `jsmql`
(`package.json#bin → dist/cjs/cli.cjs`).

## Input precedence

`resolveSource()` picks the source in this order:

1. the positional `[source]` argument, if present;
2. `--file <path>` (read with `readFileSync(path, "utf8")`);
3. stdin, read synchronously via `readFileSync(0, "utf8")` (fd 0).

If none of these is available, and `process.stdin.isTTY` is true (an
interactive terminal with nothing piped), this is a **usage error** (exit 2).
The CLI must not hang while it waits on a TTY. The CLI applies `trimEnd()` to
the resolved source. Trailing whitespace, notably the newline a shell `echo`
or heredoc appends, has no meaning in the language. Trimming keeps an
end-of-input error's caret on the source line, instead of a dangling blank one.

## Output shape

| Flag | Routes to | Output |
| --- | --- | --- |
| *(none)* | `jsmql(source)` | polymorphic — Filter object or Pipeline array (the `;` rule) |
| `--filter` | `jsmql.filter(source)` | Filter document (object) |
| `--pipeline` | `jsmql.pipeline(source)` | Pipeline (array of stages) |
| `--expr` | `jsmql.expr(source)` | raw aggregation expression |
| `--update` | `jsmql.update(source)` | update document (`{ $set, $inc, … }`, constants only) |
| `--validate` / `--check` | `jsmql.validate(source)` | `{ valid, errors }` JSON |

The mode flags are mutually exclusive. Two of them together is a usage error.
The strict flags inherit the library's actionable wrong-shape errors verbatim.
For example, a bare expression under `--pipeline` produces the same "wrap it
as `$match(...)`" message that the JS `jsmql.pipeline()` throws. The CLI
invents no new wording.

## Formatting

The output is what `jsmql.stringify(result, { indent, width })` writes. This
is the library's own printer; the CLI holds no copy of it. It writes the
document as the JavaScript that rebuilds it. So the text pastes into a driver
script or into mongosh, and it means what the source meant. The rules, the
BSON classes, and the layout are in [mql-stringify.md](mql-stringify.md).

`--indent N` sets the indent to N spaces (an integer from 0 to 10, validated).
`--tab` sets the indent to a tab. The default is 2 spaces. `-c` / `--compact`
lifts the line width to infinity. This puts the whole document on one line,
whatever the indent says.

`--validate` is the exception. It reports `{ valid, errors }`, which holds
strings and numbers only. This is a machine-readable report, not a document,
so the CLI writes it as JSON. It is indented by `--indent`, and on one line
under `--compact`.

## Parameters (`--arg` / `--argjson`)

The presence of any `--arg` or `--argjson` switches the source interpretation.
Instead of a bare query, the source must be a **parameterised arrow**. The CLI
routes it through `jsmql.compile(source)(params)` (see
[function-form-params.md](function-form-params.md)):

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# → { age: { $gt: 18 } }
```

`--arg NAME VALUE` binds `NAME` to the string `VALUE`. `--argjson NAME VALUE`
binds it to `JSON.parse(VALUE)`. A malformed value is a usage error. Both
flags are repeatable, and they accumulate into one params object.

Params combine with any output-shape flag. When params are present, the
source is a parameterised arrow. So each mode routes through the matching
`*.compile()` builder: `jsmql.filter.compile`, `jsmql.pipeline.compile`,
`jsmql.expr.compile`, or `jsmql.update.compile`, and it defaults to
`jsmql.compile`. This builder binds the values, and it still enforces that
mode's shape contract:

```sh
echo '({ minAge }, { $ }) => { $match($.age > minAge) }' | jsmql --pipeline --argjson minAge 18
# → [{ $match: { age: { $gt: 18 } } }]
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --pipeline --argjson minAge 18
# → exit 1: jsmql.pipeline() expects a Pipeline … (the arrow lowers to a Filter)
```

`--validate` with params validates the parameterised arrow's shape. The bound
values do not affect validity. `jsmql.validate` accepts a
parameterised-arrow string directly.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success; or `--validate` with `valid: true` |
| `1` | compile/parse error; or `--validate` with `valid: false` |
| `2` | usage error — unknown/conflicting flags, a missing flag value, no input on a TTY, or an invalid `--argjson` value |

`main()` returns the code. The module sets `process.exitCode`. It does not
call `process.exit` mid-stream.

## Error rendering

On a thrown compile error, `renderError()` writes to stderr:

```
jsmql: error: <err.message>
  <the source line containing err.pos>
  <spaces><caret ^ under the offending column>
```

Every JSMQL compile error (`LexError`, `ParseError`, `CodegenError`,
`UnknownIdentifierError`, or `FunctionInputError`) carries `pos: number`. The
caret column is `pos - lineStart`. When `pos` is absent or out of range, the
CLI prints only the `jsmql: error:` line. Usage errors are formatted
differently: `jsmql: <message>`, followed by `Try 'jsmql --help'.`. So the two
error classes look different.

## Versioning

`src/cli.ts` references `__JSMQL_VERSION__`. esbuild's `define` (in
[scripts/build-cjs.mjs](../../scripts/build-cjs.mjs)) replaces this at build
time with `package.json`'s version. A `typeof` guard falls back to
`"0.0.0-dev"`. So the un-bundled `node src/cli.ts` run, which has no
`define`, still works.

## Build & packaging

`src/cli.ts` stays in the strippable-TS subset. Its first line carries
`#!/usr/bin/env node`. The `cli` esbuild entry in `scripts/build-cjs.mjs`
bundles it to `dist/cjs/cli.cjs` (Node 14 target, shebang preserved). The
script also runs `chmod 0o755` on it. `package.json#bin` maps the command
name `jsmql` to that file.

## Tests

- [test/cli.test.ts](../../test/cli.test.ts) — spawns `node src/cli.ts`
  (native type-stripping, no build needed). It covers input sources, every
  output shape, formatting flags, `--validate` for valid and invalid input,
  params combined with each output-shape or `--validate` flag, error carets,
  and usage errors.
- [test/smoke.test.ts](../../test/smoke.test.ts) — a strippable-TS check
  (`node src/cli.ts --help`), plus a dist-gated case that drives the built
  `dist/cjs/cli.cjs` (stdin to MQL, `--version`, shebang assertion).

## Deferred work and non-goals

A `-S` / `--sort-keys` flag is a deliberate **non-goal**. Reordering object
keys can change MQL semantics — for example, `$project` computed-field order.
So the project records this as a will not-implement decision in
[DEFERRED.md](../DEFERRED.md) §B, instead of a TODO.
