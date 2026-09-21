// Phase 5 — EMIT. The one record every lowering runs under.
//
// A context of optional fields invites one bug, over and over: a literal that
// lists most of the fields and loses one, invisibly, so a `jsmql.compile`
// parameter resolves inside `.map` and throws inside `.reduce`. Nothing here is
// optional, nothing here is a literal a caller can write, and a lambda body
// inherits everything, because the only way to make an Env is from an Env.
//
// Three services, no more:
//   scope   what each JavaScript name means, and which variable names are taken
//   site    where this node stands — phase 4's answer, the program's root, the
//           `$literal` envelope, the sub-pipeline boundaries crossed to get here
//   chain   the (sub-)pipeline under assembly, held BY REFERENCE: what it has
//           emitted, what a value hoisted ahead of the stage it stands in, and the
//           scratch-slot counter
//
// emit/inputs.ts builds a lowering's `In` record from an Env; the lowering
// never sees the Env itself.

import type { Position, Stage, Type } from "../../registry/vocabulary.ts";
import type { BodyPath } from "../rows.ts";
import type { Where } from "../passes/position.ts";
import type { Binding, Binder, Declared, FieldSlot, Located, MongoVar, VarRef } from "./names.ts";
import { Capture, Scope, scratchSlot } from "./names.ts";
import { DOCUMENT, at, present, written } from "./type.ts";
import { JSMQL_NS } from "../../namespace.ts";
import { namesIn } from "../passes/fresh.ts";
import { pipelineOverOf, preservesCountOf } from "../rows.ts";
import { noCorrelationSlot, readInUpdateDocument, readsEnclosingVariable } from "./errors.ts";

/**
 * A boundary crossed on the way here: a sub-pipeline (the stage whose body it
 * is, and the path to it), or an `$elemMatch` body, which names the parameter
 * that is the ELEMENT there — the only name whose fields are query paths inside.
 */
export type Boundary = {
  readonly stage: string;
  readonly path: BodyPath;
  readonly element?: string;
  /**
   * For a body over ANOTHER collection: the stage's `let`, which the reads
   * inside the body fill. It is null when the stage has no `let` (`$unionWith`),
   * so the compiler refuses a read of the outer document there instead of
   * silently misreading it.
   */
  readonly capture?: Capture | null;
  /** The chain the body was entered FROM — the enclosing pipeline. */
  readonly outer?: Chain;
};

/** Does this boundary start a new LEVEL of documents — a body over another collection? */
export const isForeign = (b: Boundary): boolean => pipelineOverOf(b.stage) === "foreign";

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
  /** The operator whose ARGUMENT this is — what a fragment like `$case` or `$box` is only valid inside of — or null. */
  readonly inside: string | null;
};

/**
 * HR1's one gate. Take a string injected at runtime — a `jsmql.compile`
 * parameter, or a template `${…}` — that starts with `$`. The compiler wraps
 * it in `$literal` exactly where the server would otherwise read it as a field
 * reference: in a VALUE slot the server evaluates — an expression, a stage
 * body, a `$set` value — outside a `$literal` the developer already wrote. Two
 * places evaluate nothing and take the string as written: a query slot, and an
 * update DOCUMENT (`{ $set: { x: "$b" } }` stores the string "$b"; measured).
 *
 *   jsmql.expr.compile(({ s }, { $ }) => $.a + s)({ s: "$b" })         → { $add: ["$a", { $literal: "$b" }] }
 *   jsmql.pipeline.compile(({ s }, { $ }) => { $.x = s; })({ s: "$b" }) → [{ $set: { x: { $literal: "$b" } } }]
 *   jsmql.compile(({ s }, { $ }) => $.a === s)({ s: "$b" })            → { a: { $eq: "$b", $not: { $type: "array" } } }
 *   jsmql.update.compile(({ s }, { $ }) => { $.x = s; })({ s: "$b" })   → { $set: { x: "$b" } }
 */
export const injectedNeedsLiteral = (site: Site): boolean =>
  site.where.at === "value" && site.root !== "updateDoc" && site.envelope === "none";

/**
 * The (sub-)pipeline under assembly. Held by reference on purpose: two
 * lowerings of one statement append to the same list, in order.
 */
