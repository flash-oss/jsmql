# 0181. The scopes are the prefixes `$$`, `$$$` and `$$$$`, one node type each

Status: Accepted
Applies to: `src/registry/tokens.ts`, `src/registry/ast.ts`, docs/specs/context-references.md, docs/specs/lookup-stage.md

## Context

JSMQL needs a spelling for the current collection, a collection of the current database, and a collection of another database. `this.<coll>.find(pred)` reads well. `this` is a JavaScript reserved word, and a parser refuses it outside a class or a method body, so `({ $ }) => this.users.find(...)` does not parse as a `.js` file.

## Decision

- The scopes are the context-reference prefixes `$$`, `$$$` and `$$$$`. They parse anywhere, so they keep JSMQL a strict subset of JavaScript. They never collide with the host language, and with `$.` they give one vocabulary for the four scopes.
- Each prefix has its own node type (`StreamRef`, `DatabaseRef`, `ClusterRef`), not one `ContextRef { depth }` node. Each level carries a different surface. A database reference needs a collection after it. A cluster reference needs a database and a collection. `$$` is a stream on its own. So each node matches on its own type, not on a depth count.

## Consequences

A new scope gets its own token and node type.
