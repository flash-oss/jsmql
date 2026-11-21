# 0048. Thresholds and self-exclusion of the closest-name suggestion

Status: Accepted
Applies to: `src/levenshtein.ts`

## Context

Every refusal against a closed set of names ends with a suggestion from `didYouMean`. A suggestion that is far from the typed name is noise. A suggestion that repeats the typed name misleads the developer.

## Decision

`closestNameTo` in src/levenshtein.ts returns a candidate only when its edit distance is at most 2. The distance must also be strictly less than the length of the typed name. Thus a short name that has no relation to any candidate gets no suggestion.
The loop skips a candidate that is equal to the typed name. A candidate set can hold that name, because the name can be valid in a different position. For example, a refusal of `.push(...)` in one position must not suggest `.push`. That suggestion gives no help, and it can recommend syntax that does not work at that position.

## Consequences

A change to the thresholds changes the suggestion of every closed-set refusal. Keep the self-exclusion in `closestNameTo`, not at each call site, so that every refusal gets it.
