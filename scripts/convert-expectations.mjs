// Convert a test file's expectations whose POLARITY the compiler changed.
//
//   expect(() => X).toThrow(…)  →  expect(X).toEqual(<value>)   when X no longer throws (unless X matches a KEEP pattern)
//   expect(X).toEqual(…)        →  expect(() => X).toThrow(msg)  when X now throws
//
// A KEEP pattern (a regex over the call's source) protects a refusal the suite must
// keep asserting: the conversion then leaves that `toThrow` alone, so the run
// fails and names the input the compiler now accepts. Review the result as a
// diff — an accepted input that should have stayed refused is a compiler bug,
// not a test to convert.
//
// Run by hand:  node scripts/convert-expectations.mjs test/<suite>.test.ts ['<keep regex>' …]
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
const { jsmql, ObjectId } = await import(process.cwd() + "/src/index.ts");
const helpers = await import(process.cwd() + "/test/truthy.ts").catch(() => ({}));
const [file, ...keepPatterns] = process.argv.slice(2);
const KEEP = keepPatterns.map((p) => new RegExp(p));
const src = readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const js = (text) =>
  ts
    .transpile("(" + text + ")", { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
    .replace(/^"use strict";\s*/, "")
    .trim()
    .replace(/;\s*$/, "");
const compilerThrew = (e) =>
  !(e instanceof ReferenceError) &&
  !(e instanceof SyntaxError) &&
  !(e instanceof TypeError && !/^jsmql/.test(e.message));
const spell = (v, ind = "") => {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (v instanceof Date) return `new Date(${JSON.stringify(v.toISOString())})`;
  if (v instanceof RegExp) return String(v);
  if (v instanceof Uint8Array) return `new Uint8Array([${[...v].join(", ")}])`;
  if (typeof v === "object" && v._bsontype && /ObjectId/i.test(v._bsontype) && typeof v.toHexString === "function")
    return `new ObjectId(${JSON.stringify(v.toHexString())})`;
  if (Array.isArray(v))
    return v.length === 0 ? "[]" : `[\n${v.map((x) => ind + "  " + spell(x, ind + "  ")).join(",\n")},\n${ind}]`;
  if (typeof v === "object") {
    const ks = Object.keys(v);
    if (ks.length === 0) return "{}";
    return `{\n${ks.map((k) => `${ind}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${spell(v[k], ind + "  ")}`).join(",\n")},\n${ind}}`;
  }
  if (typeof v === "bigint") return `${v}n`;
  return JSON.stringify(v);
};
const scope = { jsmql, ObjectId, ...helpers };
for (const st of sf.statements) {
  if (!ts.isVariableStatement(st)) continue;
  for (const d of st.declarationList.declarations) {
    if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
    try {
      const n0 = Object.keys(scope);
      const v0 = n0.map((k) => scope[k]);
      scope[d.name.text] = new Function(...n0, "return " + js(d.initializer.getText(sf)) + ";")(...v0);
    } catch {}
  }
}
const names = Object.keys(scope);
const values = names.map((n) => scope[n]);
const run = (text) => new Function(...names, "return (" + text + ");")(...values);

const localScope = (node) => {
  const extra = {};
  const chain = [];
  for (let p = node.parent; p; p = p.parent) if (ts.isBlock(p) || ts.isSourceFile(p)) chain.unshift(p);
  for (const blk of chain)
    for (const st of blk.statements) {
      if (st.getStart(sf) >= node.getStart(sf) || !ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
        try {
          const all = { ...scope, ...extra };
          const n0 = Object.keys(all);
          extra[d.name.text] = new Function(...n0, "return " + js(d.initializer.getText(sf)) + ";")(
            ...n0.map((k) => all[k]),
          );
        } catch {}
      }
    }
  return extra;
};
const runAt = (text, node) => {
  const all = { ...scope, ...localScope(node) };
  const n0 = Object.keys(all);
  return new Function(...n0, "return " + js(text) + ";")(...n0.map((k) => all[k]));
};
const edits = [];
const kept = [];
const indentAt = (node) => /^\s*/.exec(src.slice(src.lastIndexOf("\n", node.getStart(sf)) + 1))[0];
const visit = (node) => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const m = node.expression.name.text;
    const inner = node.expression.expression;
    const isExpect =
      ts.isCallExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "expect" &&
      inner.arguments.length === 1;
    if (isExpect && (m === "toEqual" || m === "toStrictEqual" || m === "toBe") && node.arguments.length === 1) {
      const argSrc = inner.arguments[0].getText(sf);
      const subject = inner.arguments[0];
      const literalSubject =
        ts.isLiteralExpression(subject) ||
        subject.kind === ts.SyntaxKind.TrueKeyword ||
        subject.kind === ts.SyntaxKind.FalseKeyword ||
        subject.kind === ts.SyntaxKind.NullKeyword ||
        ts.isArrayLiteralExpression(subject) ||
        ts.isObjectLiteralExpression(subject);
      if (!literalSubject) {
        try {
          runAt(argSrc, node);
        } catch (e) {
          if (!compilerThrew(e)) return;
          edits.push({
            start: node.getStart(sf),
            end: node.getEnd(),
            text: `expect(() => ${argSrc}).toThrow(${JSON.stringify(e.message)})`,
          });
        }
      }
    }
    if (isExpect && m === "toThrow") {
      const fn = inner.arguments[0];
      if (ts.isArrowFunction(fn) && /\bjsmql\b/.test(fn.getText(sf)) && !ts.isBlock(fn.body)) {
        const body = fn.body.getText(sf);
        let value,
          threw = false;
        try {
          value = runAt(body, node);
        } catch (e) {
          threw = true;
          if (!compilerThrew(e)) return;
        }
        if (threw) return;
        const flat = body.replace(/\s+/g, " ");
        if (KEEP.some((re) => re.test(flat))) {
          kept.push(flat.slice(0, 100));
          return;
        }
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: `expect(${body}).toEqual(${spell(value, indentAt(node))})`,
        });
      }
    }
  }
  ts.forEachChild(node, visit);
};
visit(sf);
edits.sort((a, b) => b.start - a.start);
let out = src;
for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
writeFileSync(file, out);
console.log(`${file}: ${edits.length} converted, ${kept.length} kept as refusals`);
for (const k of kept) console.log("  kept: " + k);
