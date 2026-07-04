# .claude/skills/ — project-scoped Claude Code skills

Checked-in [Agent Skills](https://github.com/anthropics/skills) that encode
recurring jsmql workflows so the agent *applies* them consistently, not just when
it happens to remember the prose. Each skill is a directory with a `SKILL.md`
(YAML frontmatter — `name` + `description` drive triggering — then imperative
instructions). Skills are shared with the whole team via the repo.

Paths inside a `SKILL.md` are **repo-root-relative** (`test/probe`,
`docs/DEVLOG.md`), because a loaded skill runs with the working directory at the
project root — a `../`-relative link resolved from the skill file would escape the
repo.

## Skills

| Skill | Triggers on | Encodes |
|---|---|---|
| [verify-mql](verify-mql/SKILL.md) | About to assert/trust emitted MQL; adding an operator/stage/method; "does this run?" | The HR3 "run it on a real `mongod` before trusting it" ritual — `jsmql` CLI → `test/probe` (or the MongoDB MCP). Canonical authority: [test/CLAUDE.md](../../test/CLAUDE.md). |
| [devlog](devlog/SKILL.md) | Wrapping up any observable change to commit; DEVLOG merge conflicts | The `docs/DEVLOG.md` entry format + the `scripts/merge-devlog.mjs` resolver. Canonical authority: the [DEVLOG header](../../docs/DEVLOG.md). |

## Conventions

- A skill is a **pointer that acts**, not a second source of truth: keep the
  authoritative rules in their canonical home (a spec, a `CLAUDE.md`, the DEVLOG
  header) and have the skill link to it, mirroring the repo's single-source-of-truth
  rule. Follow the "describe the invariant, not the current inventory" rule here too
  — don't enumerate an evolving set (operators, stages) inside a skill.
- To add or refine a skill, use the `skill-creator` skill.
- This directory is skipped by the deferred-coverage drift test
  ([test/deferred-coverage.test.ts](../../test/deferred-coverage.test.ts)), so skill
  prose is exempt from the `[DEF-NNN]` gates — that also means it gets no drift
  protection, so keep cross-references accurate by hand.
