#!/usr/bin/env node
// Differential harness: run a reference compiler and the working-tree compiler over one
// corpus and report every place they disagree.
//
// The suite proves the working tree is self-consistent. It cannot prove the working tree
// still means what it meant, because a refactor rewrites the assertions along with the
// code. This does: the reference is a separate checkout, so it is not editable from here.
//
// Discipline (docs/specs/architecture.md, the acceptance rule): NO divergence may stay
// unclassified. Each one is either a regression to fix, or an intended change recorded in
// the accepted-divergence file with the reason it is correct. The refactor is finished
// when the report holds nothing but accepted rows.
//
//   node scripts/diff-compilers.mjs                 # summary
//   node scripts/diff-compilers.mjs --verbose       # every divergence in full
//   node scripts/diff-compilers.mjs --ref <path>    # a different reference checkout
//   node scripts/diff-compilers.mjs --accept        # record the current divergences as intended
//   node scripts/diff-compilers.mjs --cur src/compiler/index.ts --entry expr
//                                                   # one target of a second compiler against the
//                                                   # reference, with a `skipped` class for a
//                                                   # source that belongs to another target
//
// Exit code is 1 while any UNACCEPTED divergence remains, so CI can gate on it.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

// The reference defaults to the main checkout this worktree hangs off:
// <root>/.claude/worktrees/<name> → <root>.
const DEFAULT_REF = resolve(root, "..", "..", "..");
const refRoot = resolve(opt("--ref", DEFAULT_REF));
const ACCEPTED_PATH = join(root, "test", "accepted-divergences.json");

if (resolve(refRoot) === resolve(root)) {
  console.error("diff-compilers: the reference and the working tree are the same checkout.");
  console.error(`Pass --ref <path> to a different one. Tried: ${refRoot}`);
  process.exit(2);
}
const refEntry = join(refRoot, "src", "index.ts");
if (!existsSync(refEntry)) {
  console.error(`diff-compilers: no compiler at ${refEntry}. Pass --ref <path>.`);
  process.exit(2);
}

/**
 * The identity of the reference COMPILER — the git commit its `src/` is at, plus whether
 * that `src/` has uncommitted edits.
 *
 * The reference is "the checkout this worktree hangs off", and that checkout belongs to
 * whoever else is working in it. It can move under a run: a sibling session checking out a
 * branch changes what "no divergence" means, and every neutrality claim measured against it
 * silently changes with it. Reading the identity costs nothing and makes the move visible.
 *
 * Only `src/` counts. A reference that moved for docs or a landing page is the same compiler.
 */
