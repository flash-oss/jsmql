# 0159. The ambient types of the context references $$, $$$ and $$$$

Status: Accepted
Applies to: `contextRefBlock`, `stageLinkMembers` and `streamMethodMembers` in `scripts/generate-globals.mjs`

## Context

`src/globals.ts` declares the context references, so that arrow code such as `$$.indexStats()` or `$$$.orders.find(…)` type-checks. The refs take part in more syntax than a read: `$$ = …` replaces the stream, `$$$.coll = …` writes a collection, and a chain keeps the rules of its root.

## Decision

- `$$` is a `var`, because the `$$ = …` sugar assigns to it. A `const $$` makes TypeScript refuse that valid JSMQL. `$$$` and `$$$$` are `const`, because they take only a property write (`$$$.coll = …`), which `const` permits. `const` still flags the invalid `$$$ = …`.
- `JsmqlStreamRef` (the type of `$$`) extends `JsmqlForeignRef` (the type of `$$$.<coll>`). `$$$.<coll>` is both a read head and the target of an `$out` write (`$$$.archive = $$`). TypeScript checks the named members of a target against the declared members of the source, never through its index signature. So only inheritance lets `$$$.coll = $$` type-check.
- Each ref declares the chainable vocabulary again, with itself as the return type. `.find` is legal at any position of a foreign chain and at no position of a current-stream chain. One shared return type cannot show that difference. `.find` on the stream ref is a `find(...args: never[]): never` member with a `@deprecated` JSDoc. The member must exist for the `$out` assignment above, but a call to it must fail.
- Each stream method returns the ref interface, not `any`. A method that returns `any` ends the chain type, so the callback parameter of the next link fails `noImplicitAny`. For this reason the refs are named interfaces, not inline types.
- A chained stage call takes a `body: any`, not the generated argument object of the stage. Some stages also take a bare string (`.$unwind("$items")`, `.$merge("coll")`). A named member has no catch-all overload, so a narrower type refuses valid JSMQL. Key completion stays on the statement form, for example `$group({ … })`.
- Each ref has a `[Symbol.iterator]` member, so that `$$.push(...$$$.other)` spreads a ref with no `TS2488`. The refs do not extend `Array<any>`. That does not compile, because the return type of `push` conflicts (`TS2430`). It also shows the mutators and the from-the-end methods that JSMQL refuses on a stream.
- Each ref ends with a permissive tail, `[key: string]: any`. A type for the remaining syntax needs the schema data that DEF-013 tracks. The cost is that TypeScript does not flag a typo in a method that has no name in the type, for example `$$.pus(…)`. The JSMQL parser still refuses it. A narrower tail, such as a `` `$${string}` `` pattern, makes each unlisted form an error on valid JSMQL. That costs more than a missed typo.
- `$$$$` keeps only the plain tail. Its second level names a database, not a collection. A type for it either shows the cross-database reads that `requireSameDbColl` refuses, or opens the same question of write assignability one level down.

## Consequences

The member list of the stream vocabulary appears once for each ref. A change to the vocabulary changes each ref. Removal of the `extends` clause makes `$$$.coll = $$` fail with `TS2739`.
