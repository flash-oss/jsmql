# docs/STE.md — how we write prose

Every word of prose in this repository follows **ASD-STE100 Simplified Technical
English**. This file is the digest we write from. Read it when a rule is unclear;
the short form that binds every session is the `### Write in Simplified Technical
English` block in the root [CLAUDE.md](../CLAUDE.md).

## What ASD-STE100 is

A controlled subset of English for technical documentation. The aerospace
industry made it in the 1980s, so that a reader with poor English can understand
a maintenance manual, and so that a machine can translate it. ASD — the AeroSpace
and Defence Industries Association of Europe — owns it. A working group, the STE
Maintenance Group (STEMG), keeps it current. It is an industry specification, not
an EU law and not an ISO standard.

| Resource | Link |
|---|---|
| Official site | https://www.asd-ste100.org |
| Download (free; a short form first) | https://www.asd-ste100.org/request.html |
| Issue 9 PDF | https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf |
| FAQ | https://www.asd-ste100.org/STE_faq.html |
| ASD's own page | https://www.asd-europe.org/standards-specifications/simplified-technical-english/ |

The standard has two parts. Part 1 gives 53 rules in 9 sections. Part 2 gives a
dictionary of about 900 approved words, each with one meaning and one part of
speech, and about 1,200 rejected words with their approved alternatives.

## What binds here

All prose: this repository's documents, code comments, test titles, error
messages, commit messages, pull-request text, and the replies Claude writes in
chat.

Three things are excluded. [docs/DEVLOG.md](DEVLOG.md) keeps the voice of its own
history, but each new entry is STE. A generated file follows its generator, so
never edit `src/globals.ts` or `playground.html` by hand. Code is not prose, so a
code block, an inline code span and a `// →` claim pair stay exact.

## Part 1 — the rules that bite in this repository

**Words.** Use an approved word in its approved meaning. Give one word one part
of speech: `filter` is a noun here, so write "the compiler builds a filter", never
"the compiler filters". Use one name for one thing; do not call the same pass "the
emitter" on one page and "the code generator" on the next. Keep the article: "the
emitter reads the row", not "emitter reads row". Do not use slang, an idiom or a
metaphor — "out of the box" means nothing to a reader who translates it word by
word.

**Verbs.** Use the active voice. Use only the simple present, simple past or
simple future. Do not use a continuous or a perfect tense. Do not use an `-ing`
form as a verb. Write "the pass lowers the node", never "lowering the node" or
"the pass is responsible for lowering the node".

**Noun phrases.** Use at most three words in a noun cluster. Break a longer one
with a preposition: write "the row of the registry for the operator", not "the
operator registry row".

**Sentences.** Use at most 20 words in an instruction and at most 25 words in a
description. Say one thing per sentence. Give one instruction per step. Use a
vertical list when the text gets complex. Do not drop a word to make a sentence
short; write a second sentence.

**Paragraphs.** Keep one topic in one paragraph. Use at most six sentences in a
descriptive paragraph.

**Warnings.** Put a warning before the step it guards. Start it with a command.
State the condition, then the result.

**Punctuation.** Do not write `and/or`. Use a slash only for a unit or to mean
"per".

**Clarity.** Make each pronoun point at one noun. Repeat the noun when a reader
could hesitate.

## Part 2 — the dictionary, and our exemption

The dictionary governs general English only. Use "use", not "utilize". Use
"because", not "since". Use "while" only for time, never for contrast.

| Do not write | Write |
|---|---|
| utilize, leverage | use |
| in order to | to |
| subsequently, thereafter | then, after this |
| prior to | before |
| additionally, furthermore | also |
| currently, presently | now |
| ensure that | make sure that |
| a number of, several | give the number |
| via | by, through |
| e.g. | for example |
| i.e. | that is |

A term from this project's domain is a **Technical Name** or a **Technical Verb**,
and the dictionary does not restrict it. This is a rule, never a list, because the
repository's own "describe the invariant, not the current inventory" rule forbids
a list that goes stale. The rule: a noun that names a thing in MQL, in JavaScript,
in MongoDB or in this compiler is a Technical Name; a verb that acts on one of
those things is a Technical Verb. So `AST`, `accumulator`, `emitter`, `node`,
`operator`, `pipeline`, `registry`, `stage` and `$literal` are legal nouns, and
`compile`, `desugar`, `emit`, `lex`, `lower` and `parse` are legal verbs.

Two spellings carry their own rule. "JSMQL" names the language and the project.
The lower-case form names the npm module's API and a code identifier only, as in
`jsmql.compile()`.

## Machine-read prose

Some prose in this repository is read by a program. When you rewrite it, repair
the reader in the same commit:

- A heading is a link target. 196 links point at a heading by anchor.
- `test/deferred-coverage.test.ts` matches deferral phrases with `PHRASE_RE`, and
  `test/deferred-allowlist.txt` pins case-sensitive substrings of live prose.
- `scripts/sync-playground.mjs` copies the `it()` titles of
  `test/realistic.test.ts` into the published `playground.html`.
- `scripts/check-doc-claims.mjs` re-derives every `<jsmql>  // → <MQL>` pair.

## Example

```
BEFORE  The emitter is then responsible for wrapping the resulting node in a
        $literal envelope when necessary, since otherwise MongoDB would be
        interpreting the value as a field path.

AFTER   The emitter wraps the node in a $literal envelope. It does this only for
        a constant, because MongoDB reads an unwrapped string as a field path.
```
