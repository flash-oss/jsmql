# Conference deck — build source

`../presentation.html` is a **generated artifact**. Hand-edit
`presentation_skeleton.html` (all markup, CSS, slide content, speaker notes),
never the built file.

```sh
node presentation/gather.mjs presentation/examples presentation/examples.json
node presentation/build.mjs  presentation             ../presentation.html
```

- `examples/*.jsmql` — the JSMQL sources shown on slides; the input of record.
- `examples/friday.mql` — the ONE exception: the hand-written pipeline from the
  story, kept verbatim as a historical artefact. It is not compiler output and is
  never reformatted.
- `gather.mjs` COMPILES each one with the real library and prints the MQL with
  `jsmql.stringify` — the library's one printer, which the playground and the site
  also use — so a slide and the live playground show byte-identical output. Then it
  bundles everything (plus the SQL comparisons) into a JSON island.
- `examples/tables.json` — the rows each whole-query example RETURNED. `tables.mjs`
  runs every one of them on the project's mongod and records what came back, so a
  result table on a slide is real output and can never drift from the query.
- `build.mjs` injects that island into the skeleton at `/*__EXAMPLES__*/`.

So the code on a slide is always real compiler output, never hand-transcribed.
Every pipeline here was also executed against a live `mongod` and returned the
expected documents — re-verify with `test/probe` after changing an example.

## The operator rows (SQL vs JSMQL)

The two "SQL vs JSMQL" slides show one idea per row. The rows live in `gather.mjs`
(`OPS`): the JSMQL cell is compiled at build time — a cell that does not compile
aborts the build — and the slides show no MQL for them on purpose.
`verify-ops.mjs` runs every row's JSMQL on the project's mongod (`:27018`) and its
PostgreSQL text on an in-process PostgreSQL 17 (PGlite), over one dataset, and
fails unless every pair agrees:

```sh
PGLITE_DIR=/somewhere/with/pglite node presentation/verify-ops.mjs
```

(`PGLITE_DIR` is a directory where `npm i @electric-sql/pglite` was run; it is
deliberately not a project dependency.) The MySQL / SQL Server lines cannot run
there; the script prints them for a manual check against the vendor docs.

Editing the deck's own JS/CSS: do it in the skeleton, then re-run both commands.
