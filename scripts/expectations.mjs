// The shared code for `regen-expectations.mjs` and `convert-expectations.mjs`: read a suite
// file as a TypeScript AST, evaluate an expression in the scope that the file itself builds,
// and write a value back as the source a reviewer reads in the difference.
//
// Neither script runs on a hook. Both are invoked by hand. See scripts/CLAUDE.md.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const at = (rel) => new URL(rel, import.meta.url).href;
const { jsmql, ObjectId } = await import(at("../src/index.ts"));
const helpers = await import(at("../test/truthy.ts")).catch(() => ({}));

const OXFMT = fileURLToPath(new URL("../node_modules/.bin/oxfmt", import.meta.url));

/** A TypeScript expression as the JavaScript that evaluates it. */
export const js = (text) =>
  ts
    .transpile("(" + text + ")", { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
    .replace(/^"use strict";\s*/, "")
    .trim()
    .replace(/;\s*$/, "");

/**
 * Did the COMPILER refuse this, or did the evaluation fail for its own reasons? A
 * ReferenceError, a SyntaxError, or a TypeError (not from jsmql) means the harness could not
 * build the call at all. None of these three is an answer about the language, so the
 * expectation they come from stays unchanged.
 */
export const compilerThrew = (e) =>
  !(e instanceof ReferenceError) &&
  !(e instanceof SyntaxError) &&
  !(e instanceof TypeError && !/^jsmql/.test(e.message));

/**
 * A value as the source that rebuilds it, through the library's own printer. One
 * spelling of a Date, an ObjectId, or a Binary reads the same in a suite, in the docs,
 * and in the terminal. The layout is the formatter's business, not the printer's.
 * The `write` function below hands the whole file to `oxfmt`.
 *
 * `undefined` is the one value the printer refuses that a suite may still assert:
 * `expect(doc.let).toEqual(undefined)` states that a key is absent.
 */
export const spell = (value) => (value === undefined ? "undefined" : jsmql.stringify(value));

/** `expect(<subject>).<method>(<args>)`, or null for every other call. */
export function expectCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const inner = node.expression.expression;
  if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return null;
  if (inner.expression.text !== "expect" || inner.arguments.length !== 1) return null;
  return {
    method: node.expression.name.text,
    /** The `toEqual` / `toThrow` token itself — `toBe` is rewritten in place. */
    methodName: node.expression.name,
    subject: inner.arguments[0],
    args: node.arguments,
  };
}

/** A subject that is already a literal states its own value; the compiler has no say in it. */
export const literalSubject = (s) =>
  ts.isLiteralExpression(s) ||
  s.kind === ts.SyntaxKind.TrueKeyword ||
  s.kind === ts.SyntaxKind.FalseKeyword ||
  s.kind === ts.SyntaxKind.NullKeyword ||
  ts.isArrayLiteralExpression(s) ||
  ts.isObjectLiteralExpression(s);

/** One suite file, read as an AST and ready to rewrite. */
export function openSuite(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** Bind one declaration's initialiser against the names already in `into`. */
  const bind = (into, name, text) => {
    try {
      const names = Object.keys(into);
      into[name] = new Function(...names, "return " + js(text) + ";")(...names.map((k) => into[k]));
      return true;
    } catch {
      return false; // needs the module it lives in — it stays out of scope
    }
  };

  // The file's own top-level constants, in order: a literal, a helper arrow, a table.
  const scope = { jsmql, ObjectId, ...helpers };
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer !== undefined) bind(scope, d.name.text, d.initializer.getText(sf));
    }
  }

  /** The constants declared above `node` in every block that encloses it. */
  const localScope = (node) => {
    const extra = {};
    const chain = [];
    for (let p = node.parent; p; p = p.parent) if (ts.isBlock(p) || ts.isSourceFile(p)) chain.unshift(p);
    for (const blk of chain) {
      for (const st of blk.statements) {
        if (st.getStart(sf) >= node.getStart(sf) || !ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
          const all = { ...scope, ...extra };
          if (bind(all, d.name.text, d.initializer.getText(sf))) extra[d.name.text] = all[d.name.text];
        }
      }
    }
    return extra;
  };

  /** Evaluate `text` where the suite evaluates it: at `node`, with `node`'s names in scope. */
  const runAt = (text, node) => {
    const all = { ...scope, ...localScope(node) };
    const names = Object.keys(all);
    return new Function(...names, "return " + js(text) + ";")(...names.map((k) => all[k]));
  };

  /**
   * Apply the edits (given in any order, never overlapping). Write the file and
   * format it. The formatter owns the layout, so the difference a reviewer reads holds
   * the answers that changed, with no re-wrapped line that did not change.
   */
  const write = (edits) => {
    let out = src;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    writeFileSync(file, out);
    const formatted = spawnSync(OXFMT, [file], { encoding: "utf8" });
    if (formatted.status !== 0) {
      console.error(`oxfmt failed on ${file}: ${formatted.stderr || formatted.error?.message}`);
    }
  };

  return { src, sf, runAt, write };
}
