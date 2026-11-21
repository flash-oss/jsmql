# Architecture decision records

See [CLAUDE.md](CLAUDE.md) for when to write an ADR and its format.

| ADR | Decision |
|---|---|
| [0001](0001-api-compile-fresh-document.md) | A compile builder gives a new document on each call |
| [0002](0002-bson-constant-construction.md) | How bsonConstant reads a constant |
| [0003](0003-cli-params-map.md) | The CLI keeps parameters in a Map |
| [0004](0004-codegen-lowering-small-decisions.md) | Small lowering decisions that the codegen suite records |
| [0005](0005-codegen-refusal-wording.md) | Rules for which refusal wins and what a refusal may suggest |
| [0006](0006-compiler-env-invariants.md) | The environment record holds three invariants, and a boundary keeps the chain it came from |
| [0007](0007-constant-engine-internals.md) | Small decisions inside the constant engine (evaluate.ts) |
| [0008](0008-emit-array-slice-counts.md) | Array slice lowerings never emit a three-argument $slice with a zero count |
| [0009](0009-emit-check-literal-gates.md) | Server facts behind the literal checks in check.ts |
| [0010](0010-emit-consult-verdicts.md) | The verdict model of consult.ts |
| [0011](0011-emit-env-record.md) | The Env record and its transitions |
| [0012](0012-emit-errors-refusal-wording.md) | How the emit phase words a refusal that a row does not carry |
| [0013](0013-emit-filter-measured-shapes.md) | The filter road refuses a computed query value, anchors with \z, and writes the $regex operator form |
| [0014](0014-emit-filter-query-constants.md) | Which values the query language compares as written |
| [0015](0015-emit-filter-raw-query-document.md) | A raw query document keeps its keys and lifts run-time reads into $expr |
| [0016](0016-emit-inputs-callback-binding.md) | How inputs.ts binds callbacks and words the refusal of a callback slot |
| [0017](0017-emit-internal-binding-names.md) | Internal $let and as names never capture a user name |
| [0018](0018-emit-join-lowering-rules.md) | Rules for correlation paths and chain routing in the join road |
| [0019](0019-emit-join-slot-value.md) | The join road reads its slot through a minted name and records the chain proof |
| [0020](0020-emit-let-rewind-slot.md) | A rewound declarator gives its scratch slot back |
| [0021](0021-emit-lower-calls.md) | Calls, logical values and blocks in lower.ts |
| [0022](0022-emit-lower-reads.md) | How lower.ts locates and renders a read of a field |
| [0023](0023-emit-lower-value-literals.md) | Small value-road decisions in lower.ts for literals, guards and update keys |
| [0024](0024-emit-names-variables.md) | The MongoDB variable names that the compiler writes |
| [0025](0025-emit-operand-list-array-wrap.md) | An array literal that is a value goes one level deeper in an operand slot |
| [0026](0026-emit-reduce-accumulator-narrowing.md) | A reduce accumulator narrows to object or array when seed and body agree |
| [0027](0027-emit-reduce-wrap-seed.md) | The reducer wrap folds a constant seed into the result |
| [0028](0028-emit-select-rules.md) | Small rule-selection decisions in select.ts |
| [0029](0029-emit-sort-spec.md) | How sort-spec.ts reads directions and whole-element keys |
| [0030](0030-emit-statement-dispatch.md) | How the statement target routes a statement, a chain link and a stage body |
| [0031](0031-emit-statement-placement.md) | The statement target judges the place of every name that a stage document holds |
| [0032](0032-emit-statement-write-groups.md) | Two writes to the same path in one `,` run take two `$set` stages |
| [0033](0033-emit-statement-writes.md) | How the statement target lowers a write, a stream assignment and a root replacement |
| [0034](0034-entry-expr-refuses-stage.md) | jsmql.expr refuses a stage call, because the server refuses both readings of the result |
| [0035](0035-errors-leaf-module.md) | errors.ts imports nothing from the compiler |
| [0036](0036-fixture-dataset-boundary-user.md) | The fixture holds a user with no email field, beside a user with a null email |
| [0037](0037-fixture-scratch-role.md) | The scratch user holds one custom role with readWrite, dbAdmin and indexStats |
| [0038](0038-fixture-server-signals.md) | How the fixture code reads the server's answer to a shutdown and to a failed connection |
| [0039](0039-fold-scope-and-collapse.md) | Which names the fold may replace, and how a program collapses to a Filter |
| [0040](0040-fold-server-agreement.md) | The fold computes only what the server computes, and the fold-agreement suite proves it |
| [0041](0041-globals-generator-details.md) | Small type decisions in the globals generator |
| [0042](0042-index-entry-mechanics.md) | Error frames and entry-form details in the public entry (index.ts) |
| [0043](0043-interpret-dates-rules.md) | The measured rules of the date interpreter |
| [0044](0044-interpret-family-rules.md) | Small measured limits in the interpreter's operator families |
| [0045](0045-interpret-measured-rules.md) | Measured server rules and limits in the interpreter value model and rule helpers |
| [0046](0046-interpret-regex-subset.md) | The interpreter runs only the regex syntax that PCRE2 and JavaScript share, printed as a new JavaScript pattern |
| [0047](0047-join-collapse-unwrap.md) | A collapsing terminal on a join unwraps the one-element lookup result |
| [0048](0048-levenshtein-suggestion-rules.md) | Thresholds and self-exclusion of the closest-name suggestion |
| [0049](0049-lex-table-driven-lexer.md) | The lexer reads its punctuators and keywords from registry rows, and scanners decide where a token ends |
| [0050](0050-literal-value-bridge.md) | How a computed or injected value goes back into the tree (literal.ts, inject.ts) |
| [0051](0051-mongoose-plugin-wrapper-internals.md) | Shape of each mongoose wrapper, and the type-only import for the augmentation |
| [0052](0052-namespace-compiler-names.md) | The three compiler namespaces and the constraints on each spelling |
| [0053](0053-parse-js-faithful-refusals.md) | The parser refuses what JavaScript refuses, where it sits, with a message that names the fix |
| [0054](0054-parse-pratt-parser-design.md) | One row-driven Pratt loop, a name-blind parser, and one shared reader for each repeated question |
| [0055](0055-passes-date-literal-reader.md) | The constant engine reads a date literal from its source parts before any lowering |
| [0056](0056-passes-desugar-rules.md) | Invariants of the desugar rules that the desugar spec does not state |
| [0057](0057-passes-naming-walk.md) | Binders, minted parameter names, and the context walk (naming.ts, fresh.ts, walk.ts) |
| [0058](0058-passes-no-new-timing.md) | The HR8 check runs on the parsed tree, and leaves two cases to the emit phase |
| [0059](0059-pipeline-server-constraints.md) | Raw stage documents hold one key, and the scratch guard reads paths |
| [0060](0060-playground-sync-extraction.md) | How the playground sync loads and formats the examples |
| [0061](0061-position-edge-clauses.md) | Clauses of the position edge that the spec does not state |
| [0062](0062-realistic-examples.md) | The realistic examples drive the playground through test metadata |
| [0063](0063-registry-agrees-crossrefs.md) | Runtime cross-reference checks of the registry rows |
| [0064](0064-registry-ast-design.md) | A name-blind AST, and the facts that its nodes carry |
| [0065](0065-registry-keywords-boundary.md) | What makes a word a keyword, and the one-way edge to productions |
| [0066](0066-registry-mql-builders.md) | Pure MQL builders in src/registry/mql.ts and the server facts they obey |
| [0067](0067-registry-names-array-aggregates.md) | Measured answers of the array aggregate methods |
| [0068](0068-registry-names-array-rows.md) | Filter, stream and value forms of the array method rows |
| [0069](0069-registry-names-cell-helpers.md) | Shared cell helpers in names.ts and the null rules they obey |
| [0070](0070-registry-names-date-methods.md) | Date method offsets and part families |
| [0071](0071-registry-names-mongo-spec-fields.md) | Operator facts on a mongo row |
| [0072](0072-registry-names-null-facts.md) | The null and missing facts on a row, and how each is measured |
| [0073](0073-registry-names-object-methods.md) | Measured results of the object methods |
| [0074](0074-registry-names-query-operators.md) | Server constraints on $nor, $text and $where |
| [0075](0075-registry-names-refusals.md) | Refusals of JavaScript spellings that have a JSMQL equivalent |
| [0076](0076-registry-names-roots-globals.md) | Positions of the root and scope rows, and constant globals |
| [0077](0077-registry-names-row-rules.md) | Per-row server facts for conversions, BSON values, dates and accumulators |
| [0078](0078-registry-names-scalar-methods.md) | Null and boundary rules of the number and string methods |
| [0079](0079-registry-names-spec-fields.md) | Meaning of the NameSpec and RootSpec fields in names.ts |
| [0080](0080-registry-names-stage-facts.md) | Stage facts on a mongo row, and the per-stage server facts behind them |
| [0081](0081-registry-names-stream-cells.md) | Decisions in the stream cells of the array methods |
| [0082](0082-registry-names-string-rows.md) | Filter and value forms of the string method rows |
| [0083](0083-registry-names-type-audits.md) | Type-level tricks that keep the names.ts audits honest |
| [0084](0084-registry-names-type-tests.md) | Server constraints behind the value cells of the type-test rows |
| [0085](0085-registry-productions-measured-returns.md) | Measured result kinds of the arithmetic and bitwise productions |
| [0086](0086-registry-productions-query-cells.md) | The native query forms of the comparison productions |
| [0087](0087-registry-productions-spec-fields.md) | The non-obvious fields of a production row |
| [0088](0088-registry-tokens-lexer-facts.md) | The lexer facts that the token rows state |
| [0089](0089-registry-type-audits.md) | How the registry type-level audits stay sound |
| [0090](0090-registry-vocabulary-argtypes.md) | Argument types and arity rules, with their measured refusals |
| [0091](0091-registry-vocabulary-cell-rules.md) | The vocabulary types make every cell total over positions and receiver families |
| [0092](0092-registry-vocabulary-core.md) | The division of the registries and the core dispatch axes |
| [0093](0093-registry-vocabulary-iteratee-slots.md) | The spellings that stand in for an arrow in an iteratee slot |
| [0094](0094-registry-vocabulary-kinds-bson.md) | BSON kinds that the type tracker uses |
| [0095](0095-registry-vocabulary-positions.md) | One position, one cell, and the cell kinds |
| [0096](0096-registry-vocabulary-query-helpers.md) | The query-document helpers and the typeof vocabulary |
| [0097](0097-registry-vocabulary-renderer-services.md) | The contracts of the services that a renderer receives |
| [0098](0098-registry-vocabulary-typeexpr.md) | The TypeExpr grammar and the callback parameter kinds |
| [0099](0099-rows-readers.md) | Decisions inside the registry readers (rows.ts) |
| [0100](0100-scripts-expectations-tools.md) | How the expectation tools decide what the compiler answers |
| [0101](0101-scripts-merge-devlog.md) | The rules of the DEVLOG merge resolver |
| [0102](0102-security-prototype-field-names.md) | A field name that matches a prototype member stays ordinary data |
| [0103](0103-stream-group-key-errors.md) | A shared key helper names the method that called it |
| [0104](0104-stream-predicate-error-receiver.md) | A predicate error names the method only, never another receiver |
| [0105](0105-stream-scratch-cleanup.md) | Scratch slots on a stream are cleared once, at the namespace root |
| [0106](0106-stream-sort-and-set-answers.md) | A stream sort names a field, and set-method answers follow the server |
| [0107](0107-test-accumulator-agrees-suite.md) | The accumulator-agreement suite excludes data-type errors, and reduces an array literal per document |
| [0108](0108-test-agreement-suites.md) | How the agreement suites sort a source into AGREE, DIVERGE and SAME_QUERY |
| [0109](0109-test-bson-majors-assertions.md) | How the bson-majors suite asserts behaviour that differs between bson majors |
| [0110](0110-test-callback-block-let-predicate.md) | A block predicate folds before the join road classifies it, and its bindings ride in $expr |
| [0111](0111-test-cli-output-evaluated.md) | The CLI tests evaluate the printed JavaScript instead of a JSON parse |
| [0112](0112-test-compiler-bson-suite.md) | The BSON suite checks the BSON type tag, builds live values per insert, and relies on measured conversions |
| [0113](0113-test-compiler-desugar-suite.md) | Desugar and fold tests compare against the tree of the explicit form, with provenance erased |
| [0114](0114-test-compiler-live-suites.md) | How the compiler live suites account for every source they run |
| [0115](0115-test-consult-registry-audits.md) | The consult suite audits the whole registry table, and each audit encodes one rule of the rows |
| [0116](0116-test-cross-realm-bytes.md) | The cross-realm test compares a Uint8Array as its list of bytes |
| [0117](0117-test-deferred-coverage-gates.md) | How the deferred-coverage test scans the surface and reads docs/DEFERRED.md |
| [0118](0118-test-deliberately-invalid-shapes.md) | Each deliberately invalid pass-through shape in a test records why the server refuses it |
| [0119](0119-test-fold-consistency-gate.md) | The fold-consistency suite compares each constant fold with the server lowering |
| [0120](0120-test-integration-live-hazards.md) | The integration suite runs the shapes that only a live server can prove |
| [0121](0121-test-iteratee-slots-audit.md) | The iteratee-slots suite re-measures each declared slot form |
| [0122](0122-test-kinds-expectations.md) | The kind facts behind the HR7 expectations in compiler-kinds.test.ts |
| [0123](0123-test-literal-passthrough-probe.md) | The literal pass-through probe builds a minimal call for each operator |
| [0124](0124-test-lower-value-shapes.md) | The server facts behind the value shapes in compiler-lower.test.ts |
| [0125](0125-test-merge-whenmatched-gate.md) | A live gate checks the `$merge.whenMatched` stage set against the server |
| [0126](0126-test-methods-js-parity.md) | How compiler-methods.test.ts compares each method with JavaScript |
| [0127](0127-test-methods-null-facts.md) | How the tests prove the null facts that let the compiler drop an $ifNull |
| [0128](0128-test-methods-server-guards.md) | The measured server limits that shape the guards of the method lowerings |
| [0129](0129-test-mongoose-mock-design.md) | The mongoose plugin tests use a mock Model, not a real connection |
| [0130](0130-test-names-invariants.md) | The invariants of the variable names that the compiler writes |
| [0131](0131-test-no-default-port-guard.md) | A test enforces the single-server rule and the scratch database grant |
| [0132](0132-test-operator-spec-coverage.md) | Rules of the operator-spec coverage test for names outside the pinned spec |
| [0133](0133-test-packaging-guards.md) | Packaging, site and runner guards check the published artifacts |
| [0134](0134-test-parse-js-subset.md) | The JavaScript syntax rules that compiler-parse.test.ts holds the parser to |
| [0135](0135-test-permutations-matrix.md) | The permutation suite compiles and runs every ordered pair of chain methods |
| [0136](0136-test-position-census.md) | The measured slot behaviour that the position pass must reproduce |
| [0137](0137-test-registry-audits.md) | Registry and AST audits read the source and fail in both directions |
| [0138](0138-test-returns-agrees.md) | How compiler-returns-agrees.test.ts measures every returns fact on mongod |
| [0139](0139-test-select-rules.md) | How the selector picks the rule of a row in compiler-select.test.ts |
| [0140](0140-test-shape-pass.md) | How compiler-shape.test.ts checks which document a program becomes |
| [0141](0141-test-stage-passthrough-refusals.md) | The stage-validation suite pins deliberately invalid pass-through shapes |
| [0142](0142-test-string-form-sources.md) | A test that needs a trailing comma in an arrow uses the string entry |
| [0143](0143-test-support-comparators.md) | Test helpers compare answers by meaning, with independent oracles |
| [0144](0144-test-two-road-agreement.md) | Server gates compare two lowerings of one source on the same documents |
| [0145](0145-types-globals-completion-fixture.md) | The globals completion fixture states what TypeScript cannot read itself |
| [0146](0146-union-documents-in-facet.md) | A written document list is refused anywhere inside a $facet |
