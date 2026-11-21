import ts from "typescript";
import { compilerThrew, expectCall, literalSubject, openSuite, spell } from "./expectations.mjs";

const [file, ...keepPatterns] = process.argv.slice(2);
const KEEP = keepPatterns.map((p) => new RegExp(p));
const { sf, runAt, write } = openSuite(file);

const edits = [];
const kept = [];

const visit = (node) => {
  const call = expectCall(node);
  if (call !== null) {
    const { method, subject, args } = call;
    if ((method === "toEqual" || method === "toStrictEqual" || method === "toBe") && args.length === 1) {
      const argSrc = subject.getText(sf);
      if (!literalSubject(subject)) {
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
    if (method === "toThrow") {
      if (ts.isArrowFunction(subject) && /\bjsmql\b/.test(subject.getText(sf)) && !ts.isBlock(subject.body)) {
        const body = subject.body.getText(sf);
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
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `expect(${body}).toEqual(${spell(value)})` });
      }
    }
  }
  ts.forEachChild(node, visit);
};
visit(sf);
write(edits);
console.log(`${file}: ${edits.length} converted, ${kept.length} kept as refusals`);
for (const k of kept) console.log("  kept: " + k);
