# 0001. A compile builder gives a new document on each call

Status: Accepted
Applies to: `test/strict-api.test.ts`

## Context

mongoose casts a filter in place: it changes the objects and arrays of the document that it receives. A `.compile` builder that returns a shared object would let one call change the answer of a later call.

## Decision

Each call of a builder from `jsmql.compile`, `jsmql.expr.compile`, `jsmql.pipeline.compile` and `jsmql.update.compile` returns a new document. `test/strict-api.test.ts` changes every object and array in one answer, and checks that the next answer equals the answer of a new builder.

## Consequences

A cache or a constant fold in the builder must copy its output before it returns it.