export class Chain {
  /**
   * Is there a pipeline to place a stage in? A bare expression (`jsmql.expr`)
   * and a filter have none, so a value that must materialise a stage — the
   * stream count — has nowhere to go. The compiler refuses it instead of
   * writing it into a list that nothing drains.
   */
  readonly isPipeline: boolean;
  constructor(isPipeline = true) {
    this.isPipeline = isPipeline;
  }
  /** The stages emitted so far. */
  readonly emitted: Stage[] = [];
  /** Stages a value placed ahead of the stage it stands in; `ahead` drains them. */
  readonly hoisted: Stage[] = [];
  private slots = 0;
  /** Has anything written under `__jsmql`? Owns the trailing cleanup. */
  dirty = false;
  /**
   * A stage that must be LAST — `$out`, `$merge`. The compiler files it here
   * rather than emitting it, so nothing can land after it, and the cleanup
   * always precedes it.
   */
  terminal: Stage | null = null;
  /**
   * Where the stream's ELEMENT lives on its documents: `""` when the element IS
   * the document, or the unwound field's path after `.flatMap("items")` — a
   * callback's parameter then stands for that field, and its fields stand for
   * `items.<field>`. The documents themselves still carry their other fields
   * (`$unwind` preserves them); a stage that replaces the document makes the
   * document the element again. See docs/specs/stream-methods.md § The element
   * after `.flatMap`.
   */
  element = "";

  /**
   * A stage lands: one that replaces the document leaves no unwound field to
   * point at. `replaces` is the row's own fact; the caller judges it.
   */
  placed(replaces: boolean): void {
    if (replaces) this.element = "";
  }

  /** A fresh `__jsmql.tmp.<n>` scratch slot. */
  slot(): FieldSlot {
    this.dirty = true;
    return scratchSlot(this.slots++);
  }

  /**
   * The field paths a materialiser stamped, that are still FRESH — see
   * docs/specs/stream-length.md § Compute-once / reuse / recompute. A second
   * read of a stamped path costs no stage. A stage whose row does not state
   * `preservesCount` clears the set, so the next read stamps again.
   */
  private stamped = new Set<string>();

  /**
   * A mark for a lowering that the compiler may TAKE BACK. A chain that goes on
   * after a join lowers the body twice, and it discards the first attempt's
   * hoists — so the stamps from that attempt must go too, or the second attempt
   * reuses a field the discarded stage would have written.
   *
   * The scratch counter goes back too. Only the stages that went with a slot
   * name it, so keeping the discarded attempt's number would leave a gap — and
   * the gap is VISIBLE: `let a = …, b = <a foreign read>;` and the same program
   * spelled with a `;` would name the same slot `__jsmql.tmp.1` and
   * `__jsmql.tmp.0`. One lowering, one output.
   */
  mark(): { hoisted: number; stamped: ReadonlySet<string>; slots: number } {
    return { hoisted: this.hoisted.length, stamped: new Set(this.stamped), slots: this.slots };
  }

  /** Undo everything hoisted, stamped and minted since `mark`. */
  rewind(m: { hoisted: number; stamped: ReadonlySet<string>; slots: number }): void {
    this.hoisted.length = m.hoisted;
    this.stamped = new Set(m.stamped);
    this.slots = m.slots;
  }

  /** Place `stages` ahead of the stages of the lowering that hoisted them; answer the reference that reads `reads`. */
  hoist(stages: readonly Stage[], reads: string): string {
    if (!this.stamped.has(reads)) {
      this.hoisted.push(...stages);
      this.stamped.add(reads);
      this.dirty = true;
    }
    return "$" + reads;
  }

  /**
   * A statement's stages land. A stage that does not state `preservesCount`
   * changes how many documents there are, or what fields they carry, so every
   * stamp taken before it now states something that is no longer true.
   */
  advance(stages: readonly Stage[]): void {
    for (const stage of stages) {
      if (!preservesCountOf(Object.keys(stage)[0])) {
        this.stamped.clear();
        return;
      }
    }
  }

