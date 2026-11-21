import ts from "typescript";
import { compilerThrew, expectCall, literalSubject, openSuite, spell } from "./expectations.mjs";

const file = process.argv[2];
const { sf, runAt, write } = openSuite(file);

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

const matcherAccepts = (source, message) => {
  try {
    const m = new Function("return (" + source + ");")();
    return m instanceof RegExp ? m.test(message) : typeof m === "string" ? message.includes(m) : true;
  } catch {
    return true;
  }
};

const edits = [];
const left = [];
let skipped = 0;

const visit = (node) => {
  const call = expectCall(node);
  if (call !== null) {
    const { method, methodName, subject, args } = call;
    if ((method === "toEqual" || method === "toStrictEqual" || method === "toBe") && args.length === 1) {
      const argSrc = subject.getText(sf);
      if (!fromCompiler(argSrc, node)) return;
      if (!literalSubject(subject)) {
        try {
          const value = runAt(argSrc, node);
          const primitive = value === null || (typeof value !== "object" && typeof value !== "function");
          if (method === "toBe" && !primitive) {
            edits.push({ start: methodName.getStart(sf), end: methodName.getEnd(), text: "toEqual" });
          }
          edits.push({ start: args[0].getStart(sf), end: args[0].getEnd(), text: spell(value) });
        } catch (e) {
          if (!compilerThrew(e)) skipped++;
          else
            left.push(
              "VALUE→THROWS  " + argSrc.replace(/\s+/g, " ").slice(0, 100) + "\n      " + e.message.slice(0, 120),
            );
        }
      }
    }
    if (method === "toMatch" && args.length === 1) {
      if (!literalSubject(subject)) {
        try {
          const value = runAt(subject.getText(sf), node);
          const lit = args[0];
          if (typeof value === "string" && !matcherAccepts(lit.getText(sf), value)) {
            edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: JSON.stringify(value) });
          }
        } catch {}
      }
    }
    if (method === "toThrow" && args.length <= 1) {
      if (ts.isArrowFunction(subject) && /\bjsmql\b/.test(subject.getText(sf))) {
        const body = subject.body.getText(sf);
        let threw = null;
        try {
          runAt(ts.isBlock(subject.body) ? "(" + subject.getText(sf) + ")()" : body, node);
        } catch (e) {
          threw = e;
        }
        if (threw !== null && !compilerThrew(threw)) {
          skipped++;
          threw = undefined;
        }
        if (threw === null) left.push("THROW→VALUE   " + body.replace(/\s+/g, " ").slice(0, 110));
        else if (threw === undefined) {
        } else if (args.length === 1) {
          const lit = args[0];
          if (!matcherAccepts(lit.getText(sf), threw.message)) {
            edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: JSON.stringify(threw.message) });
          }
        }
      }
    }
  }
  ts.forEachChild(node, visit);
};
visit(sf);
write(edits);
console.log(
  `${file}: ${edits.length} expectations regenerated, ${left.length} left for review, ${skipped} not evaluable here`,
);
for (const l of left) console.log("  " + l);
