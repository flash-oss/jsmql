# 0154. A parameter destructure of jsmql.compile takes no default value

Status: Accepted
Applies to: `parseEntry` in `src/compiler/parse/parser.ts`, `jsmql.compile` and the strict `.compile` builders

## Context

A developer can write a default in the params destructure of a compiled arrow, for example `({ minAge = 18 }, { $ }) => …`. The compiler parses the arrow source. It does not run the arrow, so it cannot evaluate a default as JavaScript does.

The developer considered two alternatives:

- Accept only a literal default (`{ a = 1 }`), and refuse a default such as `{ a = config.x }`. The surface looks like normal JavaScript, but it fails on every default that is not a literal. A destructure default in JavaScript accepts any expression, so the failure looks arbitrary. A developer who changes `{ minAge = 18 }` to `{ minAge = config.defaults.minAge }` then gets a refusal with no warning. Priority #1 of the root `CLAUDE.md` forbids such a surprise of the subset.
- Evaluate a default: stringify it, then run it through `Function`. This accepts any expression. But it brings an eval into an API that works at compile time. It also makes JSMQL decide how a reference to an unrelated closure resolves.

## Decision

The compiler refuses every default in the params destructure, whatever its expression. A value reaches a compiled query only through the params object at call time.

## Consequences

The rule is simple, and the surface does not promise more than it does. A developer writes a run-time fallback at the call, for example `q({ minAge: input ?? 18 })`. A fixed value goes in through the template tag, which inlines a literal (`` jsmql`$.age > ${18}` ``).
