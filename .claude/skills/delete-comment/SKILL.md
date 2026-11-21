---
name: delete-comment
description: >-
  Remove code comments from jsmql and move the knowledge they hold to its right
  home. Each comment is classified as a Tautology or Stale (delete it), an Excuse
  (delete it and report the shortcut to the developer), or a Decision Record
  (move it to an ADR under docs/adr/, or confirm that a spec already states it).
  Then the skill lowers the comment ratchet baseline. Use this skill when the user
  types /delete-comment. Also use it when the user asks to "delete comments",
  "clean up comments", "lower the comment baseline" or "move this comment to an
  ADR". Also use it when test/no-comments.test.ts fails because a change added a
  comment.
---

# delete-comment

## Why this exists

Source code in this repository holds no comments. A comment is a second copy of a
fact, and it drifts from the code (see § Simplify everything to keep drift minimal
in the root `CLAUDE.md`). A comment also hides a shortcut, because it gives an
excuse for the shortcut. The ratchet test `test/no-comments.test.ts` holds the count of
comment lines per file in `test/comment-baseline.json`. The count can only decrease.

The scanner, the stripper and the baseline writer are one script:
`scripts/comments.mjs`. It skips tool directives (`/// <reference>`,
`@ts-expect-error`). It also skips the comments inside a JSMQL arrow input, because
those comments are JSMQL source under test. It skips generated files, `vendor/`, `dist/` and
`test/human/`.

## Steps

1. **Pick the scope.** A file, a directory, or the whole tree. Run
   `node scripts/comments.mjs count` to see the files with the most comment lines.
2. **List the blocks.** Run `node scripts/comments.mjs blocks <file…>`. Each block
   is a run of adjacent comment lines with an id `<file>:<line>` and the code after it.
3. **Classify each block.** Follow [classify.md](.claude/skills/delete-comment/classify.md)
   exactly. If there are more than 300 blocks, start one sub-agent for each batch
   of files (Sonnet or Opus, never Haiku). Give each sub-agent `classify.md` and
   its block list. Tell the sub-agent not to edit the repository.
4. **Act on each category.**
   - **T — Tautology** and **S — Stale**: delete.
   - **E — Excuse**: delete. Report each distinct fix to the developer in your
     reply: the code site, the shortcut and the proper fix. Never open a GitHub
     issue.
   - **D — Decision Record**: when a spec, `docs/LANG_RULES.md` or a `CLAUDE.md`
     file already states the decision, delete. Otherwise add or extend an ADR in
     `docs/adr/` (format: [docs/adr/CLAUDE.md](docs/adr/CLAUDE.md)), add its row to
     `docs/adr/index.md`, then delete.
   - **K — Keep**: the comment that `classify.md` allows to remain. This case is
     rare. Pass its block id to `--keep`.
5. **Strip.** Run `node scripts/comments.mjs strip [--keep <file:line>]… <file…>`.
   Then run `npm run format`.
6. **Lower the baseline.** Run `node scripts/comments.mjs ratchet`. It stops when the
   count of a file increased. It writes the new counts when no count increased.
7. **Check.** Run `npm test`. After you edit `src/` or `test/realistic.test.ts`,
   run `npm run sync:playground`. Then commit its outputs.
8. **Commit.** Use a Sonnet or Opus sub-agent to check the new ADR prose against
   `docs/STE.md`. Add a `docs/DEVLOG/` entry (the `devlog` skill). Commit the ADRs,
   the stripped files and the baseline together as one `refactor:` commit.

## Never

- Never raise a number in `test/comment-baseline.json` by hand. Put the fact in a
  name, an ADR or a spec, not in a new comment.
- Never delete a comment inside a JSMQL input or `test/human/`.
- Never delete a `[DEF-NNN]` tag before its row in `docs/DEFERRED.md` has another
  tag site. The deferred-coverage test needs one.
