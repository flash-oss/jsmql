import type { Position, Stage, Type } from "../../registry/vocabulary.ts";
import type { BodyPath } from "../rows.ts";
import type { Where } from "../passes/position.ts";
import type { Binding, Binder, Declared, FieldSlot, Located, MongoVar, VarRef } from "./names.ts";
import { Capture, Scope, scratchSlot } from "./names.ts";
import { DOCUMENT, at, present, removed, written } from "./type.ts";
import { JSMQL_NS } from "../../namespace.ts";
import { namesIn } from "../passes/fresh.ts";
import { pipelineOverOf, preservesCountOf, statementBodyOf } from "../rows.ts";
import { noCorrelationSlot, readInUpdateDocument, readsEnclosingVariable } from "./errors.ts";

export type Boundary = {
  readonly stage: string;
  readonly path: BodyPath;
  readonly element?: string;
  readonly capture?: Capture | null;
  readonly outer?: Chain;
};

export const isForeign = (b: Boundary): boolean => pipelineOverOf(b.stage) === "foreign";

export type Site = {
  readonly where: Where;
  readonly root: Position;
  readonly envelope: "none" | "$literal";
  readonly boundaries: readonly Boundary[];
  readonly inside: string | null;
  readonly settling: boolean;
};

export function injectedPlacement(site: Site): "literal" | "asWritten" | "refused" {
  if (site.envelope === "$literal" || site.root === "updateDoc" || site.where.at === "filter") return "asWritten";
  if (site.where.at === "value" && site.where.written === undefined) return "literal";
  return "refused";
}

export type ChainMark = {
  readonly hoisted: number;
  readonly stamped: ReadonlySet<string>;
  readonly slots: number;
  readonly dirty: boolean;
  readonly element: string;
  readonly terminal: Chain["terminal"];
  readonly bareReads: number;
  readonly writes: number;
};

export class Chain {
  readonly isPipeline: boolean;
  constructor(isPipeline = true) {
    this.isPipeline = isPipeline;
  }
  readonly emitted: Stage[] = [];
  readonly hoisted: Stage[] = [];
  private slots = 0;
  get dirty(): boolean {
    return this.holdsNamespace;
  }
  set dirty(v: boolean) {
    if (v) this.writes++;
    this.holdsNamespace = v;
  }
  private holdsNamespace = false;
  writes = 0;
  source: Chain | null = null;
  terminal: { readonly stage: Stage; readonly spelled: string } | null = null;
  element = "";
  private readonly proofs = new WeakMap<object, Type>();
  proved(node: object, type: Type): void {
    this.proofs.set(node, type);
  }
  proofOf(node: object): Type | undefined {
    return this.proofs.get(node);
  }

  placed(replaces: boolean): void {
    if (replaces) this.element = "";
  }

  namespaceRemoved(): void {
    this.stamped.clear();
  }

  slot(): FieldSlot {
    this.dirty = true;
    return scratchSlot(this.slots++);
  }

  private stamped = new Set<string>();

  mark(): ChainMark {
    return {
      hoisted: this.hoisted.length,
      stamped: new Set(this.stamped),
      slots: this.slots,
      dirty: this.dirty,
      element: this.element,
      terminal: this.terminal,
      bareReads: this.bareReads,
      writes: this.writes,
    };
  }

  rewind(m: ChainMark): void {
    this.hoisted.length = m.hoisted;
    this.stamped = new Set(m.stamped);
    this.slots = m.slots;
    this.dirty = m.dirty;
    this.element = m.element;
    this.terminal = m.terminal;
    this.bareReads = m.bareReads;
    this.writes = m.writes;
  }

  bareReads = 0;
  clearRoot = false;

  wholeDocument(): unknown {
    const fed: Chain[] = [];
    for (let c: Chain | null = this; c !== null; c = c.source) fed.push(c);
    if (this.dirty || fed.some((c) => c.clearRoot)) return { $unsetField: { field: JSMQL_NS, input: "$$ROOT" } };
    for (const c of fed) c.bareReads++;
    return "$$ROOT";
  }

  hoist(stages: readonly Stage[], reads: string): string {
    if (!this.stamped.has(reads)) {
      this.hoisted.push(...stages);
      this.stamped.add(reads);
      this.dirty = true;
    }
    return "$" + reads;
  }

  advance(stages: readonly Stage[]): void {
    for (const stage of stages) {
      if (!preservesCountOf(Object.keys(stage)[0])) {
        this.stamped.clear();
        return;
      }
    }
  }

  ahead(): Stage[] {
    const out = [...this.hoisted];
    this.hoisted.length = 0;
    return out;
  }

  flush(): void {
    this.emitted.push(...this.ahead());
  }

  close(): Stage[] {
    this.flush();
    const out = [...this.emitted];
    if (this.dirty) out.push({ $unset: JSMQL_NS });
    if (this.terminal !== null) out.push(this.terminal.stage);
    return out;
  }
}

export type Bound = { readonly as: MongoVar; readonly ref: VarRef; readonly env: Env };

export class Env {
  readonly scope: Scope;
  readonly site: Site;
  readonly chain: Chain;
  readonly documents: readonly Type[];

  private constructor(scope: Scope, site: Site, chain: Chain, documents: readonly Type[] = [DOCUMENT]) {
    this.scope = scope;
    this.site = site;
    this.chain = chain;
    this.documents = documents;
  }

