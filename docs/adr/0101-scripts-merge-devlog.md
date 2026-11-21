# 0101. The rules of the DEVLOG merge resolver

Status: Accepted
Applies to: `scripts/merge-devlog.mjs`

## Context

`scripts/merge-devlog.mjs` resolves a `git merge` conflict on a `docs/DEVLOG/YYYY-MM.md` file. It reads the three conflict stages through `git` and merges the entries by heading.

## Decision

- A past entry, one that the base already holds, may change on one side only. The append-only rule says that past entries do not change, but a one-sided edit such as a typo fix is acceptable. Two different edits of one past entry stop the merge for that file.
- The `git` helper passes `maxBuffer: 256 * 1024 * 1024` to `spawnSync`. A month file grows past the default buffer of `spawnSync`. With the default, the read fails with `ENOBUFS`, and the script then reports the file as not conflicted, which is false.
- `readStageOrEmpty` reads a stage that does not exist as empty text. This covers an add/add conflict, where the month file is new on one side or on both sides. An empty stage is the same as a month file that does not exist yet.

## Consequences

Do not lower the buffer size. Keep the empty-stage reading, or the first merge of a new month fails.
