# docs/ — documentation notes

## Two audiences, two file trees

| Path | Audience | Update when |
|---|---|---|
| `docs/LANGUAGE.md` | Users of jsmql | User-visible behaviour changes |
| `docs/DEVLOG.md` | Future-self / contributors asking "why?" | Every observable change — feature, refactor, naming, doc decision |
| `docs/DEFERRED.md` | Anyone wanting "what's left to do?" / "what did we decide against?" | Adding a new "not yet supported" throw, shipping a deferred item, or recording a "won't implement" decision. See root `CLAUDE.md` § Maintain docs/DEFERRED.md. |
| `docs/specs/*.md` | Claude / contributors implementing jsmql | Code structure or internal behaviour changes |

Never put implementation detail in `LANGUAGE.md`. Never put user-facing examples in the specs.

`DEVLOG.md` is the single historical record — there is no separate CHANGELOG or ROADMAP. Newest entries on top. See the file's own header for the format.

## docs/LANGUAGE.md

The canonical user-facing reference. It must stay in sync with `src/index.ts` and the behaviour of `jsmql()`, `jsmql.compile()`, and `jsmql.validate()` (each polymorphic over the three call shapes — string, arrow, template tag).

When you add a new operator or syntax feature, add a table row or code example here first (docs-driven), then implement it.

## docs/specs/

### Current spec files

