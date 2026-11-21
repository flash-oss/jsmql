# 0160. How the globals add the value methods to the built-in interfaces

Status: Accepted
Applies to: `valueMethodAugmentationBlock` and `VALUE_METHOD_SKIP` in `scripts/generate-globals.mjs`

## Context

A value method, for example `.uniq()` or `.startOf()`, needs a declaration on the built-in interface of its receiver, so that the editor completes it. Each choice of interface and member shape changes what the editor shows on other types.

## Decision

- Each member is a method, never a property. Method declarations of the same name merge into one overload set, and never collide. A property is the one shape that can cause `TS2717` against another augmentation of the same built-in.
- The date methods go on `Date`. `Date` is a leaf type, so its members appear on dates only. An object-receiver method has no such leaf type, so it gets no declaration: see [ADR 0152](0152-object-receiver-methods-no-completion.md). The augmentation of `Date` costs less than the augmentation of `Number`, which the project accepts. It also removes real false errors, because the date vocabulary of JSMQL past the native accessors has no `lib.d.ts` declaration.
- The methods that return a date, for example `.plus`, have no check of their return category. `MethodReturn` has no `date` member, because these methods return the type of the receiver. So their rows leave `returns` unset, and they take the skip.

## Consequences

A row that adds `returns: "date"` with no matching `inCategory` row breaks the build.