  typeAt(path: string, level: number = this.level): Type {
    return at(this.documents[level], path);
  }

  private withDocument(doc: Type): Env {
    const documents = [...this.documents];
    documents[this.level] = doc;
    return new Env(this.scope, this.site, this.chain, documents);
  }

  proving(path: string): Env {
    return this.withDocument(written(this.documents[this.level], path, present(this.typeAt(path))));
  }

  provingName(js: string): Env {
    const b = this.scope.lookup(js, 0);
    return new Env(this.scope.declare(js, { ...b, type: present(b.type) }), this.site, this.chain, this.documents);
  }

  written(path: string, type: Type): Env {
    return this.withDocument(written(this.documents[this.level], path, type));
  }

  removed(path: string): Env {
    return this.withDocument(removed(this.documents[this.level], path));
  }

  document(doc: Type): Env {
    return this.withDocument(doc);
  }

  static root(program: object, root: Position, chain: Chain = new Chain(root === "statement"), settling = false): Env {
    const site: Site = { where: { at: root }, root, envelope: "none", boundaries: [], inside: null, settling };
    return new Env(Scope.root(namesIn(program)), site, chain);
  }

  bind(js: string, binding: Declared): Env {
    return new Env(this.scope.declare(js, { ...binding, level: this.level }), this.site, this.chain, this.documents);
  }

  get level(): number {
    return this.foreign().length;
  }

  render(loc: Located, pos: number): string {
    if (loc.kind === "var") {
      if (loc.level < this.level) throw readsEnclosingVariable(loc.hint, this.foreignStage(), pos);
      return loc.ref;
    }
    return this.hop(loc, loc.path === "" ? "$$ROOT" : "$" + loc.path, pos) as string;
  }

  value(loc: Located, pos: number): unknown {
    if (loc.kind === "var" || loc.path !== "") return this.render(loc, pos);
    if (this.site.root === "updateDoc") throw readInUpdateDocument("$$ROOT", pos);
    const chain = loc.level === this.level ? this.chain : (this.foreign()[loc.level].outer ?? this.chain);
    return this.hop(loc, chain.wholeDocument(), pos);
  }

  private hop(loc: Exclude<Located, { kind: "var" }>, value: unknown, pos: number): unknown {
    if (this.site.root === "updateDoc") throw readInUpdateDocument(value as string, pos);
    if (loc.level === this.level) return value;
    const boundary = this.foreign()[loc.level];
    if (boundary.capture === null || boundary.capture === undefined) throw noCorrelationSlot(boundary.stage, pos);
    return "$$" + boundary.capture.take(loc.kind, loc.hint, value);
  }

  private foreign(): readonly Boundary[] {
    return this.site.boundaries.filter(isForeign);
  }

  private foreignStage(): string {
    const boundaries = this.foreign();
    return boundaries[boundaries.length - 1].stage;
  }

  dropFields(by: string, message: (js: string, mutable: boolean) => string): Env {
    return new Env(this.scope.dropFields(by, message), this.site, this.chain, this.documents).withDocument(DOCUMENT);
  }

  clearedSince(before: Env, message: (js: string, mutable: boolean) => string): Env {
    return new Env(this.scope.clearedSince(before.scope, message), this.site, this.chain, this.documents);
  }

  param(js: string, type: Type, pos: number): Bound {
    return this.bound(this.scope.param(js, type, pos, this.level));
  }

  fresh(hint: string): Bound {
    return this.bound(this.scope.bind(hint));
  }

  at(where: Where): Env {
    return new Env(this.scope, { ...this.site, where }, this.chain, this.documents);
  }

  backAt(parent: Env): Env {
    return new Env(this.scope, parent.site, this.chain, this.documents);
  }

  inside(name: string | null): Env {
    return new Env(this.scope, { ...this.site, inside: name }, this.chain, this.documents);
  }

  literal(): Env {
    return new Env(this.scope, { ...this.site, envelope: "$literal" }, this.chain, this.documents);
  }

  element(param: string): Env {
    const site: Site = {
      ...this.site,
      boundaries: [...this.site.boundaries, { stage: "$elemMatch", path: [], element: param, capture: null }],
    };
    return new Env(this.scope, site, this.chain, this.documents);
  }

  enter(boundary: Boundary, chain: Chain): Env {
    const site: Site = {
      ...this.site,
      where: { at: "statement" },
      boundaries: [...this.site.boundaries, { ...boundary, outer: this.chain }],
    };
    const documents = isForeign(boundary) ? [...this.documents, DOCUMENT] : this.documents;
    if (!isForeign(boundary) && statementBodyOf(boundary.stage) === "pipeline") {
      chain.dirty ||= this.chain.dirty;
      chain.source = this.chain;
    }
    return new Env(this.scope, site, chain, documents);
  }

  get rootChain(): Chain {
    const first = this.site.boundaries[0];
    return first === undefined || first.outer === undefined ? this.chain : first.outer;
  }

  lookup(js: string, pos: number): Binding {
    return this.scope.lookup(js, pos);
  }

  private bound(b: Binder): Bound {
    return { as: b.as, ref: b.ref, env: new Env(b.scope, this.site, this.chain, this.documents) };
  }
}
