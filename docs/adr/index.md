# Architecture decision records

See [CLAUDE.md](CLAUDE.md) for when to write an ADR and its format.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-api-compile-fresh-document.md) | A compile builder gives a new document on each call | Accepted |
| [0002](0002-bson-constant-construction.md) | How bsonConstant reads a constant | Accepted |
| [0003](0003-cli-params-map.md) | The CLI keeps parameters in a Map | Accepted |
| [0004](0004-codegen-lowering-small-decisions.md) | Small lowering decisions that the codegen suite records | Accepted |
| [0005](0005-codegen-refusal-wording.md) | Which refusal wins, what a refusal may suggest, and which fact it names | Accepted |
| [0006](0006-compiler-env-invariants.md) | The Env record has no optional field, and each transition changes one thing | Accepted |
| [0007](0007-constant-engine-internals.md) | Small decisions inside the constant engine (evaluate.ts, date-literal.ts) | Accepted |
| [0008](0008-emit-array-slice-counts.md) | Array slice lowerings never emit a three-argument $slice with a zero count | Accepted |
| [0009](0009-emit-check-literal-gates.md) | Server facts behind the literal checks in check.ts | Accepted |
| [0010](0010-emit-consult-verdicts.md) | The verdict model of consult.ts | Accepted |
| [0011](0011-emit-filter-measured-shapes.md) | The filter road anchors with \z and writes the $regex operator form | Accepted |
| [0012](0012-emit-filter-query-constants.md) | Which values the query language compares as written | Accepted |
| [0013](0013-emit-filter-raw-query-document.md) | A raw query document keeps its keys and lifts run-time reads into $expr | Accepted |
| [0014](0014-emit-inputs-callback-binding.md) | How inputs.ts binds callbacks and words the refusal of a callback slot | Accepted |
| [0015](0015-emit-internal-binding-names.md) | The compiler encodes every variable name injectively, and a minted name never captures a user name | Accepted |
| [0016](0016-emit-join-lowering-rules.md) | Rules for correlation paths and chain routing in the join road | Accepted |
| [0017](0017-emit-join-slot-value.md) | The join road reads its slot through a minted name and records the chain proof | Accepted |
| [0018](0018-emit-let-rewind-slot.md) | A rewound declarator gives its scratch slot back | Accepted |
| [0019](0019-emit-lower-calls.md) | Calls, logical values and blocks in lower.ts | Accepted |
| [0020](0020-emit-lower-reads.md) | How lower.ts locates and renders a read of a field | Accepted |
| [0021](0021-emit-lower-value-literals.md) | Small value-road decisions in lower.ts for literals, guards and update keys | Accepted |
| [0022](0022-emit-operand-list-array-wrap.md) | An array literal that is a value goes one level deeper in an operand slot | Accepted |
| [0023](0023-emit-reduce-accumulator-narrowing.md) | A reduce accumulator narrows to object or array when seed and body agree | Accepted |
| [0024](0024-emit-reduce-wrap-seed.md) | The reducer wrap folds a constant seed into the result | Accepted |
| [0025](0025-emit-select-rules.md) | Small rule-selection decisions in select.ts | Accepted |
| [0026](0026-emit-sort-spec.md) | How sort-spec.ts reads directions and whole-element keys | Accepted |
| [0027](0027-emit-statement-dispatch.md) | How the statement target routes a statement, a chain link and a stage body | Accepted |
| [0028](0028-emit-statement-placement.md) | The statement target judges the place of every name that a stage document holds | Accepted |
| [0029](0029-emit-statement-writes.md) | How the statement target lowers a write, a stream assignment and a root replacement | Accepted |
| [0030](0030-entry-expr-refuses-stage.md) | jsmql.expr refuses a stage call, because the server refuses both readings of the result | Accepted |
| [0031](0031-errors-leaf-module.md) | errors.ts imports nothing from the compiler | Accepted |
| [0032](0032-fixture-dataset-boundary-user.md) | The fixture holds a user with no email field, beside a user with a null email | Accepted |
| [0033](0033-fixture-scratch-role.md) | The scratch user holds one custom role with readWrite, dbAdmin and indexStats | Accepted |
| [0034](0034-fixture-server-signals.md) | How the fixture code reads the server's answer to a shutdown and to a failed connection | Accepted |
| [0035](0035-fold-scope-and-collapse.md) | Which names the fold may replace, and how a program collapses to a Filter | Accepted |
| [0036](0036-fold-server-agreement.md) | The fold computes only what the server computes, and the fold-agreement suite proves it | Accepted |
| [0037](0037-globals-generator-details.md) | Small type decisions in the globals generator | Accepted |
| [0038](0038-index-entry-mechanics.md) | Error frames and entry-form details in the public entry (index.ts) | Accepted |
| [0039](0039-interpret-dates-rules.md) | The measured rules of the date interpreter | Accepted |
| [0040](0040-interpret-family-rules.md) | Small measured limits in the interpreter's operator families | Accepted |
| [0041](0041-interpret-measured-rules.md) | Measured server rules and limits in the interpreter value model and rule helpers | Accepted |
| [0042](0042-interpret-regex-subset.md) | The interpreter runs only the regex syntax that PCRE2 and JavaScript share, printed as a new JavaScript pattern | Accepted |
| [0043](0043-join-collapse-unwrap.md) | A collapsing terminal on a join unwraps the one-element lookup result | Accepted |
| [0044](0044-levenshtein-suggestion-rules.md) | Thresholds and self-exclusion of the closest-name suggestion | Accepted |
| [0045](0045-lex-table-driven-lexer.md) | The lexer reads its punctuators and keywords from registry rows, and scanners decide where a token ends | Accepted |
| [0046](0046-literal-value-bridge.md) | How a computed or injected value goes back into the tree (literal.ts, inject.ts) | Accepted |
| [0047](0047-mongoose-plugin-wrapper-internals.md) | Shape of each mongoose wrapper, and the type-only import for the augmentation | Accepted |
| [0048](0048-namespace-compiler-names.md) | The three compiler namespaces and the constraints on each spelling | Accepted |
| [0049](0049-parse-js-faithful-refusals.md) | The parser refuses what JavaScript refuses, where it sits, with a message that names the fix | Accepted |
| [0050](0050-parse-pratt-parser-design.md) | One row-driven Pratt loop, a name-blind parser, and one shared reader for each repeated question | Accepted |
| [0051](0051-passes-desugar-rules.md) | Invariants of the desugar rules that the desugar spec does not state | Accepted |
| [0052](0052-passes-naming-walk.md) | Binders, minted parameter names, and the context walk (naming.ts, fresh.ts, walk.ts) | Accepted |
| [0053](0053-passes-no-new-timing.md) | The HR8 check runs on the parsed tree, and leaves two cases to the emit phase | Accepted |
| [0054](0054-playground-sync-extraction.md) | How the playground sync loads, formats and stamps the examples | Accepted |
| [0055](0055-position-edge-clauses.md) | Clauses of the position edge that the spec does not state | Accepted |
| [0056](0056-realistic-examples.md) | The realistic examples drive the playground through test metadata | Accepted |
| [0057](0057-registry-agrees-crossrefs.md) | Runtime cross-reference checks of the registry rows | Accepted |
| [0058](0058-registry-ast-design.md) | A name-blind AST, and the facts that its nodes carry | Accepted |
| [0059](0059-registry-keywords-boundary.md) | What makes a word a keyword, and the one-way edge to productions | Accepted |
| [0060](0060-registry-mql-builders.md) | Pure MQL builders in src/registry/mql.ts and the server facts they obey | Accepted |
| [0061](0061-registry-names-array-aggregates.md) | Measured answers of the array aggregate methods | Accepted |
| [0062](0062-registry-names-array-rows.md) | Filter, stream and value forms of the array method rows | Accepted |
| [0063](0063-registry-names-cell-helpers.md) | Shared cell helpers in names.ts and the null rules they obey | Accepted |
| [0064](0064-registry-names-date-methods.md) | Date method offsets and part families | Accepted |
| [0065](0065-registry-names-mongo-spec-fields.md) | Operator facts on a mongo row | Accepted |
| [0066](0066-registry-names-null-facts.md) | The null and missing facts on a row, and how each is measured | Accepted |
| [0067](0067-registry-names-object-methods.md) | Measured results of the object methods | Accepted |
| [0068](0068-registry-names-query-operators.md) | Server constraints on $nor, $text and $where | Accepted |
| [0069](0069-registry-names-refusals.md) | Refusals of JavaScript spellings that have a JSMQL equivalent | Accepted |
| [0070](0070-registry-names-roots-globals.md) | Positions of the root and scope rows, and constant globals | Accepted |
| [0071](0071-registry-names-row-rules.md) | Per-row server facts for conversions, BSON values, dates and accumulators | Accepted |
| [0072](0072-registry-names-scalar-methods.md) | Null and boundary rules of the number and string methods | Accepted |
| [0073](0073-registry-names-spec-fields.md) | Meaning of the NameSpec and RootSpec fields in names.ts | Accepted |
| [0074](0074-registry-names-stage-facts.md) | Stage facts on a mongo row, and the per-stage server facts behind them | Accepted |
| [0075](0075-registry-names-stream-cells.md) | Decisions in the stream cells of the array methods | Accepted |
| [0076](0076-registry-names-string-rows.md) | Filter and value forms of the string method rows | Accepted |
| [0077](0077-registry-names-type-audits.md) | How the registry type-level audits stay sound | Accepted |
| [0078](0078-registry-names-type-tests.md) | Server constraints behind the value cells of the type-test rows | Accepted |
| [0079](0079-registry-productions-measured-returns.md) | Measured result kinds of the arithmetic and bitwise productions | Accepted |
| [0080](0080-registry-productions-query-cells.md) | The native query forms of the comparison productions | Accepted |
| [0081](0081-registry-productions-spec-fields.md) | The non-obvious fields of a production row | Accepted |
| [0082](0082-registry-tokens-lexer-facts.md) | The lexer facts that the token rows state | Accepted |
| [0083](0083-registry-vocabulary-argtypes.md) | Argument types and arity rules, with their measured refusals | Accepted |
| [0084](0084-registry-vocabulary-cell-rules.md) | The vocabulary types make every cell total over positions and receiver families | Accepted |
| [0085](0085-registry-vocabulary-core.md) | The division of the registries and the core dispatch axes | Accepted |
| [0086](0086-registry-vocabulary-iteratee-slots.md) | The spellings that stand in for an arrow in an iteratee slot | Accepted |
| [0087](0087-registry-vocabulary-kinds-bson.md) | BSON kinds that the type tracker uses | Accepted |
| [0088](0088-registry-vocabulary-positions.md) | One position, one cell, and the cell kinds | Accepted |
| [0089](0089-registry-vocabulary-query-helpers.md) | The query-document helpers and the typeof vocabulary | Accepted |
| [0090](0090-registry-vocabulary-renderer-services.md) | The contracts of the services that a renderer receives | Accepted |
| [0091](0091-registry-vocabulary-typeexpr.md) | The TypeExpr grammar and the callback parameter kinds | Accepted |
| [0092](0092-rows-readers.md) | Decisions inside the registry readers (rows.ts) | Accepted |
| [0093](0093-scripts-expectations-tools.md) | How the expectation tools decide what the compiler answers | Accepted |
| [0094](0094-scripts-merge-devlog.md) | The rules of the DEVLOG merge resolver | Accepted |
| [0095](0095-security-prototype-field-names.md) | A field name that matches a prototype member stays ordinary data | Accepted |
| [0096](0096-stream-group-key-errors.md) | A message from a shared stream helper names the calling method, and never a receiver | Accepted |
| [0097](0097-stream-scratch-cleanup.md) | Scratch slots are cleared once, at the namespace root | Accepted |
| [0098](0098-test-accumulator-agrees-suite.md) | The accumulator-agreement suite excludes data-type errors, and reduces an array literal per document | Accepted |
| [0099](0099-test-agreement-suites.md) | The agreement suites compare two readings of one source on a live server, and sort each source into AGREE, DIVERGE or SAME_QUERY | Accepted |
| [0100](0100-test-bson-majors-assertions.md) | How the bson-majors suite asserts behaviour that differs between bson majors | Accepted |
| [0101](0101-test-callback-block-let-predicate.md) | A block predicate folds before the join road classifies it, and its bindings ride in $expr | Accepted |
| [0102](0102-test-cli-output-evaluated.md) | The CLI tests evaluate the printed JavaScript instead of a JSON parse | Accepted |
| [0103](0103-test-compiler-bson-suite.md) | The BSON suite checks the BSON type tag, builds live values per insert, and relies on measured conversions | Accepted |
| [0104](0104-test-compiler-desugar-suite.md) | Desugar and fold tests compare against the tree of the explicit form, with provenance erased | Accepted |
| [0105](0105-test-compiler-live-suites.md) | How the compiler live suites account for every source they run | Accepted |
| [0106](0106-test-consult-registry-audits.md) | The consult suite audits the whole registry table, and each audit encodes one rule of the rows | Accepted |
| [0107](0107-test-cross-realm-bytes.md) | The cross-realm test compares a Uint8Array as its list of bytes | Accepted |
| [0108](0108-test-deferred-coverage-gates.md) | How the deferred-coverage test scans the surface and reads docs/DEFERRED.md | Accepted |
| [0109](0109-test-deliberately-invalid-shapes.md) | Each deliberately invalid pass-through shape in a test records why the server refuses it | Accepted |
| [0110](0110-test-fold-consistency-gate.md) | The fold-consistency suite compares each constant fold with the server lowering | Accepted |
| [0111](0111-test-integration-live-hazards.md) | The integration suite runs the shapes that only a live server can prove | Accepted |
| [0112](0112-test-iteratee-slots-audit.md) | The iteratee-slots suite re-measures each declared slot form | Accepted |
| [0113](0113-test-kinds-expectations.md) | The kind facts behind the HR7 expectations in compiler-kinds.test.ts | Accepted |
| [0114](0114-test-literal-passthrough-probe.md) | The literal pass-through probe builds a minimal call for each operator | Accepted |
| [0115](0115-test-lower-value-shapes.md) | The server facts behind the value shapes in compiler-lower.test.ts | Accepted |
| [0116](0116-test-merge-whenmatched-gate.md) | A live gate checks the `$merge.whenMatched` stage set against the server | Accepted |
| [0117](0117-test-methods-js-parity.md) | How compiler-methods.test.ts compares each method with JavaScript | Accepted |
| [0118](0118-test-methods-null-facts.md) | How the tests prove the null facts that let the compiler drop an $ifNull | Accepted |
| [0119](0119-test-methods-server-guards.md) | The measured server limits that shape the guards of the method lowerings | Accepted |
| [0120](0120-test-mongoose-mock-design.md) | The mongoose plugin tests use a mock Model, not a real connection | Accepted |
| [0121](0121-test-names-invariants.md) | The invariants of the variable names that the compiler writes | Accepted |
| [0122](0122-test-no-default-port-guard.md) | A test enforces the single-server rule and the scratch database grant | Accepted |
| [0123](0123-test-operator-spec-coverage.md) | Rules of the operator-spec coverage test for names outside the pinned spec | Accepted |
| [0124](0124-test-packaging-guards.md) | Packaging, site and runner guards check the published artifacts | Accepted |
| [0125](0125-test-parse-js-subset.md) | The JavaScript syntax rules that compiler-parse.test.ts holds the parser to | Accepted |
| [0126](0126-test-permutations-matrix.md) | The permutation suite compiles and runs every ordered pair of chain methods | Accepted |
| [0127](0127-test-position-census.md) | The measured slot behaviour that the position pass must reproduce | Accepted |
| [0128](0128-test-registry-audits.md) | Registry and AST audits read the source and fail in both directions | Accepted |
| [0129](0129-test-returns-agrees.md) | How compiler-returns-agrees.test.ts measures every returns fact on mongod | Accepted |
| [0130](0130-test-select-rules.md) | How the selector picks the rule of a row in compiler-select.test.ts | Accepted |
| [0131](0131-test-shape-pass.md) | How compiler-shape.test.ts checks which document a program becomes | Accepted |
| [0132](0132-test-string-form-sources.md) | A test that needs a trailing comma in an arrow uses the string entry | Accepted |
| [0133](0133-test-support-comparators.md) | Test helpers compare answers by meaning, with independent oracles | Accepted |
| [0134](0134-types-globals-completion-fixture.md) | The globals completion fixture states what TypeScript cannot read itself | Accepted |
| [0135](0135-project-projection-form-operators.md) | Projection-form operators in a `$project` body | Rejected |
| [0136](0136-stream-from-the-end-methods.md) | "From the end" array methods on a document stream | Rejected |
| [0137](0137-cli-sort-keys.md) | A key-sorting flag for the CLI (`-S` / `--sort-keys`) | Rejected |
| [0138](0138-match-negation-de-morgan.md) | Negation distributed by De Morgan in `$match` | Rejected |
| [0139](0139-in-as-key-test.md) | `in` as JavaScript's key test | Rejected |
| [0140](0140-no-set-type.md) | `Set` in JSMQL | Rejected |
| [0141](0141-one-spelling-per-capability.md) | A second spelling for one capability | Rejected |
| [0142](0142-random-floating-argument.md) | lodash's `floating` argument of `.random()` | Rejected |
| [0143](0143-spread-in-op-escape-hatch.md) | Spread in the `$op(…)` escape hatch | Rejected |
| [0144](0144-no-checks-on-escape-hatch.md) | Checks on the escape hatch | Rejected |
| [0145](0145-no-suggestion-for-unknown-dollar-name.md) | A suggestion for an unknown `$name` | Rejected |
| [0146](0146-no-string-spread.md) | A spread of a string into its characters | Rejected |
| [0147](0147-let-peephole.md) | `$let` as an optimisation (peephole) | Rejected |
| [0148](0148-no-runtime-constraint-validation.md) | Compile-time validation of runtime-dependent pipeline constraints | Rejected |
| [0149](0149-replace-root-verbose-knob.md) | A `$replaceRoot` verbose-form knob on `$ = …` | Rejected |
| [0150](0150-nested-operator-dollar-string-wrap.md) | A wrapper for nested-operator `$`-strings ("Model A") | Rejected |
| [0151](0151-lodash-methods-without-mql-form.md) | lodash array methods with no clean MQL form | Rejected |
| [0152](0152-object-receiver-methods-no-completion.md) | Ambient completion for object-receiver value methods | Rejected |
| [0153](0153-no-silent-output-drift.md) | The output shape never depends on a heuristic or on the data | Accepted |
| [0154](0154-compile-defaults-refused.md) | A parameter destructure of jsmql.compile takes no default value | Accepted |
| [0155](0155-compile-string-placeholder.md) | A placeholder syntax inside the source string of jsmql.compile | Rejected |
| [0156](0156-strict-shape-entries.md) | Strict-shape entries beside the polymorphic jsmql() | Accepted |
| [0157](0157-stringify-javascript-source.md) | jsmql.stringify writes JavaScript, with one spelling for each BSON type | Accepted |
| [0158](0158-mongoose-plugin-surface.md) | What the mongoose plugin patches, and how it reads an argument | Accepted |
| [0159](0159-globals-context-ref-types.md) | The ambient types of the context references $$, $$$ and $$$$ | Accepted |
| [0160](0160-globals-value-method-augmentation.md) | How the globals add the value methods to the built-in interfaces | Accepted |
| [0161](0161-bson-peer-dependency.md) | bson is a peer dependency | Accepted |
| [0162](0162-value-recognition.md) | Recognition reads what a value is, not the class or the realm that made it | Accepted |
| [0163](0163-bson-live-values.md) | JSMQL emits a live BSON value, and the fold does not compute with it | Accepted |
| [0164](0164-filter-or-per-branch.md) | A `||` in a filter lowers each branch on its own | Accepted |
| [0165](0165-filter-negation-complement.md) | `!p` in a filter is the `$nor` complement of p's own clause | Accepted |
| [0166](0166-join-correlated-equality-pair.md) | A join that opens with a correlated equality is the `localField` / `foreignField` pair | Accepted |
| [0167](0167-type-dispatch-is-switch.md) | Every runtime type dispatch is a `$switch` | Accepted |
| [0168](0168-concat-reads-each-argument.md) | `.concat()` tests each argument that the proof cannot place | Accepted |
| [0169](0169-destination-visible-prefixes.md) | Root-replacing sugar starts with `$ =`, and other sugar names its destination | Accepted |
| [0170](0170-root-replace-is-replacewith.md) | `$ = <expr>` lowers to `$replaceWith`, not `$replaceRoot` | Accepted |
| [0171](0171-root-pick-omit-stream-road.md) | `$ = $.pick([…])` and `$ = $.omit([…])` take the stage of the stream cell | Accepted |
| [0172](0172-stream-method-decisions.md) | Small decisions about the stream methods | Accepted |
| [0173](0173-stream-replace-rejected-forms.md) | `$$ = cond ? A : B` and `$$.find(p)` have no lowering | Rejected |
| [0174](0174-stream-size-conservative-reuse.md) | A stream count is reused only where a row proves it fresh | Accepted |
| [0175](0175-diagnostic-stage-scopes.md) | The diagnostic stages live on `$$` and `$$$$`, and the sugar checks their scope | Accepted |
| [0176](0176-assert-through-convert.md) | `assert` fails through an unknown type name in `$convert` | Accepted |
| [0177](0177-let-binding-field-storage.md) | A pipeline `let` lives in a field under `__jsmql.var`, and a read names it bare | Accepted |
| [0178](0178-functions-inline-per-call.md) | A reusable function is a named IIFE that each call inlines | Accepted |
| [0179](0179-chained-stage-links.md) | A stage can be a link of a chain on a stream | Accepted |
| [0180](0180-arrow-output-type-narrowing.md) | Only a block-bodied arrow narrows the output type of `jsmql()` | Accepted |
| [0181](0181-context-reference-prefixes.md) | The scopes are the prefixes `$$`, `$$$` and `$$$$`, one node type each | Accepted |
| [0182](0182-raw-mql-check-before-inject.md) | The HR6 check reads the tree as the parser gives it | Accepted |
| [0183](0183-desugar-pass-design.md) | One source-to-source pass removes every sugar before lowering, and carries the position with each node | Accepted |
| [0184](0184-truth-test-lowering.md) | The truth test catches a missing value, and a boolean position drops the operand-preserving `$cond` | Accepted |
| [0185](0185-position-answered-on-the-way-down.md) | The position pass answers on the way down, and a target is not a value | Accepted |
| [0186](0186-env-changes-once-per-stage-group.md) | The Env changes once per group of stages, where the group stands | Accepted |
| [0187](0187-no-gt-empty-string-truth-test.md) | One comparison against "" as the truth test of a string | Rejected |
| [0188](0188-live-suite-skip-rule.md) | A live suite skips only when no server answers, and states how much of its server half ran | Accepted |
| [0189](0189-fixture-own-auth-instance.md) | The project runs its own auth-enabled mongod for the fixture | Accepted |
| [0190](0190-no-invented-dollar-operators.md) | JSMQL never invents its own `$`-prefixed operator | Accepted |
| [0191](0191-union-stage-non-goals.md) | The union road refuses a correlated read and checks no server version | Rejected |
