// Regenerate a test file's expectations from the compiler, through the TypeScript AST.
//
// The inputs are the contract; the emitted MQL is the compiler's answer. When a
// lowering changes shape on purpose, every `toEqual` in a suite would need the same
// hand edit — this script makes them, and only them:
//   expect(<call>).toEqual|toStrictEqual|toBe(<literal>)   → the literal becomes the compiler's answer
//   expect(() => <call>).toThrow(<matcher>)                → the matcher becomes the message the compiler raises
// A call that throws where a value was expected, or returns where a throw was
// expected, is left as it is and listed: a polarity change is a behaviour change,
// which a human judges (see convert-expectations.mjs for the mechanical half).
// The regenerated file must be reviewed as a diff: a wrong answer regenerates just as well as a right one.
//
// Run by hand:  node scripts/regen-expectations.mjs test/<suite>.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
const { jsmql, ObjectId } = await import(process.cwd() + "/src/index.ts");
const helpers = await import(process.cwd() + "/test/truthy.ts").catch(() => ({}));
const file = process.argv[2];
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
// the file's own top-level constants, evaluated in order where they can be (a literal, a helper arrow, a table)
for (const st of sf.statements) {
  if (!ts.isVariableStatement(st)) continue;
  for (const d of st.declarationList.declarations) {
    if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
    try {
      const names0 = Object.keys(scope);
      const values0 = names0.map((k) => scope[k]);
      scope[d.name.text] = new Function(...names0, "return " + js(d.initializer.getText(sf)) + ";")(...values0);
    } catch {
      /* not evaluable outside the module */
    }
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
const fromCompiler = (text, node) => {
  if (/\bjsmql\b/.test(text)) return true;
  const chain = [];
  for (let p = node.parent; p; p = p.parent) if (ts.isBlock(p) || ts.isSourceFile(p)) chain.unshift(p);
  const inits = new Map();
  for (const blk of chain)
    for (const st of blk.statements)
      if (ts.isVariableStatement(st) && st.getStart(sf) < node.getStart(sf))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.initializer) inits.set(d.name.text, d.initializer.getText(sf));
  const seen = new Set();
  const mentions = (t) => {
    for (const [name, init] of inits)
      if (!seen.has(name) && new RegExp("\\b" + name + "\\b").test(t)) {
        seen.add(name);
        if (/\bjsmql\b/.test(init) || mentions(init)) return true;
      }
    return false;
  };
  return mentions(text);
};
const edits = [];
const left = [];
let skipped = 0;
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
      if (!fromCompiler(argSrc, node)) return;
      const literalSubject =
        ts.isLiteralExpression(subject) ||
        subject.kind === ts.SyntaxKind.TrueKeyword ||
        subject.kind === ts.SyntaxKind.FalseKeyword ||
        subject.kind === ts.SyntaxKind.NullKeyword ||
        ts.isArrayLiteralExpression(subject) ||
        ts.isObjectLiteralExpression(subject);
      if (!literalSubject) {
        try {
          const value = runAt(argSrc, node);
          const primitive = value === null || (typeof value !== "object" && typeof value !== "function");
          if (m === "toBe" && !primitive)
            edits.push({
              start: node.expression.name.getStart(sf),
              end: node.expression.name.getEnd(),
              text: "toEqual",
            });
          edits.push({
            start: node.arguments[0].getStart(sf),
            end: node.arguments[0].getEnd(),
            text: spell(value, indentAt(node)),
          });
        } catch (e) {
          if (!compilerThrew(e)) skipped++;
          else
            left.push(
              "VALUE→THROWS  " + argSrc.replace(/\s+/g, " ").slice(0, 100) + "\n      " + e.message.slice(0, 120),
            );
        }
      }
    }
    if (isExpect && m === "toMatch" && node.arguments.length === 1) {
      const subject = inner.arguments[0];
      if (!ts.isLiteralExpression(subject)) {
        try {
          const value = runAt(subject.getText(sf), node);
          if (typeof value === "string") {
            const lit = node.arguments[0];
            const cur = lit.getText(sf);
            let matches = false;
            try {
              const mv = new Function("return (" + cur + ");")();
              matches = mv instanceof RegExp ? mv.test(value) : typeof mv === "string" ? value.includes(mv) : true;
            } catch {
              matches = true;
            }
            if (!matches) edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: JSON.stringify(value) });
          }
        } catch {
          /* not evaluable here */
        }
      }
    }
    if (isExpect && m === "toThrow" && node.arguments.length <= 1) {
      const fn = inner.arguments[0];
      if (ts.isArrowFunction(fn) && /\bjsmql\b/.test(fn.getText(sf))) {
        const body = fn.body.getText(sf);
        let threw = null;
        try {
          runAt(ts.isBlock(fn.body) ? "(" + fn.getText(sf) + ")()" : body, node);
        } catch (e) {
          threw = e;
        }
        if (threw !== null && !compilerThrew(threw)) {
          skipped++;
          threw = undefined;
        }
        if (threw === null) left.push("THROW→VALUE   " + body.replace(/\s+/g, " ").slice(0, 110));
        else if (threw === undefined) {
          /* cannot evaluate here */
        } else if (node.arguments.length === 1) {
          const lit = node.arguments[0];
          // keep a matcher that still matches; replace one that no longer does
          const cur = lit.getText(sf);
          let matches = false;
          try {
            const mv = new Function("return (" + cur + ");")();
            matches =
              mv instanceof RegExp
                ? mv.test(threw.message)
                : typeof mv === "string"
                  ? threw.message.includes(mv)
                  : true;
          } catch {
            matches = true;
          }
          if (!matches) edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: JSON.stringify(threw.message) });
        }
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
console.log(
  `${file}: ${edits.length} expectations regenerated, ${left.length} left for review, ${skipped} not evaluable here`,
);
for (const l of left) console.log("  " + l);
