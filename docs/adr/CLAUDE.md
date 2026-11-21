# docs/adr/ — architecture decision records

This folder is the one home for every decision of the project and its reason. An
ADR records one decision: a choice about the language, the API, the code or the
tests, and why the project made it. A rejected idea is a decision too, so it gets
an ADR with `Status: Rejected`.

No other file states a reason for a decision. A spec, a `CLAUDE.md` file,
`docs/DEFERRED.md` and the source code state what is true, and link to the ADR for
the reason. `docs/DEVLOG/` is different: it records the history of each change,
and an ADR change is one more entry there.

## What goes where

- A decision and its reason, accepted or rejected, goes here.
- A rule of a feature, its lowering and its edge cases go in its spec in
  `docs/specs/`. The spec links to the ADR for the reason.
- A convention for a directory, for example where to add a file, goes in the
  `CLAUDE.md` file of that directory.
- An axiom of the language goes in `docs/LANG_RULES.md`.
- Open work goes in `docs/DEFERRED.md`.
- A shortcut that needs a fix is not a decision. Report it to the developer.

## Format

One file per decision, `NNNN-<slug>.md`, with the next free number. Each file has
these sections:

```
# NNNN. <decision title>

Status: Accepted | Rejected | Superseded by NNNN
Applies to: <the files, functions or features the decision shapes>

## Context
## Decision
## Consequences
```

An ADR may record a short list of small decisions about one module, when they
share one context. A rejected ADR states the idea in `## Context` and the reason
for the rejection in `## Decision`.

## Conventions

- An ADR states what is true now. When a decision changes, edit the ADR or mark it
  `Status: Superseded by NNNN`. The history of the change goes in `docs/DEVLOG/`.
- Before you design a feature, search this folder for a rejected ADR on the same
  idea. To reverse a rejection, state why its reason no longer holds.
- Name code by its exact identifier, so a search finds the ADR.
- Follow [docs/STE.md](../STE.md). Do not quote an error message.
- [index.md](index.md) lists every ADR with its title. Add a row when you add a file.
