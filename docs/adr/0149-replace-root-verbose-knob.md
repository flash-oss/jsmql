# 0149. A `$replaceRoot` verbose-form knob on `$ = …`

Status: Rejected
Applies to: the `$ = …` sugar, `docs/specs/replace-root-stage.md`

## Context

`$ = <expr>` lowers to the lean `$replaceWith` shape. The idea: add a knob that opts into the verbose, 4.0-compatible `$replaceRoot({ newRoot: … })` form.

## Decision

JSMQL does not add the knob. The lean `$replaceWith` shape is correct for the `$ = …` sugar. A knob adds API surface for no gain.

## Consequences

- A developer who needs the `$replaceRoot` shape writes the stage call directly.
- Reconsider only if a supported server version refuses `$replaceWith`.
