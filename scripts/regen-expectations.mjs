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
import ts from "typescript";
import { compilerThrew, expectCall, literalSubject, openSuite, spell } from "./expectations.mjs";

const file = process.argv[2];
const { sf, runAt, write } = openSuite(file);

/** Does the compiler decide this value — directly, or through a constant that does? */
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

/** Does the matcher already accept this message? Anything unreadable counts as a match, and stays. */
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
          // `toBe` is identity, which only a primitive can hold across a rebuild.
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
        } catch {
          /* not evaluable here */
        }
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
          /* cannot evaluate here */
        } else if (args.length === 1) {
          // keep a matcher that still matches; replace one that no longer does
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
