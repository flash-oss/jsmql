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

[docs/DEVLOG.md](docs/DEVLOG.md) is jsmql's **single historical record** —
the answer to future "why is X this way?" questions, and the closest thing the
project has to a ticket tracker. There is deliberately no separate CHANGELOG or
ROADMAP. **Every observable change gets an entry**, in the *same commit* as the
change itself (feature, fix, refactor, rename, or a doc/naming decision all count).

Because it is the one place restating is allowed, a DEVLOG entry should actually
explain the reasoning — it's not a one-line changelog bullet.

## Writing an entry

**1. Get the date in UTC** — the heading date is UTC, so read it, don't assume:

```sh
date -u +%F      # e.g. 2026-07-04
```

**2. Prepend the entry to the top of the file.** Newest entry is always first,
directly under the `---` that closes the header block. Entries are separated by a
blank-line-`---`-blank-line delimiter.

**3. Heading shape.** The header block only *requires* a UTC date and a short title:

```
## YYYY-MM-DD — <title>
```

- The dash is an em-dash `—` (U+2014) with a space on each side, to match every
  existing heading.
- **Recommended, and what the recent entries follow:** make `<title>` mirror the
  [Conventional Commits](https://www.conventionalcommits.org/) type of the commit
  it ships with — `feat: …` / `fix: …` / `docs: …` / `chore: …` / `refactor: …` /
  `test: …`, optionally scoped (`feat(lookup): …`, `fix(playground): …`), with
  `feat!` / `fix!` for breaking changes. Use a plain descriptive title (or a
  prefix like `decision: …`) when no single type fits — the type prefix is a
  convention, not a hard requirement of the header.
- Keep the title distinct: the merge resolver dedupes entries by their **exact
  heading line**, so two entries on the same day must have different titles.

**4. Body: 1–3 paragraphs answering *what* and *why*.** The *why* is the whole
point — a future contributor reads this to understand a decision they can't
reconstruct from the diff. Include file references (as markdown links) where
relevant. Don't just describe the code change; capture the reasoning, the
alternative you rejected, and any constraint that forced the shape.

**5. Pre-1.0: no version numbers** in entries. The package stays at `0.1.0` until
the public API is ready to commit to, so don't write `v1`/`v2`/release markers.

### Example entry

```markdown
## 2026-07-04 — feat: accept bare ObjectId hex literals (`0x<24hex>`)

jsmql now parses `0x<24 hex digits>` as a live BSON ObjectId literal, so
`$._id == 0x65a1…` round-trips to a real `ObjectId(...)` instead of a number.
Chose the `0x` spelling over surfacing Extended-JSON `$oid` because [reason];
`ObjectId("…")` and `new ObjectId("…")` are accepted as equivalent forms. See
[src/lexer.ts](src/lexer.ts) and [docs/LANGUAGE.md](docs/LANGUAGE.md).
```

(Illustrative only — match the tone and depth of the entries already at the top of
the file, not this exact wording.)

## Superseding a past decision — never delete

If a later change reverses or supersedes an earlier decision, **do not edit or
delete the old entry.** Add a *new* top-of-file entry that states the new decision
and links back to the superseded one (by its heading). The append-only history is
what makes the DEVLOG trustworthy; rewriting it destroys the record.

## Resolving a merge conflict on DEVLOG.md

Parallel branches frequently each prepend an entry, which git can't auto-merge. Do
**not** hand-resolve it — run the structural resolver:

```sh
./scripts/merge-devlog.mjs      # run at repo root during the unresolved merge
git merge --continue            # (or `git commit`) once it reports success
```

It reads the three conflict stages, takes the union of entries (deduped by the
`## YYYY-MM-DD — Title` heading), sorts newest-first, and `git add`s the result. It
exits non-zero and leaves the file untouched only when it genuinely can't decide —
a diverging header edit, or the same past entry edited differently on both sides —
in which case resolve by hand, then `git add docs/DEVLOG.md`.

## Pre-commit checklist

- [ ] Entry is at the **top** of the file (newest-first), under the header `---`.
- [ ] Heading is `## YYYY-MM-DD — <title>` (UTC date, unique title; title follows the commit's type where one fits).
- [ ] Body explains **why**, not just what; file refs are markdown links.
- [ ] No version numbers (pre-1.0).
- [ ] A superseded decision is linked, not deleted.
- [ ] The entry is in the **same commit** as the change it documents.
