# 0017. The join road reads its slot through a minted name and records the chain proof

Status: Accepted
Applies to: `src/compiler/emit/join.ts`

## Context

`joinValue` in `src/compiler/emit/join.ts` hoists a `$lookup` into a scratch slot. Then it rebases the rest of the chain onto that slot and lowers it as a value. Two spellings of one chain must give one output, and later readers of the same node need its proof.

## Decision

- `elementsOf` maps the slot to the unwound element with a name from `env.fresh("el")`. The compiler mints the name, so the two spellings of one chain, `"items"` and `d => d.items`, give the same variable name.
- After `joinValue` lowers the rebased chain, it records the proof of the rebased chain on the original node (`env.chain.proved`). A later `typeOf` of the same node reads that proof.

## Consequences

A change to `elementsOf` must keep a minted name, never a name from the source. A change to `joinValue` must keep the `proved` call, or a later proof of the chain falls back to an unknown type.
