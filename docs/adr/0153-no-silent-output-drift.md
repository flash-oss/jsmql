# 0153. The output shape never depends on a heuristic or on the data

Status: Accepted
Applies to: the compiler, `jsmql.stringify`, the CLI

## Context

A compiler can make some output faster or shorter with a rewrite. Examples are a negation that it distributes, a key order that it sorts, or a stage that it picks from a guess about a later reshape. Each such rewrite changes the MQL that a developer reads, and sometimes its meaning or its use of an index.

## Decision

JSMQL emits the shape that the source states. It never picks an output shape from a heuristic, from the data, or from a guess about what a later stage does. It never reorders the keys of a document. The developer can predict the MQL from the source, and the same source always gives the same MQL.

## Consequences

A proposal for an optimisation that rewrites the output shape conflicts with this decision. Such a proposal must state why the developer can still predict the output. Each rejected ADR that cites this principle shows a case.
