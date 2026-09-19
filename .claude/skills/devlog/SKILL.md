---
name: devlog
description: >-
  Add or update an entry in docs/DEVLOG.md — jsmql's single historical record of
  decisions and changes. Use this whenever you make an observable change to jsmql
  (a feature, fix, refactor, rename, or documentation/naming decision) and are
  preparing to commit, because every such change requires a DEVLOG entry in the
  same commit. Also use when the user says "add a devlog entry", "log this",
  "record why we did X", "note this decision", or when a `git merge` reports a
  conflict on docs/DEVLOG.md. Handles the exact heading format (newest-on-top, UTC
  date, conventional-commit-typed title), the what+why body, the "supersede, don't
  delete" rule, and the merge-devlog.mjs conflict resolver. Trigger even when the
  user doesn't say the word "devlog" but is clearly wrapping up a change to commit.
---

# devlog

## What the DEVLOG is

[docs/DEVLOG.md](docs/DEVLOG.md) is JSMQL's **single historical record**. It
answers future "why is X this way?" questions, and it is the closest thing the
project has to a ticket tracker. The project keeps no separate CHANGELOG or
ROADMAP file, by design. **Every observable change gets an entry**, in the
*same commit* as the change itself. A feature, a fix, a refactor, a rename, or
a doc or naming decision each counts as an observable change.

This file is the one place where the repo allows prose to restate a fact. So a
DEVLOG entry should explain the reasoning in full. It is not a one-line
changelog bullet.

## Writing an entry

**1. Get the date in UTC.** The heading date is UTC. Read the date; do not guess
it:

```sh
date -u +%F      # e.g. 2026-07-04
```

**2. Prepend the entry to the top of the file.** The newest entry always comes
first, directly under the `---` line that closes the header block. A
blank-line-`---`-blank-line mark separates each entry from the next.

**3. Write the heading in this shape.** The header block requires only a UTC
date and a short title:

```
## YYYY-MM-DD — <title>
```

- The dash is an em-dash `—` (U+2014), with one space on each side, to match
  every existing heading.
- **We recommend this, and recent entries follow it:** make `<title>` mirror
  the [Conventional Commits](https://www.conventionalcommits.org/) type of the
  commit it ships with — `feat: …` / `fix: …` / `docs: …` / `chore: …` /
  `refactor: …` / `test: …`, optionally scoped (`feat(lookup): …`,
  `fix(playground): …`), with `feat!` / `fix!` for a breaking change. Use a
  plain descriptive title (or a prefix like `decision: …`) when no single type
  fits. The type prefix is a convention, not a hard requirement of the header.
- Keep the title distinct. The merge resolver removes a duplicate entry by
  matching its **exact heading line**, so two entries on the same day need
  different titles.

**4. Write a body of 1 to 3 paragraphs that answers *what* and *why*.** The
*why* is the whole point. A future contributor reads this to understand a
decision the diff alone cannot show. Add a file reference as a markdown link
where relevant. Do not just describe the code change. State the reasoning, the
alternative you rejected, and any constraint that forced the shape.

**5. Do not write a version number in an entry, before version 1.0.** The
package stays at `0.1.0` until the public API is ready for a commitment, so do
not write a `v1`, `v2`, or other release marker.

### Example entry

```markdown
## 2026-07-04 — feat: accept bare ObjectId hex literals (`0x<24hex>`)

jsmql now parses `0x<24 hex digits>` as a live BSON ObjectId literal, so
`$._id == 0x65a1…` round-trips to a real `ObjectId(...)` instead of a number.
Chose the `0x` spelling over surfacing Extended-JSON `$oid` because [reason];
`ObjectId("…")` and `new ObjectId("…")` are accepted as equivalent forms. See
[src/compiler/lex/lexer.ts](src/compiler/lex/lexer.ts) and [docs/LANGUAGE.md](docs/LANGUAGE.md).
```

(Illustrative only — match the tone and depth of the entries already at the top of
the file, not this exact wording.)

## Superseding a past decision — never delete it

When a later change reverses or replaces an earlier decision, **do not edit or
delete the old entry.** Add a *new* entry at the top of the file. State the new
decision in it, and link back to the old entry by its heading. The append-only
history is what makes the DEVLOG trustworthy. Rewriting an old entry destroys
the record.

## Resolving a merge conflict on DEVLOG.md

Parallel branches often each prepend an entry, and git cannot merge these
automatically. Do **not** resolve the conflict by hand. Run the structural
resolver instead:

```sh
./scripts/merge-devlog.mjs      # run at repo root during the unresolved merge
git merge --continue            # (or `git commit`) once it reports success
```

The script reads the three conflict stages. It takes the union of the entries,
removes a duplicate by its `## YYYY-MM-DD — Title` heading, sorts the result
newest-first, and runs `git add` on it. The script exits with a non-zero
status and leaves the file untouched only when it cannot decide — for example,
a diverging header edit, or the same past entry edited two different ways.
When this happens, resolve the conflict by hand, then run
`git add docs/DEVLOG.md`.

## Pre-commit checklist

- [ ] The entry sits at the **top** of the file (newest-first), under the header `---`.
- [ ] The heading reads `## YYYY-MM-DD — <title>` (UTC date, unique title; the title follows the commit's type where one fits).
- [ ] The body explains **why**, not only what; each file reference is a markdown link.
- [ ] The entry carries no version number (before version 1.0).
- [ ] A superseded decision is linked, not deleted.
- [ ] The entry sits in the **same commit** as the change it documents.
