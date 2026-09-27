# docs/DEVLOG/ — the historical record

This folder is the single historical record for the whole project. See
§ No development history outside DEVLOG in the root [`CLAUDE.md`](../../CLAUDE.md)
for what that means: every other file describes what JSMQL **is**; only this
folder describes **how it got here**. There is no separate CHANGELOG file and
no separate ROADMAP file.

## Layout

One file per month, named `YYYY-MM.md`. A file's own header names its month.
The newest file, by filename, holds the newest entries. Start a new file for a
new month; do not append a new month's entries to an old file.

## Conventions

- Newest entry on top, within its month's file.
- Each entry: a short title, a UTC date, and 1 to 3 paragraphs that answer
  *what* and *why*. Include a file reference as a markdown link where
  relevant.
- When a later change reverses or replaces an earlier decision, do not edit
  or delete the old entry. Add a new entry, and link back to the old one by
  its heading.
- Pre-1.0: no version numbers in an entry. The package version stays at
  `0.1.0` until the public API is ready to commit to.

The [`devlog`](../../.claude/skills/devlog/SKILL.md) project skill holds the
exact heading format and the entry-writing checklist.

## Merge conflicts

A parallel session on another branch often edits the current month's file. A
`git merge` conflict on a file here resolves with
[`scripts/merge-devlog.mjs`](../../scripts/merge-devlog.mjs), not by hand. See
that script's own header, or the [`devlog`](../../.claude/skills/devlog/SKILL.md)
skill, for the exact steps.
