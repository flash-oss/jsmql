# Architecture

How a JSMQL source becomes an MQL document: the phases, the registry they read,
and the module that owns each construct. The user-facing behaviour is in
[docs/LANGUAGE.md](../LANGUAGE.md); the language axioms in
[docs/LANG_RULES.md](../LANG_RULES.md); each phase has its own spec, linked below.

## Overview

```
source string ─▶ lex ─▶ parse ─▶ fold ─▶ desugar ─▶ (shape) ─▶ emit ─▶ MQL JSON
                  │        │       │        │                    │
                  └────────┴───────┴────────┴──── every fact ────┘
                                          read from src/registry/
```

Two directories carry the compiler:

- **`src/registry/`** — the single source of truth. One row per NAME (`names.ts`:
  every JavaScript method, MongoDB operator, global, context reference), per
  CONSTRUCT (`productions.ts`: the operators and statement forms), per LEXEME
  (`tokens.ts`, `keywords.ts`), in one vocabulary (`vocabulary.ts`). A row states
  what the language HAS — the positions a name is valid in (`where`), a cell per
  position (a rule, or a refusal that names the alternative), its receiver
  families, its arguments rule, what it returns — and nothing here builds MQL for a
  construct that needs its neighbours. `mql.ts` holds the pure MQL builders the
  cells share; `ast.ts` the node shapes. See [src/registry/CLAUDE.md](../../src/registry/CLAUDE.md).
- **`src/compiler/`** — the five phases over the registry. A phase asks a row; it
  never lists names of its own. See [src/compiler/CLAUDE.md](../../src/compiler/CLAUDE.md).

## The phases

| Phase | Module | Owns | Spec |
|---|---|---|---|
| 1 LEX | `compiler/lex/` | Tokens from the registry's lexeme tables; positions on every token | — |
| 2 PARSE | `compiler/parse/` | The AST (`registry/ast.ts`), the entry form `(params, { $ }) => …`, the 200-level nesting guard | [grammar.md](grammar.md) |
| 3 FOLD + DESUGAR | `compiler/passes/fold.ts`, `desugar.ts` | Compile-time constants inlined; every sugar form rewritten to the source it means (mutators, iteratee shorthands, the spread pack, the write forms) | [desugar-pass.md](desugar-pass.md) |
| 4 POSITION | `compiler/passes/position.ts` | Where every node stands — value, filter, statement, stream, group, window, updateDoc — answered on the way down from the root the entry states | [position-pass.md](position-pass.md) |
| 5 EMIT | `compiler/emit/` | MQL, one target per root position; the Env that tracks scope, levels and captures | [emit-pass.md](emit-pass.md) |

Two more passes sit beside them: `passes/shape.ts` reads a Filter or a Pipeline
off the PARSED program (a `;`, a write or a stage makes a pipeline; a `const`
prelude before one predicate stays a Filter), and `passes/inject.ts` splices the
values a call supplied — `jsmql.compile` parameters, template slots — into the
tree as literals or as `Injected` nodes, so that nothing a caller passes is ever
read as syntax, an operator or a field reference (HR1).

## The emit targets

| Root | Entry | Module | Output |
|---|---|---|---|
| `value` | `jsmql.expr` | `emit/lower.ts` | an aggregation expression |
| `filter` | `jsmql.filter`, `jsmql()` without a statement | `emit/filter.ts` | a query document, `$expr` where the query language has no clause |
| `statement` | `jsmql.pipeline`, `jsmql()` with one | `emit/statement.ts` (+ `join.ts`, `union.ts`, `reduce-wrap.ts`) | a stage array |
| `updateDoc` | `jsmql.update` | `emit/update.ts` | the update document `updateOne` takes |

Inside a target, a position is a cell of the row: a stream link (`$$.filter(…)`)
runs the row's `stream` cell, a `$group` output field its `group` cell, a
`$setWindowFields.output` entry its `window` cell. `emit/consult.ts` finds the
cell, `emit/select.ts` picks the rule the receiver and the arguments select,
`emit/check.ts` runs the literal-gated checks the row states (`args`, `body`),
`emit/inputs.ts` builds the record a cell receives (`ExprIn`, `FilterIn`, `StageIn`,
`GroupIn`) — the services a lowering needs, never an import.

## The public surface (`src/index.ts`)

`jsmql` is a callable with properties: `jsmql(input)`, `jsmql.expr`,
`jsmql.filter`, `jsmql.pipeline`, `jsmql.update`, each with a `.compile`, and
`jsmql.validate`. Every one takes the three call shapes — a string, an arrow (its
source read with `Function.prototype.toString`; the entry form binds parameters),
a template tag (each slot a bound value). The module turns input into source and
values, runs the compiler from the root the entry states, and maps the errors
to `validate()` results. See [strict-shape-entries.md](strict-shape-entries.md),
[function-form-params.md](function-form-params.md).

## Error types

| Class | Thrown by | `.pos` |
|---|---|---|
| `LexError` | `compiler/lex` | the offending character |
| `ParseError` | `compiler/parse`, and `index.ts` for an input that is not the entry form (`FunctionInputError`) | the offending token |
| `CodegenError` | every emit refusal (`compiler/emit/errors.ts`); `UnknownIdentifierError` is one | the node that failed |
| `JsmqlInterpolationError` | `index.ts`, a slot or parameter with no MQL representation | 0 — use `.slot` / `.key` |

`validate()` maps the first two to `SYNTAX_ERROR`, the third to `CODEGEN_ERROR`,
and never throws.
