# 0132. Rules of the operator-spec coverage test for names outside the pinned spec

Status: Accepted
Applies to: `test/operator-spec-coverage.test.ts`, `test/registry-agrees.test.ts`

## Context

`test/operator-spec-coverage.test.ts` checks the rows of `src/registry/names.ts` against the vendored `mongodb/mql-specifications` YAML at a pinned commit. Some real MongoDB operators have no YAML file at that commit. Some YAML files hold content that the default `js-yaml` schema cannot parse.

## Decision

`REGISTRY_ONLY` lists each registry name that the pinned spec does not define. Each group in the set carries its reason. The update-document operators are there because the pinned commit has no `update/` folder; the reference is the MongoDB manual page for update operators. The Queryable Encryption string operators (for example `$encStrContains`) are there because the spec has no file for them; their shapes come from the MongoDB manual. The BSON type converters that MongoDB added after the pinned commit (for example `$toUUID`) are there for the same reason.
The YAML loader cuts each file at its `tests:` block before it calls `yaml.load`. That block holds custom BSON tags (for example `!bson_int64`) that the default schema rejects. The tests need only the metadata above it. `test/registry-agrees.test.ts` reads the stage YAML the same way.
For an object-form operator, the positional key order of the registry may differ from the order in the spec. A change of that order breaks callers that use the positional form. So the test requires set membership only: each key that the registry exposes for positional use must be an argument name that the spec gives for that operator.

## Consequences

A new registry name with no spec file goes into `REGISTRY_ONLY` with a comment that gives the reason. When a bump of the pinned commit adds a file for such a name, remove the name from `REGISTRY_ONLY`. Do not make the test compare the positional key order.
