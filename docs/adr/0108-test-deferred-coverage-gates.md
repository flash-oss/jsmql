# 0108. How the deferred-coverage test scans the surface and reads docs/DEFERRED.md

Status: Accepted
Applies to: `test/deferred-coverage.test.ts`

## Context

`test/deferred-coverage.test.ts` ties every deferral phrase and `[DEF-NNN]` tag in the live surface to docs/DEFERRED.md. The scan works line by line, and docs/DEFERRED.md uses a Map of rows.

## Decision

- `TAG_CONTEXT` is 2. The test looks for a tag within two lines of a phrase line. So a multi-line Markdown list item can carry its tag on the first line of the bullet, and the phrase can fall on a continuation line.
- `PHRASE_RE` is a case-insensitive substring match against each line. Its phrases match the deferral phrases that the codebase uses. A change that tightens the list, for example one that drops "follow-up", needs a manual review of every false positive.
- `parseDeferred` reads only §A. §B records will-not-implement decisions under `### <title>` headings with no `DEF-NNN` id. The section markers are `## §A.` and `## §B.`.
- `parseDeferred` also returns `idsInOrder`: every §A id in file order, with duplicates. `rows` is a Map, so a repeated id overwrites the first, and both the forward and reverse gates still pass. A separate gate fails on a duplicate id. Two features under one id make every tag ambiguous, because a reader who follows the tag lands on the first row.

## Consequences

A change to the phrase list or to the heading format of docs/DEFERRED.md must also change these parsers. The duplicate-id gate is the only guard against two rows with one id.
