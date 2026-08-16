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
const { jsmql: cur } = await import(pathToFileURL(join(root, "src", "index.ts")).href);

// ── corpus ───────────────────────────────────────────────────────────────────
// Every jsmql source string the test suite already exercises, plus generated
// permutations. Harvesting the suite is what makes the corpus wider than any list
// written by hand: it inherits every case anyone thought worth a test.

/** Pull the string argument out of `jsmql("…")` / `jsmql.expr('…')` / … call sites. */
function harvestFromTests() {
  const dir = join(root, "test");
  const found = new Set();
  const CALL = /\bjsmql(?:\.(?:expr|filter|pipeline|update))?\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(CALL)) {
      let s = m[2];
      // Un-escape the literal so the compiler sees what the test's compiler saw.
      try {
        s = JSON.parse(m[1] === '"' ? `"${s}"` : `"${s.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
      } catch {
        continue;
      }
      if (s.trim().length > 0) found.add(s);
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

const ENTRIES = ["jsmql", "expr", "filter", "pipeline", "update"];
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
for (const src of CORPUS) {
  for (const entry of ENTRIES) {
    const a = run(ref, entry, src);
    const b = run(cur, entry, src);
    if (a.ok === b.ok && a.value === b.value) continue;
    const kind = a.ok && b.ok ? "output" : !a.ok && !b.ok ? "message" : a.ok ? "now-rejected" : "now-accepted";
    rows.push({ key: keyOf(entry, src), entry, src, kind, ref: a, cur: b });
  }
}

if (flag("--accept")) {
  // Stamp WHICH compiler these rows were judged against. A row accepted against one
  // reference says nothing about a different one.
  const next = { reference: refId, rows: { ...accepted.rows } };
  for (const r of rows) {
    // Record what actually changed, not just that something did. A reviewer reads this
    // file to judge whether the change was right, and cannot do that from a key alone.
    next.rows[r.key] ??= {
      entry: r.entry,
      src: r.src,
      kind: r.kind,
      was: String(r.ref.value).replace(/\s+/g, " ").slice(0, 220),
      now: String(r.cur.value).replace(/\s+/g, " ").slice(0, 220),
      reason: "TODO: state why this change is correct",
    };
  }
  writeFileSync(ACCEPTED_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`recorded ${rows.length} divergence(s) → ${ACCEPTED_PATH}`);
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
