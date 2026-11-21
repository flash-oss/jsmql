# 0116. The cross-realm test compares a Uint8Array as its list of bytes

Status: Accepted
Applies to: `test/cross-realm.test.ts`

## Context

`test/cross-realm.test.ts` compiles each value from this realm and from a `vm` realm, and compares the two documents. `toEqual` compares a Date or a RegExp from another realm by value. It holds two typed arrays equal only when they share a constructor, and two realms never share one.

## Decision

`bytesAsArrays` rewrites every Uint8Array in a document as `{ bytes: [...] }` before the comparison. The bytes are what the driver sends, so the comparison checks what matters.

## Consequences

A new binary kind in a cross-realm case needs the same rewrite, or the comparison fails for the wrong reason.
