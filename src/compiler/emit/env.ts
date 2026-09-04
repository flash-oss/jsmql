// Phase 5 — EMIT. The one record every lowering runs under.
//
// The shipped compiler carried its context as a record of 23 fields, 21 of them
// optional, and every context bug it had took the same shape: a literal that
// listed most of the fields and lost one, invisibly, so a `jsmql.compile`
// parameter resolved inside `.map` and threw inside `.reduce`. Nothing here is
// optional, nothing here is a literal a caller can write, and a lambda body
// inherits everything because the only way to make an Env is from an Env.
//
// Three services, no more:
//   scope   what each JavaScript name means, and which variable names are taken
//   site    where this node stands — phase 4's answer, the program's root, the
//           `$literal` envelope, the sub-pipeline boundaries crossed to get here
//   chain   the (sub-)pipeline being assembled, held BY REFERENCE: what it has
//           emitted, what a value hoisted ahead of the current statement, and the
//           scratch-slot counter
//
// A lowering receives its `In` record built from an Env by emit/inputs.ts; it
// never sees the Env itself.

import type { Position, Stage } from "../../registry/vocabulary.ts";
import type { BodyPath } from "../rows.ts";
import type { Where } from "../passes/position.ts";
import type { Binding, Binder, FieldSlot, MongoVar, VarRef } from "./names.ts";
import { Scope, scratchSlot } from "./names.ts";
import { JSMQL_NS } from "../../namespace.ts";
import { namesIn } from "../passes/fresh.ts";

/** A sub-pipeline entered on the way here: the stage whose body it is, and the path to it. */
export type Boundary = { readonly stage: string; readonly path: BodyPath };

/** Where a node stands. Every field required — see the header. */
export type Site = {
  /** Phase 4's answer for this node, verbatim: a position or a waypoint. */
  readonly where: Where;
  /** What the WHOLE program is: a pipeline, a filter, a bare expression, an update document. */
  readonly root: Position;
  /** Inside `$literal(…)`, nothing is an operator or a field reference. */
  readonly envelope: "none" | "$literal";
  /** The sub-pipeline boundaries crossed to reach here, outermost first. */
  readonly boundaries: readonly Boundary[];
};

/**
 * HR1's one gate. A string injected at runtime — a `jsmql.compile` parameter,
 * a template `${…}` — that starts with `$` is wrapped in `$literal` exactly
 * when it would otherwise be read as a field reference: in a VALUE slot, of a
 * program that is not a pipeline or an update document, outside a `$literal`
 * the developer already wrote. A query slot compares its value as written, and
 * a pipeline passes injected values through — measured on the shipped compiler:
 *
 *   jsmql.expr.compile(({ s }, { $ }) => $.a + s)({ s: "$b" })         → { $add: ["$a", { $literal: "$b" }] }
 *   jsmql.compile(({ s }, { $ }) => $.a === s)({ s: "$b" })            → { a: "$b" }
 *   jsmql.pipeline.compile(({ s }, { $ }) => { $.x = s; })({ s: "$b" }) → [{ $set: { x: "$b" } }]
 */
export const injectedNeedsLiteral = (site: Site): boolean =>
  site.where.at === "value" && site.root !== "statement" && site.root !== "updateDoc" && site.envelope === "none";

/**
 * The (sub-)pipeline under assembly. Held by reference on purpose: two
 * lowerings of one statement append to the same list, in order.
 */
export class Chain {
  /**
   * Is there a pipeline to place a stage in? A bare expression (`jsmql.expr`)
   * and a filter have none, so a value that must materialise a stage — the
   * stream count — has nowhere to go and is refused rather than written into a
   * list nothing drains.
   */
  readonly isPipeline: boolean;
  constructor(isPipeline = true) {
    this.isPipeline = isPipeline;
  }
  /** The stages emitted so far. */
  readonly emitted: Stage[] = [];
  /** Stages a value placed ahead of the statement it stands in; drained by `flush`. */
  readonly hoisted: Stage[] = [];
  private slots = 0;
  /** Has anything written under `__jsmql`? Owns the trailing cleanup. */
  dirty = false;
  /**
   * A stage that must be LAST — `$out`, `$merge`. Filed here rather than
   * emitted, so nothing can land after it and the cleanup always precedes it.
   */
  terminal: Stage | null = null;

  /** A fresh `__jsmql.tmp.<n>` scratch slot. */
  slot(): FieldSlot {
    this.dirty = true;
    return scratchSlot(this.slots++);
  }

  /** Place `stages` ahead of the current statement; answer the reference that reads `reads`. */
  hoist(stages: readonly Stage[], reads: string): string {
    this.hoisted.push(...stages);
    this.dirty = true;
    return "$" + reads;
  }

  /** Move the hoisted stages into the emitted list — called before the statement that triggered them. */
  flush(): void {
    this.emitted.push(...this.hoisted);
    this.hoisted.length = 0;
  }

  /** The finished pipeline: the stages, the cleanup if anything was written under `__jsmql`, the terminal stage. */
  close(): Stage[] {
    this.flush();
    const out = [...this.emitted];
    if (this.dirty) out.push({ $unset: JSMQL_NS });
    if (this.terminal !== null) out.push(this.terminal);
    return out;
  }
}

/** A variable bound for a body, and the Env that body is lowered under. */
export type Bound = { readonly as: MongoVar; readonly ref: VarRef; readonly env: Env };

export class Env {
  readonly scope: Scope;
  readonly site: Site;
  readonly chain: Chain;

  private constructor(scope: Scope, site: Site, chain: Chain) {
    this.scope = scope;
    this.site = site;
    this.chain = chain;
  }

  /**
   * The Env a program starts in. Every name the program introduces anywhere is
   * reserved for the whole of it, so a compiler mint never shadows a parameter
   * bound deeper in.
   */
  static root(program: object, root: Position, chain: Chain = new Chain(root === "statement")): Env {
    const site: Site = { where: { at: root }, root, envelope: "none", boundaries: [] };
    return new Env(Scope.root(namesIn(program)), site, chain);
  }

  // ── the transitions: each answers a new Env and changes ONE thing ──────────

  /** A name bound to something other than a variable — the document, a slot, a function. */
  bind(js: string, binding: Binding): Env {
    return new Env(this.scope.declare(js, binding), this.site, this.chain);
  }

  /** The developer's own variable — a lambda parameter, a `$let` var. */
  param(js: string, type: Binding["type"], pos: number): Bound {
    return this.bound(this.scope.param(js, type, pos));
  }

  /** A compiler mint, named after `hint`, that steps aside from every name the program uses. */
  fresh(hint: string): Bound {
    return this.bound(this.scope.bind(hint));
  }

  /** Move to where phase 4 says a child stands. */
  at(where: Where): Env {
    return new Env(this.scope, { ...this.site, where }, this.chain);
  }

  /** Inside `$literal(…)`. */
  literal(): Env {
    return new Env(this.scope, { ...this.site, envelope: "$literal" }, this.chain);
  }

  /** Into a sub-pipeline: a new chain, the boundary recorded, statement position. */
  enter(boundary: Boundary, chain: Chain): Env {
    const site: Site = { ...this.site, where: { at: "statement" }, boundaries: [...this.site.boundaries, boundary] };
    return new Env(this.scope, site, chain);
  }

  /** What a JavaScript name means here, or the developer's positioned error. */
  lookup(js: string, pos: number): Binding {
    return this.scope.lookup(js, pos);
  }

  private bound(b: Binder): Bound {
    return { as: b.as, ref: b.ref, env: new Env(b.scope, this.site, this.chain) };
  }
}
