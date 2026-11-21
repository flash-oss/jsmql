import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const at = (rel) => new URL(rel, import.meta.url).href;
const { jsmql, ObjectId } = await import(at("../src/index.ts"));
const helpers = await import(at("../test/truthy.ts")).catch(() => ({}));

const OXFMT = fileURLToPath(new URL("../node_modules/.bin/oxfmt", import.meta.url));

export const js = (text) =>
  ts
    .transpile("(" + text + ")", { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
    .replace(/^"use strict";\s*/, "")
    .trim()
    .replace(/;\s*$/, "");

export const compilerThrew = (e) =>
  !(e instanceof ReferenceError) &&
  !(e instanceof SyntaxError) &&
  !(e instanceof TypeError && !/^jsmql/.test(e.message));

export const spell = (value) => (value === undefined ? "undefined" : jsmql.stringify(value));

export function expectCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const inner = node.expression.expression;
  if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return null;
  if (inner.expression.text !== "expect" || inner.arguments.length !== 1) return null;
  return {
    method: node.expression.name.text,
    methodName: node.expression.name,
    subject: inner.arguments[0],
    args: node.arguments,
  };
}

export const literalSubject = (s) =>
  ts.isLiteralExpression(s) ||
  s.kind === ts.SyntaxKind.TrueKeyword ||
  s.kind === ts.SyntaxKind.FalseKeyword ||
  s.kind === ts.SyntaxKind.NullKeyword ||
  ts.isArrayLiteralExpression(s) ||
  ts.isObjectLiteralExpression(s);

export function openSuite(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const bind = (into, name, text) => {
    try {
      const names = Object.keys(into);
      into[name] = new Function(...names, "return " + js(text) + ";")(...names.map((k) => into[k]));
      return true;
    } catch {
      return false;
    }
  };

  const scope = { jsmql, ObjectId, ...helpers };
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer !== undefined) bind(scope, d.name.text, d.initializer.getText(sf));
    }
  }

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

  const runAt = (text, node) => {
    const all = { ...scope, ...localScope(node) };
    const names = Object.keys(all);
    return new Function(...names, "return " + js(text) + ";")(...names.map((k) => all[k]));
  };

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
