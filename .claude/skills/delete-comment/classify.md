# Classify comment blocks

The `delete-comment` skill gives this file to each agent that classifies comment blocks.

JSMQL is a JS-subset language that compiles to MongoDB MQL. Its source holds no comments. Classify each
comment block in your list. A script then deletes each comment, and its knowledge goes to the correct document.
**Do not edit any file in the repository. Do not open GitHub issues. Do not run git commands that change state.** Write only
the three output files that your task names. Write them in the output directory `<out>`.

## Input
Your block list is the output of `node scripts/comments.mjs blocks <file…>`. Each block: `### <file>:<lines>`
then the comment text, then a few lines of the code that follows it (or, for a trailing comment, the line it
sits on). The block id is `<file>:<first line>`. Read the real source file with the
Read tool whenever the excerpt is not enough. Use Grep to check whether a name, file, function, spec section
or claim that a comment mentions still exists and is still true.

## Categories (pick exactly one per block)
- **T — Tautology.** Repeats what the code, a name, a type, a test title or an assert already says. Section
  banners (`// ── foo ──`), "returns X" on a function whose name/type says it, a header that restates the file
  name, step-by-step narration of the next lines, an example of a call that the next line performs.
- **S — Stale.** Mentions code, files, functions, fields, spec sections, behaviours or counts that no longer
  exist or are no longer true (verify with Grep/Read — say what you checked in `why`), or narrates history
  ("previously", "used to", "now we", "was added", "no longer").
- **E — Excuse.** Admits or justifies a shortcut: a hack, workaround, crude or approximate logic, a heuristic
  that can misfire, "best effort", "for now", TODO/FIXME, "good enough", a known gap that the code papers over,
  an `any` or cast justified by a weak reason, a duplicated code path justified rather than removed, a test that
  is skipped or weakened with an explanation. Delete the comment, and report the fix to the developer. Use E only
  when there is a real engineering fix to make — a deliberate, sound trade-off is D, not E.
- **D — Decision Record.** Documents an important, non-obvious decision: why the code is shaped this way and not
  the obvious way, a MongoDB server constraint the code obeys (e.g. "the server rejects the bare form"), an
  invariant other code relies on, an ordering requirement, a security or DX reason. If an existing doc already
  states this decision fully (docs/specs/*.md, docs/LANG_RULES.md, docs/LANGUAGE.md, a CLAUDE.md, docs/DEFERRED.md),
  set `home` to that doc (path + section) and write no ADR — deleting the comment loses nothing. A bare
  pointer comment such as "See docs/specs/x.md" is D with `home` = that doc. Otherwise give an `adr` key.
- **K — Keep (rare).** Only: (1) JSDoc on an exported declaration of the published API that users see in their
  editor (exports of src/index.ts, src/mongoose.ts, and what they re-export to users); (2) a comment that holds a
  `[DEF-NNN]` tag (the deferred-coverage test needs the tag in the code); (3) a comment that code reads as data.
  State in `why` which case applies.

Tie-breaks: T over D when the code already makes the reason obvious to a reader who knows JS + MongoDB. Choose S
when any part of the claim is false. A block that mixes a decision with a hack is E
(the fix note may quote the decision). Tests: a comment that explains WHY an expected MQL shape is what it is
(server behaviour, a language rule) is D; a comment that restates the test title or the input is T.

## Outputs (all three files, even if empty)
1. `<out>/<batch>.jsonl` — one JSON object per block, every block id in your list, in order:
   `{"id":"src/x.ts:12","cat":"T|S|E|D|K","why":"<= 15 words","fix":"<fix-key>"?,"adr":"<adr-key>"?,"home":"<doc § section>"?}`
   `fix` is required for E. For D exactly one of `adr` / `home`.
2. `<out>/<batch>-adrs.md` — one section per adr key you used:
   ```
   ## adr: <key>
   title: <short decision title>
   sources: <ids, comma-separated>
   ### Context
   <the problem and the force that drives the decision>
   ### Decision
   <what the code does and why; name the files/functions it applies to>
   ### Consequences
   <what follows; what a future change must keep>
   ```
   Keys are kebab-case `<area>-<topic>` (e.g. `emit-arraytoobject-wrap`). Write few ADRs: group every
   comment about one decision (and closely related small decisions about one module) under one key. An ADR may
   hold a short list of related small decisions for one module. Carry over every fact the comments state —
   the ADR replaces them. Keep code names exact.
3. `<out>/<batch>-fixes.md` — one section per fix key:
   ```
   ## fix: <key>
   title: <imperative title, e.g. "Replace the regex comment strip in registry-fields-read with an AST walk">
   sources: <file:line list>
   <body: what the code does now, why it is a shortcut, what a proper fix looks like, how to verify>
   ```
   Group excuses that one fix resolves under one key.

## Prose rules for ADR and fix text (the repo enforces these; read docs/STE.md once)
Simplified Technical English: one idea per sentence, max ~20 words per instruction / 25 per description, active
voice, no `-ing` verb forms, keep articles, no idioms, "because" not "since". Do NOT quote any error message
text — describe the refusal in your own words. Do not narrate history ("was added", "previously"). Do not list
the current members of a changing set (methods, operators, stages). Do not give counts. Technical names stay exact.

When done, reply with only: counts per category, number of ADR keys, number of fix keys, and any block you
were unsure about (id + one line). Keep the reply under 15 lines.
