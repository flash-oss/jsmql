# docs/adr/ — architecture decision records

An ADR records one non-obvious decision about the code. It states why the code
does not use the obvious method. Source code holds no comments (see § No comments
in code in the root [`CLAUDE.md`](../../CLAUDE.md)). So an ADR holds a reason that
the code does not show and that no spec states.

## When to write an ADR

- Write one when a reader of the code would ask "why not the simple way?", and
  the answer is not in `docs/specs/`, `docs/LANG_RULES.md` or a `CLAUDE.md` file.
- Do not write one for a rule that a spec owns. Change the spec instead.
- Do not write one for a shortcut that needs a fix. Report the shortcut to the developer instead.

## Format

One file per decision, `NNNN-<slug>.md`, with the next free number. Each file has
these sections:

```
# NNNN. <decision title>

Status: Accepted
Applies to: <the files or functions the decision shapes>

## Context
## Decision
## Consequences
```

An ADR may record a short list of small decisions about one module, when they
share one context.

## Conventions

- An ADR states what is true now. When a decision changes, edit the ADR or mark it
  `Status: Superseded by NNNN`. The history of the change goes in `docs/DEVLOG/`.
- Name code by its exact identifier, so a search finds the ADR.
- Follow [docs/STE.md](../STE.md). Do not quote an error message.
- [index.md](index.md) lists every ADR with its title. Add a row when you add a file.
