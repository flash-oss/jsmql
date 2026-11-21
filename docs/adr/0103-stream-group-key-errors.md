# 0103. A shared key helper names the method that called it

Status: Accepted
Applies to: `test/stream-methods.test.ts`

## Context

The `$group`-keyed stream methods (`.countBy`, `.keyBy`, `.uniqBy`, `.groupBy`) reuse the body and parameter helpers of `.map` to lower a computed key. A shared helper can name the wrong method in its error, for example a `.countBy(d => …)` failure that names `.map`, or a `.keyBy` error that names `.countBy`.

## Decision

Each helper takes the name of the calling method and uses it in every message. The example in a message must use the calling method too. The errors of `.keyBy` and `.uniqBy` never show a sibling such as `.countBy("status")`.

## Consequences

A new method that reuses these helpers must pass its own name. Tests assert the method name in each message.
