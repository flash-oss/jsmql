# .claude/skills/ — project-scoped Claude Code skills

This folder holds checked-in [Agent Skills](https://github.com/anthropics/skills).
Each skill encodes one recurring workflow of JSMQL, so the agent applies the
workflow every time, not only when it remembers the prose. Each skill is a
directory with a `SKILL.md` file. The file has YAML frontmatter — the `name` and
`description` fields drive triggering — then gives imperative instructions. The
repo shares each skill with the whole team.

A path inside a `SKILL.md` file is **repo-root-relative** (`test/probe`,
`docs/DEVLOG.md`). A loaded skill runs with the working directory at the project
root. A `../`-relative link from the skill file would point outside the repo.

## Skills

| Skill | Triggers on | Encodes |
|---|---|---|
| [verify-mql](verify-mql/SKILL.md) | About to assert/trust emitted MQL; adding an operator/stage/method; "does this run?" | The HR3 "run it on a real `mongod` before trusting it" ritual — `jsmql` CLI → `test/probe` (or the MongoDB MCP). Canonical authority: [test/CLAUDE.md](../../test/CLAUDE.md). |
| [devlog](devlog/SKILL.md) | Wrapping up any observable change to commit; DEVLOG merge conflicts | The `docs/DEVLOG.md` entry format + the `scripts/merge-devlog.mjs` resolver. Canonical authority: the [DEVLOG header](../../docs/DEVLOG.md). |

## Conventions

- A skill is a **pointer that acts**, not a second source of truth. Keep the
  authoritative rules in their canonical home (a spec, a `CLAUDE.md` file, the
  DEVLOG header). Make the skill link to that home, to match the repo's
  single-source-of-truth rule. Follow the "describe the invariant, not the
  current inventory" rule here too. Do not list an evolving set, such as
  operators or stages, inside a skill.
- To add or refine a skill, use the `skill-creator` skill.
- The deferred-coverage drift test skips this directory
  ([test/deferred-coverage.test.ts](../../test/deferred-coverage.test.ts)). So
  skill prose is exempt from the `[DEF-NNN]` gates. This also means the test
  gives skill prose no drift protection, so check each cross-reference by hand.