  /**
   * The stages hoisted so far, TAKEN OUT so they can stand directly ahead of the
   * stages of the lowering that hoisted them.
   *
   * A hoisted stage reads the same documents as the stage it was written for, so
   * it must land beside that stage and not at the front of the statement:
   * MEASURED, the `$lookup` of `$$.$sortByCount($.productIds).map(g =>
   * $$$.products.find({ _id: g._id }))` stood ahead of the whole statement,
   * joined on the SOURCE document's `_id`, and `$sortByCount` then replaced the
   * document and dropped the slot — so every row came back without its joined
   * field, and the server reported nothing wrong. A road that makes several
   * stages out of one statement therefore drains at each of them. See
   * docs/specs/lookup-stage.md § Where a hoisted stage lands.
   */
  ahead(): Stage[] {
    const out = [...this.hoisted];
    this.hoisted.length = 0;
    return out;
  }

  /** Move the hoisted stages into the emitted list — the drain of a statement that is ONE stage. */
  flush(): void {
    this.emitted.push(...this.ahead());
  }

  /** The finished pipeline: the stages, the cleanup if anything wrote under `__jsmql`, and the terminal stage. */
  close(): Stage[] {
    this.flush();
    const out = [...this.emitted];
    if (this.dirty) out.push({ $unset: JSMQL_NS });
    if (this.terminal !== null) out.push(this.terminal);
    return out;
  }
}

/** A variable bound for a body, and the Env under which that body lowers. */
export type Bound = { readonly as: MongoVar; readonly ref: VarRef; readonly env: Env };

export class Env {
  readonly scope: Scope;
  readonly site: Site;
  readonly chain: Chain;
  /**
   * What the compiler proves about the DOCUMENT on each level: index 0 is the root
   * pipeline's document, and each body over another collection adds one. A write
   * records its value's proof at the written path; a read of `$.a.b` answers the
   * proof at that path; a stage that replaces the document resets its level. A
   * `?.` on the way in proves the guarded path present, so inside its chain the
   * `$ifNull` a cell would otherwise put on it is dead. See docs/specs/types.md.
   */
  readonly documents: readonly Type[];

  private constructor(scope: Scope, site: Site, chain: Chain, documents: readonly Type[] = [DOCUMENT]) {
    this.scope = scope;
    this.site = site;
    this.chain = chain;
    this.documents = documents;
  }

  /** The proof at a dotted path of the document on `level` — this level unless said otherwise. */
  typeAt(path: string, level: number = this.level): Type {
    return at(this.documents[level], path);
  }

  /** The same Env, with the document on this level changed. */
  private withDocument(doc: Type): Env {
    const documents = [...this.documents];
    documents[this.level] = doc;
    return new Env(this.scope, this.site, this.chain, documents);
  }

  /** The same Env, with one field path proven to be there. */
  proving(path: string): Env {
    return this.withDocument(written(this.documents[this.level], path, present(this.typeAt(path))));
  }

  /** The same Env, after a write of a value proven `type` at `path` on this level. */
  written(path: string, type: Type): Env {
    return this.withDocument(written(this.documents[this.level], path, type));
  }

  /** The same Env, with the document on this level replaced by `doc`. */
  document(doc: Type): Env {
    return this.withDocument(doc);
  }

  /**
   * The Env a program starts in. The compiler reserves every name the program
   * introduces anywhere for the whole of it, so a compiler mint never shadows a
   * parameter bound deeper in.
   */
  static root(program: object, root: Position, chain: Chain = new Chain(root === "statement")): Env {
    const site: Site = { where: { at: root }, root, envelope: "none", boundaries: [], inside: null };
    return new Env(Scope.root(namesIn(program)), site, chain);
  }

  // ── the transitions: each answers a new Env and changes ONE thing ──────────

  /** A name bound to something other than a variable — the document, a slot, a function. */
  bind(js: string, binding: Declared): Env {
    return new Env(this.scope.declare(js, { ...binding, level: this.level }), this.site, this.chain, this.documents);
  }

  /** How many bodies over another collection enclose this node: the level of ITS documents. */
  get level(): number {
    return this.foreign().length;
  }

