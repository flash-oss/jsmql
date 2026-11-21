# 0175. The diagnostic stages live on `$$` and `$$$$`, and the sugar checks their scope

Status: Accepted
Applies to: the `diagnostic` fact in `src/registry/names.ts`, docs/specs/system-stages.md

## Context

MongoDB's diagnostic source stages (`$indexStats`, `$currentOp`, …) produce a stream, and each runs at one scope. The stage call already compiles them (`$indexStats({})`). JSMQL has three context prefixes beyond `$.`: `$$`, `$$$` and `$$$$`.

## Decision

- The sugar `$$.<stage>()` and `$$$$.<stage>()` exists for discoverability and for the scope check. It adds no new compile capability. A stage at the wrong scope is a compile-time error. For example, `$indexStats` through `db.aggregate()` never reaches the driver.
- There are two tiers, not three. MongoDB requires the cluster stages to run on the admin database. For example, `$listSessions` reads the cluster-wide `config.system.sessions`, never the current application database. `$$$` means the current database, so `$$$.currentOp()` reads as "ops in this database", which the server cannot run. So these stages live on `$$$$`, and `$$$` carries no diagnostics.
- The sugar follows the convention that the source shows after the prefix. A diagnostic is a read from a source, like `$$$.<coll>.find(...)`, and the prefix names what the stage reads from.

## Consequences

A new diagnostic stage states its scope in the `diagnostic` fact of its row, on `$$` or `$$$$`.
