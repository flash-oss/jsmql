# 0058. A name-blind AST, and the facts that its nodes carry

Status: Accepted
Applies to: `src/registry/ast.ts`

## Context

src/registry/ast.ts defines the tree that the parser builds. The registry in names.ts decides what each name means. A tree that knew particular names would duplicate that knowledge and need one node type per name.

## Decision

The file is a leaf: it imports nothing. Thus `vocabulary.ts` can derive `NodeName` from it, and the type checker tests the `becomes` of every production against a real shape.
The tree is name-blind. The parser never checks a name against a set. `Math.round($.a)` and `$.n.round()` are both a `MethodCall` with the name `round`; only the `object` differs (`Ident("Math")` or `FieldRef("n")`). A bare name (`Math`, `String`, a lambda parameter, a `let` binding, a declared function) is always an `Ident`. Scope and names.ts decide which one it is, in a later phase. A tree with node types per name would need many types (for example `MathCall`, `NewDate`, `TypeCast`). No reader could tell some of them from a bare name. `ObjectIdLiteral` stays, because `0x` with exactly 24 hex digits is a re-reading of a NUMBER token. That is a syntactic fact, not a name.
Node facts:
- `ArrayElement` can be a statement, because the bracketed pipeline form writes stages as an array: `[$.total = $.qty * $.price, $match($.total > 100)]`. The position phase decides which array literals can hold one, not the parser. A `let` or `const` is never an element, because JavaScript refuses a declaration there. A write element makes the literal a pipeline. A `,`-joined run of writes is one `UpdateFilter`: one element and one stage.
- `ParamBinding` sits beside the tree, not in it. So `destructuringParam` in productions.ts has `becomes: { notANode }`. A `$`-family key binds a compiler service. A bare name binds a query parameter.
- `ArrayLiteral.packed`: the desugar pass sets it when it gathers the arguments of a call into the list (`"a".concat(...xs)` becomes `"a".concat([...xs])`). The flag stays because JavaScript keeps the difference. `.concat(...xs)` passes each element as its own argument, and `.concat(xs)` passes one array. A string receiver writes the elements with commas between them.
- `FieldRef` covers `$.a.b` and the bare `$` (the whole document, empty path). `optional` is true when any link was `?.`. A null-poison consumer (`$concat`, `$concatArrays`, `$size`) then reads a missing path as its empty value, as the JavaScript `?.` short-circuit does. The fold keeps the flag, because the path spelling cannot carry it. `optionalAt` is the path that the last `?.` of a folded chain tests: `$.a?.b.c` tests `a`, so a call after it stops the chain on `a` alone. It is absent when the `?.` sits on the root.
- `$$`, `$$$` and `$$$$` are separate node types (`StreamRef`, `DatabaseRef`, `ClusterRef`), never one node with a level. They are different things. `$$` is a stream that you can filter and replace (HR4). `$$$` names another collection to read or write. `$$$$` reaches the cluster and permits no read. A level number would force every reader to test the number first. `.name` and `[expr]` compose on top through `MemberAccess` and `IndexAccess`, so none of the three carries a path.
- `Ident.minted`: the desugar pass wrote this name for a short spelling (`"name"`, `{ type: "a" }`). No source spells it, so a message names what it stands for, not the name.
- `IndexAccess.iteratee`: the desugar pass wrote this read for an index in an iteratee slot (`.keyBy(5)`). The emitter refuses it when the elements cannot hold the index.
- `MethodCall.wrote`: the name in the source, present only when a pass renames the call (`.reverse()` to `.toReversed()`). Every message names `wrote`, because the developer cannot find `.toReversed(` in a program that says `.reverse(`.
- `OperatorCall` does not record how the developer wrote the arguments. The row's shape decides whether one argument is the operator body. A parser guess (an object style for any lone object literal) is wrong for every one-operand operator whose operand is a document.
- `Lambda.body` is absent exactly when `stages` is present. `stages` holds pipeline stages only when the row of the called name says `blockBody: "stages"`. Every other block is JavaScript, and the compiler refuses a stage inside it.
- `LetDecl.group` is the source offset of the keyword. All declarators of one `let` or `const` share it, so they can share a stage. It also stops a neighbour that the fold removed from a bridge across a `;` that the developer wrote. `FuncDecl.group` has the same meaning. A function holds no stage of its own.
- `AssignExpr.mutates`: the desugar pass sets it on the own write of a mutator (`$.a.pop();`). JavaScript allows that on a `const` binding, and the emitter allows it too.

## Consequences

Never add a node type for a particular name. A new fact about a name goes on its row in names.ts. A pass that renames a call must set `wrote`. A pass that mints a name must set `minted`.
