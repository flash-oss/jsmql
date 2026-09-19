# src/compiler/

The compiler is five phases over `src/registry/`. Each phase reads the one
registry file that owns its facts. It invents nothing a row could have stated.

```
  ┌────────────┐   ┌────────────┐   ┌───────────┐   ┌────────────┐   ┌──────────┐
  │  1. LEX    │──►│  2. PARSE  │──►│ 3.DESUGAR │──►│ 4.POSITION │──►│  5.EMIT  │
  └─────┬──────┘   └─────┬──────┘   └─────┬─────┘   └─────┬──────┘   └────┬─────┘
        │                │                │               │               │
   tokens.ts        productions.ts    names.ts        names.ts         names.ts
   keywords.ts                        + position       + productions    + productions
```

**Phase 4 runs inside phase 3, and also after it.** Several sugars mean one
thing as a statement, and are refused everywhere else. So a rewrite must know
where it stands. The answer cannot come from identity, because the walk rebuilds
a parent as soon as a child changes. `passes/position.ts` states the position at
each parent-to-property step, and `mapTreeIn` carries this position down the
tree. `passes/shape.ts` answers the other half: which document the whole program
becomes. No single step can see this on its own.

## The one rule that shapes everything

**The registry says what the language HAS. It does not say how to build the MQL.**

A row answers six questions. Does this name exist? What is it called? What may
it attach to? In which of the seven positions is it legal? How many arguments
does it take there? What does the error say when it is not legal? A row does
not hold a renderer. A lowering reads its neighbours: the receiver's provable
type, the stages already emitted and the shape of a sibling argument. A single
row cannot see any of that. Lowerings are code, and they live in `emit/`.

So when a phase needs a fact about the language, it reads a row. When it needs to
produce a document, it calls a function here.

## Layout

```
index.ts       source → MQL. The public entries: `expr(source)`, `filter(source)`,
               `pipeline(source)`, `update(source)`.
rows.ts        the registry readers every phase shares: one question about a name,
               one answer from a row, spelled out once.
objectid-guard.ts  the one plausibility rule for an ObjectId the source spells.

lex/
  token.ts     the Token record and the source-position helpers.
  lexer.ts     the longest-match loop over `TOKENS`, plus the five rules a table
               cannot imply: maxRun, chooseBy, introducesName, tracksDepth,
               resumesTemplateAtDepth.
  scanners.ts  number, string, template, regex, identifier. Algorithms, not tables:
               a table says which spelling makes which token, a scanner decides
               where a token ENDS.

parse/         the Pratt loop that precedence, associativity and fixity drive,
               plus the mixing rules (noMixWith, leftOperandNot) and the one
               NAME fact it reads: `blockBodyOf`, because only the parser holds a
               callee and its `{ … }` body at the same time.
passes/        naming.ts answers "which row does this node name", "what is the
               chain's base" and "what does this node bind" ONCE for every pass;
               walk.ts is the one tree walk they all use. fold.ts and its family
               (fold-dates, fold-methods, evaluate, literal) settle a constant
               expression to its value; desugar rewrites source to source;
               inject carries a runtime value in; fresh mints a parameter name;
               position and shape decide which document the program becomes.
               See docs/specs/desugar-pass.md and docs/specs/position-pass.md.
emit/          the lowerings, and the dispatcher that checks a row, then runs one.
  consult.ts   what a row says about one name in one position — a pure read.
  select.ts    which rule runs: the receiver's proof (a closed Receiver) and the
               arguments' class (a closed partition) against the row — a rule, a
               runtime dispatch over the field families, or one of nine refusals.
  names.ts     every MongoDB variable name the compiler writes: the injective encoding, the
               brands (MongoVar / VarRef / FieldSlot), and Scope — what each
               JavaScript name stands for, and which names a mint must avoid.
  env.ts       the one record a lowering runs under: scope, site, chain. Only
               another Env makes one. No field is optional, no literal, no spread.
  mode.ts      value or truth: `truthOf`, the JavaScript truthiness check, and/or/not.
               The only minter of `Truth`.
  mql.ts       the MQL shapes that READ a condition ($cond, $filter, $switch, …),
               each typed to take a Truth. This module builds them, and nothing else does.
  types.ts     what a node PROVABLY is: a literal's kind, a row's measured
               `returns`, a binding's type. A field path proves nothing.
  inputs.ts    the one constructor of the `In` record a renderer receives.
  check.ts     the literal-gated argument checks. Each check reads a stated rule.
  errors.ts    every message the phase can produce, worded once.
  lower.ts     the value and truth readings over every node type. See
               docs/specs/emit-pass.md.
  filter.ts    the query reading: a predicate to a query document, the `&&`
               merge, the per-branch `$or`, the `$expr` residual.
  statement.ts the statement reading: a program to a pipeline. The write
               grouping, the stage calls, and `readIn` — the one hub that gives
               each position the reading it asks for.
  union.ts     the union road: `$$.push(…)` and `.concat(…)` as `$unionWith`, one
               stage per source, JavaScript's spread rule kept.
  join.ts      the join road: `$$$.<coll>.<chain>` as `$lookup` in every position
               — the peel, the slot, the four destinations. Lent to lower.ts at
               load (`provideJoin`), since it needs the statement target's link
               walker and the statement target imports lower.ts.
  update.ts    the update-document target: the object form of an update from writes and
               update operators, constants only — a document read is refused with the pipeline
               form as the way out. See docs/specs/emit-pass.md § The update-document target.
  reduce-wrap.ts  the reducer wrap: `$$ = [{ k: $$.reduce(…) }]` as one `$group`.
  sort-spec.ts the one reading of a sort argument — a name, a list, a `{ field: dir }`
               spec, a key function, a comparator — for every row that takes one.
```

## Conventions

- **No name is hard-coded.** If the compiler branches on a literal name (`"Math"`,
  `"$match"`, `".push"`), that fact belongs in a row instead. The one exception is
  a token spelling inside a scanner, where the character is the algorithm. The
  same rule applies to a list of node types or of operator spellings. State the
  list once, as data the type checker can hold against the source of truth
  (`BINARY_OPS` in ast.ts, `EVALUABLE_TYPES` and `NOT_ASKED_TYPES` in fold.ts).
  Never keep a hand copy of it in a second file.
- **Every rejection quotes the registry.** A message is either a row's own
  `unsupported(...)` text or built from a row's `args.sig`. No phase writes prose
  the registry could have carried.
- **Positions come from `where`, never from a tree probe.** If a construct is
  legal somewhere, its row says so, and phase 4 reads this. A stage body can mix
  positions. The row states the layout in `bodyPositions`; never derive the
  layout from a key's name.
- **Strippable TypeScript only**, same as the rest of `src/` — see `src/CLAUDE.md`.
