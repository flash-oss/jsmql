# 0186. The Env changes once per group of stages, where the group stands

Status: Accepted
Applies to: `Step` and `afterLink` in `src/compiler/emit/statement.ts`

## Context

Several roads write stages: a chain link, a write of a `,` run, and a stage call. Each one is a group of stages. The Env holds the proof of the document and the bindings after each stage.

## Decision

Each group changes the Env once, where the group stands. The Env takes the groups in the order of their stages. The alternative was a second reading of the finished stages. The developer rejected it, because a second reading cannot see the links. So it misses a row that gives the documents back (`restoresDocuments`). It also misses a scratch field that a later link wrote after a stage that replaced the document.

## Consequences

A new road that writes stages updates the Env where its group stands. It never reads stages that another group already applied.
