# 0145. A suggestion for an unknown `$name`

Status: Rejected
Applies to: the `$op(…)` and `$stage(…)` passthrough, `didYouMean` in `src/levenshtein.ts`

## Context

The idea: refuse an unknown `$name` that is near a known name. The compiler would suggest the known name with `didYouMean`, as it does for a JavaScript name.

## Decision

The developer decided that an unknown `$name` passes through, with no suggestion. A suggestion refuses each new MongoDB name that is near a known name. Many real names are near each other: `$gt` and `$gte`, `$sin` and `$sinh`, `$min` and `$minN`.

## Consequences

- `$mtach($.a > 1);` compiles to `[{ $mtach: { $gt: ["$a", 1] } }]`. The server refuses it, because MongoDB has no `$mtach` stage.
- A JavaScript name such as `.pushh()` or `Numberr(x)` keeps its suggestion, because JSMQL owns that closed set.
- Reconsider only if a suggestion can avoid a refusal of a real MongoDB name that the registry does not know.