  /**
   * A located value as THIS level reads it: a variable as itself; a path on this
   * level as the path; a path on a shallower level through the `let` of the
   * boundary that starts the level below it, as `$$<var>`.
   */
  render(loc: Located, pos: number): string {
    if (loc.kind === "var") {
      // An EXPRESSION binds a MongoDB variable — `$map`, `$filter`, `$reduce`,
      // `$let` — but a body over another collection belongs to a STAGE hoisted
      // out of it, where the name is never bound. MEASURED: mongod answers "Use
      // of undefined variable: x", and the pipeline does not run at all.
      if (loc.level < this.level) throw readsEnclosingVariable(loc.hint, this.foreignStage(), pos);
      return loc.ref;
    }
    if (this.site.root === "updateDoc") throw readInUpdateDocument(pos);
    const value = loc.path === "" ? "$$ROOT" : "$" + loc.path;
    if (loc.level === this.level) return value;
    // The boundary whose `let` evaluates against level-`loc.level` documents.
    const boundary = this.foreign()[loc.level];
    if (boundary.capture === null || boundary.capture === undefined) throw noCorrelationSlot(boundary.stage, pos);
    return "$$" + boundary.capture.take(loc.kind, loc.hint, value);
  }

  /** The bodies over another collection enclosing this node, outermost first. */
  private foreign(): readonly Boundary[] {
    return this.site.boundaries.filter(isForeign);
  }

  /** The stage whose body this is — the innermost one over another collection. */
  private foreignStage(): string {
    const boundaries = this.foreign();
    return boundaries[boundaries.length - 1].stage;
  }

  /**
   * The Env after a stage that replaced the document: every field-carried
   * binding is gone, and so is every proof about the document — the document
   * that held those paths is not the document the next stage sees.
   */
  dropFields(by: string, message: (js: string, mutable: boolean) => string): Env {
    return new Env(this.scope.dropFields(by, message), this.site, this.chain, this.documents).withDocument(DOCUMENT);
  }

  /** Into a nested block of statements: outer names visible, a fresh set of declarations. */
  block(): Env {
    return new Env(this.scope.block(), this.site, this.chain, this.documents);
  }

  /** The developer's own variable — a lambda parameter, a `$let` var. */
  param(js: string, type: Type, pos: number): Bound {
    return this.bound(this.scope.param(js, type, pos, this.level));
  }

  /** A compiler mint, named after `hint`, that steps aside from every name the program uses. */
  fresh(hint: string): Bound {
    return this.bound(this.scope.bind(hint));
  }

  /** Move to where phase 4 says a child stands. */
  at(where: Where): Env {
    return new Env(this.scope, { ...this.site, where }, this.chain, this.documents);
  }

  /** Under the arguments of operator `name` — or of none, at a call boundary that is not an operator's. */
  inside(name: string | null): Env {
    return new Env(this.scope, { ...this.site, inside: name }, this.chain, this.documents);
  }

  /** Inside `$literal(…)`. */
  literal(): Env {
    return new Env(this.scope, { ...this.site, envelope: "$literal" }, this.chain, this.documents);
  }

  /**
   * Into an `$elemMatch` body: the element is the root there, and the outer
   * document has NO query path — a body that reads it has no native form.
   */
  element(param: string): Env {
    const site: Site = {
      ...this.site,
      boundaries: [...this.site.boundaries, { stage: "$elemMatch", path: [], element: param, capture: null }],
    };
    return new Env(this.scope, site, this.chain, this.documents);
  }

  /** Into a sub-pipeline: a new chain, the boundary recorded, statement position. A body over another collection starts a document level of its own. */
  enter(boundary: Boundary, chain: Chain): Env {
    const site: Site = {
      ...this.site,
      where: { at: "statement" },
      boundaries: [...this.site.boundaries, { ...boundary, outer: this.chain }],
    };
    const documents = isForeign(boundary) ? [...this.documents, DOCUMENT] : this.documents;
    return new Env(this.scope, site, chain, documents);
  }

  /** The TOP-MOST pipeline's chain: `$$` is the root stream at every depth (HR4). */
  get rootChain(): Chain {
    const first = this.site.boundaries[0];
    return first === undefined || first.outer === undefined ? this.chain : first.outer;
  }

  /** What a JavaScript name means here, or the developer's positioned error. */
  lookup(js: string, pos: number): Binding {
    return this.scope.lookup(js, pos);
  }

  private bound(b: Binder): Bound {
    return { as: b.as, ref: b.ref, env: new Env(b.scope, this.site, this.chain, this.documents) };
  }
}
