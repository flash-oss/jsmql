# 0018. A rewound declarator gives its scratch slot back

Status: Accepted
Applies to: `test/let-bindings.test.ts`

## Context

A declarator whose value hoists a `$lookup` ends a shared `$set` run. The compiler takes the declarator back (`Chain.rewind`) and lowers it again as its own statement. The first lowering already took a scratch slot number (`__jsmql.tmp.<N>`).

## Decision

The taken-back lowering returns its scratch slot. So `let a = …, b = <join>;` and `let a = …; let b = <join>;` give the same document, slot numbers included.

## Consequences

One program gives one output, whatever the separator. A change to slot allocation or to `Chain.rewind` must keep the two spellings identical. `test/let-bindings.test.ts` asserts this.
