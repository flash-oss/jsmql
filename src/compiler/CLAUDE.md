# src/compiler/

The compiler, built as five phases over `src/registry/`. Each phase reads the ONE
registry file that owns its facts and invents nothing a row could have stated.

```
  ┌────────────┐   ┌────────────┐   ┌───────────┐   ┌────────────┐   ┌──────────┐
  │  1. LEX    │──►│  2. PARSE  │──►│ 3.DESUGAR │──►│ 4.POSITION │──►│  5.EMIT  │
  └─────┬──────┘   └─────┬──────┘   └─────┬─────┘   └─────┬──────┘   └────┬─────┘
        │                │                │               │               │
   tokens.ts        productions.ts    names.ts        productions.ts   names.ts
   keywords.ts                                        + names.ts
```

## The one rule that shapes everything

**The registry says what the language HAS. It does not say how to build the MQL.**

A row answers: does this name exist, what is it called, what may it attach to, in
which of the seven positions is it legal, how many arguments does it take there,
and what does the error say when it is not. A row does NOT hold a renderer,
because a lowering reads its NEIGHBOURS — the receiver's provable type, the stages
already emitted, the shape of a sibling argument — and a single row cannot see
any of that. Lowerings are code, and they live in `emit/`.

So when a phase needs a fact about the language, it reads a row. When it needs to
produce a document, it calls a function here.

## Layout

```
index.ts       source → MQL. The only public entry.
errors.ts      every message built from the registry's own text.

lex/
  token.ts     the Token record and the source-position helpers.
  lexer.ts     the longest-match loop over `TOKENS`, plus the four rules a table
               cannot imply: maxRun, chooseBy, tracksDepth, resumesTemplateAtDepth.
  scanners.ts  number, string, template, regex, identifier. Algorithms, not tables:
               a table says which spelling makes which token, a scanner decides
               where a token ENDS.

parse/         the Pratt loop driven by precedence / associativity / fixity.
passes/        desugar (source → source), then position (the output shape).
emit/          the lowerings, and the dispatcher that checks a row before running one.
```

## Conventions

- **No name is hard-coded.** If the compiler branches on a literal name (`"Math"`,
  `"$match"`, `".push"`), that fact belongs in a row instead. The one exception is
  a token spelling inside a scanner, where the character IS the algorithm.
- **Every rejection quotes the registry.** A message is either a row's own
  `unsupported(...)` text or built from a row's `args.sig`. No phase writes prose
  the registry could have carried.
- **Positions come from `where`, never from a tree probe.** If a construct is
  legal somewhere, its row says so, and phase 4 reads it.
- **Strippable TypeScript only**, same as the rest of `src/` — see `src/CLAUDE.md`.