| File | Covers |
|---|---|
| `specs/architecture.md` | End-to-end pipeline, data flow, module responsibilities |
| `specs/grammar.md` | Formal grammar (EBNF) for the parser |
| `specs/operator-registry.md` | How operator shapes work, how to add/modify entries |
| `specs/method-dispatch.md` | Method call dispatch, lambda scoping, `asFieldPath()`, `$reduce` remap, regex lexing, template literals, optional chaining, computed keys, spread args |
| `specs/aggregation-stages.md` | Pipeline-stage authoring through `jsmql()`: detection, lowering, sub-pipeline recursion, the `$match` body translation rule. Naming: the driver and our docs both use **Pipeline** for an aggregation stage array. |
| `specs/pipeline-validation.md` | Pre-flight compile-time validation: structural stage placement (must-be-first / must-be-last / forbidden-in-sub-pipeline, declared in the STAGES registry, applied by `makePipelineValidator` in `pipeline.ts`), per-stage body shape (`src/stage-validation.ts`), and `$match` query-operator placement (`$text`-first, `$near`/`$where` bans). The two hard rules (only 100%-certain throws; literal-gating invariant) and the runtime-dependent exclusions live here. |
| `specs/filter-mode.md` | The no-semicolon top-level dispatch: how a bare expression lowers to a Filter (the document `db.coll.find(filter)` takes), the `generateFilter` helper, and the shared `translateMatchBody` engine. Naming: **Filter** matches the Node.js MongoDB driver's `Filter<TSchema>` type. |
| `specs/match-query-translation.md` | The `$match` expression-body → query-language translator (also used by `filter-mode`): full translation table, partial-extraction algorithm, the four documented divergences from aggregation `$eq`, and the `$match({ $expr: ... })` escape hatch. |
| `specs/update-filter.md` | Assignment (`=`, `+=`, `-=`, `*=`, `/=`) and `delete` statements: AST, target validation, coalescing into `$set`/`$unset` stages, pipeline integration. |
| `specs/let-bindings.md` | Pipeline-scoped local variables (`let x = …`): AST, parser/codegen wiring, namespace storage under `__jsmql`, scope-reshaping stage rules, sub-pipeline isolation. |
| `specs/function-form-params.md` | Function-form parameter bindings (`jsmql.compile(fn)`): the three-slot arrow signature, parse-time slot classification, the `bindings` tier on `GenerateCtx`, the inline-literal output shape, and the binding/let name-collision rule. |
| `specs/ops-generation.md` | The `@koresar/jsmql/ops` subpath: how `src/ops.ts` is generated at build time from `OPERATORS` + `STAGES` + the vendored MQL spec, the type-mapping rules, and the drift test. |
| `specs/strict-shape-entries.md` | The strict-shape entry points (`jsmql.filter` / `jsmql.pipeline` / `jsmql.update`): dispatch rules, the shared `lowerToPipelineStages` helper, the update-pipeline stage whitelist, and the error-message contract. |
| `specs/mongoose-plugin.md` | The `@koresar/jsmql/mongoose` plugin: per-method slot table, the string-or-function detection rule, idempotence, subclass propagation, and the CJS-interop fixup. |
| `specs/context-references.md` | The `$$` / `$$$` / `$$$$` prefixes (collection / database / cluster context refs): lexer longest-match tokens, AST marker nodes, parser sanity-guard, and the "reserved-syntax" codegen contract that lets the API surface land incrementally. |
| `specs/lookup-stage.md` | `$$$.<coll>.find/.filter(pred)` → `$lookup` lowering: detection, basic-vs-pipeline-form predicate translation with auto-`let` extraction, block-body lambdas for full sub-pipelines, chained-terminal materialisation (`.length`, `.reduce`, member access), the `__jsmql.__lookup<N>` slot convention, mode gates, and the nested-lookup rejection (planned future work — see the spec's "Future work" section). |
| `specs/union-stage.md` | `$$.push(args...)` → `$unionWith` lowering: detection, JS-faithful spread rules, inline-doc batching into `$documents`, predicate translation (no `let` slot), source-order preservation, and the statement-only/Pipeline-mode-only contract. Shares `extractLetsFromExpr` / `extractLetsFromPipeline` / `extractLookupTarget` with `lookup-stage.md`. |
| `specs/replace-root-stage.md` | `$ = <expr>` → `$replaceWith` / `$facet` lowering: bare-`$` as a primary expression (lowers to `"$$ROOT"`), `AssignExpr`-with-empty-path-target interception, the direct-lookup-RHS leaner form (skips the `$set $first` stage), the four compile-time RHS rejections, the bare-`$` `delete`-target rejection, the `$ = { k: $$.filter(p), … }` facet variant (predicates' lambda param maps to current doc; `$.<field>` rejected with "use lambda param" hint), and the let-scope-clearing thread through `lowerUpdateFilterWithLookups`. Also hosts the cross-cutting "all root-replacing sugar starts with `$ =`" convention. |
| `specs/replace-stream-stage.md` | `$$ = <expr>` → `$match` (narrow) / `$match`+`$unionWith` (source switch): `CollectionRef`-target detection alongside `isReplaceRootAssign`, parser tweaks to accept `$$` as an assignment target, shared `lowerStreamFilterPredicate` with caller-supplied ctx (outer for narrow, fresh sub-pipeline for source switch), `$.<field>`-rejection inside the predicate, and let-scope clearing on the source-switch form only. Defers `$$ = []`, `$$ = <ternary>`, and `$$.find(p)` (self-lookup). |
| `specs/out-stage.md` | `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` lowering: LHS shape detection (one or two `MemberAccess` / `IndexAccess` steps off `DatabaseRef` / `ClusterRef`, dot-and-bracket forms, computed-bracket rejection), RHS chain walker (v1: bare `$$` and `$$.filter(<predicate>)`), `sawOut` last-stage enforcement across all three pipeline entry points, parser `isOutTarget` shape acceptance, mode gates in `index.ts`, and the convention rationale for using a destination-bearing LHS instead of `$ = …`. |
| `specs/system-stages.md` | `$$.indexStats()` / `$$$$.currentOp(…)` / `$$$$.shardedDataDistribution()` → diagnostic / system *source* stage lowering: the two-tier scope model (collection `$$` vs cluster/server `$$$$`; `$$$` has none because the `currentOp` family runs on admin), the scope ↔ stage mapping in the STAGES `diagnostic` field, detection of a direct ref `MethodCall` (and disambiguation from `$lookup`'s `MemberAccess`-wrapped receiver), the `$$`-namespace sharing with `.push`/`.filter`, first-stage-only enforcement, the wrong-scope / unknown-method / arg-shape error catalog, and the Pipeline-mode-only gate. |
| `specs/stream-methods.md` | Registry of chainable JS-array-shaped methods on the RHS of `$$ = …` — currently `.slice`, `.concat`, `.map`, `.toSorted`, `.toReversed`, `.flatMap`. Also covers the `$$ = [{ <key>: $$.reduce(…) }]` wrap pattern: `.reduce` is *not* a chain method (would collapse the stream to a scalar) but is consumed via the explicit array-of-doc wrap, lowering to `$group` + `$replaceWith`. Each chain entry declares an arg-shape validator and a `lower(args, ctx, callPos, lowerBlock, prevStages, allocSlot, inSubPipeline) → { stages, clearLets?, replacesPreviousStage? }`; the chain walker in `pipeline.ts` (`lowerChainOnStream` for `$$` heads, `lowerChainOnCollection` for `$$$.<coll>` heads) reads from it. Adding a method is a registry-entry + tests change, no parser or chain-walker edits. |
| `specs/cli.md` | The `jsmql` command-line bin (`src/cli.ts` → `dist/cjs/cli.cjs`): the `jq`-style stdin→stdout model, input precedence (positional / `--file` / stdin), the output-shape flags (`--filter`/`--pipeline`/`--expr`/`--update`/`--validate`) routing to the matching API entry, formatting (`-c`/`--tab`/`--indent`), jq-style params (`--arg`/`--argjson` → `jsmql.compile`), exit codes, compiler-style caret error rendering, the esbuild version `define`, and the bin build/packaging. |

Future work areas — not yet implemented and not yet specified — include query-predicate operators inside `$match` / Filter (e.g. `$elemMatch`, `$exists`, `$jsonSchema`) — the [Filter dispatch](specs/filter-mode.md) shipped without expanding the query-translatable subset, so anything not already supported by `translateMatchBody` still goes through `$expr` — plus projection operators (`$`, `$elemMatch`, `$slice`, `$meta`), the stage-spec integration for `$group` / `$setWindowFields` accumulator field bindings, and update-document operators (`$inc`, `$push`, `$rename`, …). Add a spec file when the work begins.

### When to update specs

- `architecture.md` — when new pipeline stages or modules are added
- `grammar.md` — when the parser's accepted syntax changes (new constructs, changed rules)
- `operator-registry.md` — when a new operator is added, a shape changes, or the registry lookup logic changes

### Adding a new spec file

Create `docs/specs/<topic>.md` and add a row to the table above. Add a link in the root `CLAUDE.md` file map if it is important enough to surface there.
