# 0169. Root-replacing sugar starts with `$ =`, and other sugar names its destination

Status: Accepted
Applies to: docs/specs/replace-root-stage.md § Convention: all root-replacing sugar starts with `$ =`, docs/specs/out-stage.md

## Context

A sugar statement can replace the document, write the stream to a collection, read another collection, or append to the stream. Each one can use an assignment form.

## Decision

The left side of a sugar statement shows what the statement does to the document. Only sugar that replaces the document root uses `$ = …`, because the bare `$` is the document. `$out` does not replace the root, so it uses the destination prefix `$$$.<coll> = …`. The destination stands on the left, and the source on the right. The left side is the first cue to the reader, so the reader sees the difference at once.

## Consequences

New sugar that replaces the root starts with `$ =`. New sugar that writes elsewhere, reads from elsewhere, or makes a derived stream takes a prefix that names the destination.