function referenceIdentity() {
  const git = (args) => {
    const r = spawnSync("git", ["-C", refRoot, ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const commit = git(["rev-parse", "--short", "HEAD"]);
  if (commit === null) return { commit: "unknown", srcTree: "unknown", dirty: false };
  // The TREE hash of src/ — identical across two commits that never touched the compiler,
  // which is exactly the distinction that matters here.
  const srcTree = git(["rev-parse", "HEAD:src"]) ?? "unknown";
  const dirty = git(["status", "--porcelain", "--", "src"]) !== "";
  return { commit, srcTree, dirty };
}

const refId = referenceIdentity();

const { jsmql: ref } = await import(pathToFileURL(refEntry).href);
// `--cur` names a module whose named exports ARE the entry points (`expr`, …), the
// new compiler's shape; without it the working tree's `jsmql` callable is compared.
const curPath = opt("--cur", null);
const curModule = await import(
  pathToFileURL(curPath === null ? join(root, "src", "index.ts") : resolve(root, curPath)).href
);
const cur = curPath === null ? curModule.jsmql : curModule;
// The new compiler's `expr` is the VALUE target. The shipped `jsmql.expr` also accepts a
// statement program and answers with a pipeline; those sources belong to the statement
// slice. A source is statement-shaped when the expression parser refuses it and the
// statement parser accepts it — checked, not assumed.
const newParse =
  curPath === null ? null : await import(pathToFileURL(join(root, "src", "compiler", "parse", "parser.ts")).href);
const newShape =
  curPath === null ? null : await import(pathToFileURL(join(root, "src", "compiler", "passes", "shape.ts")).href);
const newDesugar =
  curPath === null ? null : await import(pathToFileURL(join(root, "src", "compiler", "passes", "desugar.ts")).href);
const isStatementShaped = (src) => {
  if (newParse === null) return false;
  try {
    newParse.parseExpression(src);
  } catch {
    try {
      newParse.parse(src);
      return true;
    } catch {
      return false;
    }
  }
  // An expression that parses may still BE a pipeline — a bracketed stage list.
  try {
    return newShape.shapeOf(newDesugar.desugar(newParse.parse(src))) === "pipeline";
  } catch {
    return false;
  }
};

// ── corpus ───────────────────────────────────────────────────────────────────
// Every jsmql source string the test suite already exercises, plus generated
// permutations. Harvesting the suite is what makes the corpus wider than any list
// written by hand: it inherits every case anyone thought worth a test.

/**
 * Pull jsmql source out of the test suite's call sites.
 *
 * THREE spellings, and missing any of them is a silent coverage hole rather than a visible
 * one: the quoted call argument `jsmql("…")`, the BACKTICK call argument `` jsmql(`…`) ``,
 * and the template-TAG form `` jsmql`…` `` (a first-class entry point, not a fallback).
 * Reading only the quoted form left the suites that favour backticks — and the whole of
 * `realistic.test.ts`'s tag cases — outside the corpus, which is how a real divergence sat
 * unjudged behind the harvester instead of in the report.
 *
 * A backtick body containing `${` is SKIPPED. Interpolation makes the source dynamic, so
 * there is no static string to compile, and the runtime-injected-value rules (HR1) give it
 * different meaning anyway.
 */
function harvestFromTests() {
  const dir = join(root, "test");
  const found = new Set();
  const ENTRY = String.raw`jsmql(?:\.(?:expr|filter|pipeline|update|validate))?`;
  const QUOTED = new RegExp(String.raw`\b${ENTRY}\(\s*(["'])((?:\\.|(?!\1).)*)\1`, "g");
  // `jsmql(`…`)` — a backtick CALL argument.
  const BACKTICK_CALL = new RegExp(String.raw`\b${ENTRY}\(\s*` + "`([^`]*)`", "g");
  // `` jsmql`…` `` — the template-TAG form, no parenthesis.
  const BACKTICK_TAG = new RegExp(String.raw`\b${ENTRY}` + "`([^`]*)`", "g");

  const add = (s) => {
    if (typeof s === "string" && s.trim().length > 0) found.add(s);
  };

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(QUOTED)) {
      // Un-escape the literal so the compiler sees what the test's compiler saw.
      try {
        add(JSON.parse(m[1] === '"' ? `"${m[2]}"` : `"${m[2].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`));
      } catch {
        continue;
      }
    }
    for (const re of [BACKTICK_CALL, BACKTICK_TAG]) {
      for (const m of src.matchAll(re)) {
        const body = m[1];
        if (body.includes("${")) continue; // interpolated — not a static source
        // A backtick body carries no JS escapes to undo, but it does carry real newlines,
        // which is exactly how the multi-statement pipeline cases are written.
        add(body);
      }
    }
  }
  return [...found];
}

/** Generated coverage: each method against each receiver shape, in both positions. */
function generatedCorpus() {
  const out = [];
  const RECEIVERS = ["$.arr", "$.s", "$.n", "$.obj", "[1,2,3]", '"abc"'];
  const CALLS = [
    "take(2)",
    "drop(2)",
    "slice(1,2)",
    "slice(-2)",
    "map(x => x)",
    "filter(x => x)",
    "uniq()",
    "uniqBy('t')",
    "sortBy('t')",
    "groupBy('t')",
    "countBy('t')",
    "keyBy('t')",
    "reduce((a,b) => a + b, 0)",
    "some(x => x)",
    "every(x => x)",
    "includes(1)",
    "join(',')",
    "trim()",
    "toUpperCase()",
    "startsWith('a')",
    "endsWith('a')",
    "padStart(4,'x')",
    "charAt(1)",
    "substr(1,2)",
    "substring(1,2)",
    "at(-1)",
    "concat([1])",
    "flat()",
    "reverse()",
    "length",
  ];
  for (const r of RECEIVERS) {
    for (const c of CALLS) out.push(`${r}.${c}`);
  }
  const STREAM = [
    "$$ = $$.filter(d => d.a > 1);",
    "$$ = $$.map(d => d.t);",
    "$$ = $$.take(2);",
    "$$ = $$.uniqBy('t');",
    "$$ = $$.sortBy('t');",
    "$$ = $$.groupBy('t');",
    "$match($.a > 1);",
    "$ = { a: $.b };",
    "$.x = $.a + 1;",
    "delete $.x;",
    "$.o = $$$.orders.find(o => o.uid === $._id);",
    "$$.push({ a: 1 });",
    "let n = 5; $.v = n;",
    "const f = (a) => a + 1; $.v = f(1);",
  ];
  out.push(...STREAM);
  // Shapes a behaviour change is likely to move but that no test happened to spell.
  // A corpus harvested from tests inherits their blind spots, so the edges go in by hand.
  const EDGES = [
    "$.a.take(1.5)",
    "$.a.drop(1.5)",
    "$.a.slice(0.5)",
    "$.a.slice(0, 2.5)",
    "$.a.sampleSize(1.5)",
    "$.a.takeRight(2.5)",
    "$.a.chunk(1.5)",
    "$.a.take($.n)",
    '$year({ date: $.d, timezone: "UTC" })',
    "$hour({ date: $.d })",
    '$year("2020-01-01")',
    '$lookup({ from: "o", pipeline: [$ = { t: $.total }], as: "o" });',
    '$lookup({ from: "o", pipeline: [$.a = 1], as: "o" });',
    '$unionWith({ coll: "o", pipeline: [$ = { a: 1 }] });',
    "$.x = $.a.map(d => { const q = $$.push({n:d}); return q; });",
    '$.arr.pick(["id","val"])',
    '$.arr.omit(["type"])',
    "$match($sampleRate(0.1));",
    "let k = $.x; $$ = $$$.orders.map(o => ({ t: o.items.map(v => v + k) }));",
    "$.a.map(x => x, 1)",
    "$.a.filter(x => x, 1)",
    "$.a.findIndex(x => x, 1)",
    'typeof $.a === "boolean"',
    'typeof $.a === "number"',
    'typeof $.a === "string"',
    'typeof $.a !== "boolean"',
    'typeof $.a !== "number"',
    'typeof $.a === "function"',
    'typeof $.a.b.c === "number"',
    '$set({ t: typeof $.a === "boolean" });',
    '$unionWith({ coll: "c", pipeline: [$match($.a > 0), $.o = $$$.orders.find(o => o.uid === 1)] });',
    '$lookup({ from: "o", pipeline: [$.x = $$$.items.find(i => i.k === 1)], as: "o" });',
    "$facet({ a: [$.o = $$$.orders.find(o => o.uid === 1)] });",
    "$project({ o: $$$.orders.find(o => o.uid === 1) });",
  ];
  out.push(...EDGES);
  const PREDICATES = [
    "$.age > 18",
    "$.a === 1 && $.b < 2",
    "$.tags.includes('x')",
    "$.s.match(/^a/)",
    "$.items.some(i => i.q > 2)",
    "typeof $.x === 'string'",
    "$.x % 4 === 1",
    "$.x === null",
    "$.x !== undefined",
    "['a','b'].includes($.s)",
  ];
  out.push(...PREDICATES);
  return out;
}

const CORPUS = [...new Set([...harvestFromTests(), ...generatedCorpus()])];

// ── comparison ───────────────────────────────────────────────────────────────
// JSON.stringify flattens the BSON values jsmql deliberately emits in-situ (RegExp,
// Date, ObjectId), so two different regexes would compare equal. Tag them instead.
function stable(v) {
  if (v === null || typeof v !== "object") return typeof v === "bigint" ? `«bigint:${v}»` : v;
  if (v instanceof RegExp) return `«regexp:${v.source}/${v.flags}»`;
  if (v instanceof Date) return `«date:${v.toISOString()}»`;
  if (Array.isArray(v)) return v.map(stable);
  if (typeof v?.toHexString === "function") return `«oid:${v.toHexString()}»`;
  if (v instanceof Uint8Array) return `«bin:${Buffer.from(v).toString("hex")}»`;
  const out = {};
  for (const k of Object.keys(v)) out[k] = stable(v[k]);
  return out;
}

/**
 * The entry points compared. `validate` is here because its result IS a public contract —
 * `{ valid, errors: [{ message, pos }] }`, and tooling underlines source with that `.pos`.
 * A migration that changed an error's wording or moved its caret produced ZERO divergence
 * while the other four entries only ever see the throw, never the position.
 */
const ALL_ENTRIES = ["jsmql", "expr", "filter", "pipeline", "update", "validate"];
const ENTRIES = opt("--entry", null) === null ? ALL_ENTRIES : [opt("--entry", null)];
const call = (api, entry, src) => (entry === "jsmql" ? api(src) : api[entry](src));

function run(api, entry, src) {
  try {
    return { ok: true, value: JSON.stringify(stable(call(api, entry, src))) };
  } catch (e) {
    return { ok: false, value: e instanceof Error ? e.message : String(e) };
  }
}

const accepted = existsSync(ACCEPTED_PATH) ? JSON.parse(readFileSync(ACCEPTED_PATH, "utf8")) : { rows: {} };
const keyOf = (entry, src) => `${entry} ${src}`;

const rows = [];
const skipped = [];
for (const src of CORPUS) {
  for (const entry of ENTRIES) {
    const a = run(ref, entry, src);
    const b = run(cur, entry, src);
    if (a.ok === b.ok && a.value === b.value) continue;
    // The shipped `expr` answers a statement program with a PIPELINE (an array): that
    // source is the statement slice whatever its spelling — a lone `$match(…)` included.
    const refIsPipeline = a.ok && a.value.startsWith("[");
    // The new compiler's entries are VALUE and FILTER targets; a statement program is the
    // statement slice's, whichever entry it reached.
    const valueOrFilter = entry === "expr" || entry === "filter";
    if (curPath !== null && valueOrFilter && (refIsPipeline || isStatementShaped(src))) {
      skipped.push({ key: keyOf(entry, src), entry, src, why: "statement-shaped" });
      continue;
    }
    const kind = a.ok && b.ok ? "output" : !a.ok && !b.ok ? "message" : a.ok ? "now-rejected" : "now-accepted";
    rows.push({ key: keyOf(entry, src), entry, src, kind, ref: a, cur: b });
  }
}

if (flag("--accept")) {
  // Stamp WHICH compiler these rows were judged against. A row accepted against one
  // reference says nothing about a different one.
  const next = { reference: refId, rows: { ...accepted.rows } };
  // A row of THIS entry that no longer diverges is stale: the two compilers agree
  // again, and a kept row would claim a divergence nobody can see.
  const live = new Set(rows.map((r) => r.key));
  let pruned = 0;
  for (const key of Object.keys(next.rows)) {
    if (ENTRIES.includes(next.rows[key].entry) && !live.has(key)) {
      delete next.rows[key];
      pruned++;
    }
  }
  for (const r of rows) {
    // Record what actually changed, not just that something did. A reviewer reads this
    // file to judge whether the change was right, and cannot do that from a key alone.
    // An existing row keeps its reason and takes the CURRENT kind and outputs: a
    // reason judges a class of change, and the row must show the change it judges.
    next.rows[r.key] = {
      entry: r.entry,
      src: r.src,
      kind: r.kind,
      was: String(r.ref.value).replace(/\s+/g, " ").slice(0, 220),
      now: String(r.cur.value).replace(/\s+/g, " ").slice(0, 220),
      reason: next.rows[r.key]?.reason ?? "TODO: state why this change is correct",
    };
  }
  writeFileSync(ACCEPTED_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`recorded ${rows.length} divergence(s), pruned ${pruned} stale row(s) → ${ACCEPTED_PATH}`);
  console.log("Every row needs its `reason` filled in before this counts as classified.");
  process.exit(0);
}

const unaccepted = rows.filter((r) => accepted.rows[r.key] === undefined);
const unreasoned = rows.filter((r) => accepted.rows[r.key]?.reason?.startsWith("TODO"));

const byKind = (list) =>
  list.reduce((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {});

const recordedTree = accepted.reference?.srcTree;
const referenceMoved = recordedTree !== undefined && recordedTree !== refId.srcTree;

console.log(`reference : ${refRoot}`);
console.log(
  `  at      : ${refId.commit}  src-tree ${refId.srcTree.slice(0, 12)}${refId.dirty ? "  (src/ DIRTY)" : ""}`,
);
console.log(`corpus    : ${CORPUS.length} sources × ${ENTRIES.length} entry points`);
console.log(`divergent : ${rows.length}  ${JSON.stringify(byKind(rows))}`);
if (curPath !== null) {
  console.log(`skipped   : ${skipped.length}  (statement-shaped: the statement slice)`);
}
console.log(`accepted  : ${rows.length - unaccepted.length}`);
console.log(`UNCLASSIFIED: ${unaccepted.length}`);

if (referenceMoved || refId.dirty) {
  console.error("");
  console.error("diff-compilers: THE REFERENCE COMPILER IS NOT THE ONE THESE ROWS WERE JUDGED AGAINST.");
  if (referenceMoved) {
    console.error(`  accepted rows recorded against src-tree ${String(recordedTree).slice(0, 12)}`);
    console.error(`  this run compared against       src-tree ${refId.srcTree.slice(0, 12)}`);
  }
  if (refId.dirty) console.error(`  ${refRoot}/src has uncommitted edits`);
  console.error("  Every 'accepted' row above is measured against a different compiler, so a real");
  console.error("  regression can read as an already-accepted divergence. Restore the reference, or");
  console.error("  re-judge the rows against this one with --accept.");
  process.exit(3);
}
if (unreasoned.length > 0) console.log(`accepted-but-unreasoned: ${unreasoned.length}`);

const show = flag("--verbose") ? rows : unaccepted;
for (const r of show.slice(0, flag("--verbose") ? rows.length : 40)) {
  const mark = accepted.rows[r.key] ? "accepted" : "NEW";
  console.log(`\n── [${r.kind}] ${mark}  ${r.entry}(${JSON.stringify(r.src).slice(0, 96)})`);
  console.log(`   ref: ${String(r.ref.value).replace(/\s+/g, " ").slice(0, 150)}`);
  console.log(`   cur: ${String(r.cur.value).replace(/\s+/g, " ").slice(0, 150)}`);
}
if (!flag("--verbose") && unaccepted.length > 40) console.log(`\n… and ${unaccepted.length - 40} more`);

process.exit(unaccepted.length > 0 || unreasoned.length > 0 ? 1 : 0);
