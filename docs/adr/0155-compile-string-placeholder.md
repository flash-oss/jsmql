# 0155. A placeholder syntax inside the source string of jsmql.compile

Status: Rejected
Applies to: `jsmql.compile` with a string input, and the strict `.compile` builders

## Context

`jsmql.compile` accepts the source of a parameterised arrow as a string. One idea gives that string a placeholder syntax, for example `${name}` or `$1`, as a second way to declare a parameter.

## Decision

JSMQL rejects the idea. The destructure pattern of the arrow stays the one way to declare a parameter. Two reasons apply:

- `${id}` is not valid JavaScript outside a template literal, so the placeholder breaks the strict JavaScript subset (priority #2 of the root `CLAUDE.md`).
- A placeholder collides with a real template literal. A developer who writes `` jsmql.compile(`… ${id} …`) `` with backticks gets the value of `id` from JavaScript before JSMQL sees the string. No error shows the mistake.

## Consequences

A string input to `jsmql.compile` holds an arrow, the same as the function input. A change that adds a placeholder must first answer both reasons above.
