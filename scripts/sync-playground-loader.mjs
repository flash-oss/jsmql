// Node ESM loader hook used by `sync-playground.mjs`. Resolves the
// `"vitest"` bare specifier to `sync-playground-vitest-shim.mjs` so loading
// `test/realistic.test.ts` discovers every `describe()` / `it()` without
// actually booting vitest. All other specifiers fall through to Node's
// default resolution.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_URL = pathToFileURL(path.resolve(HERE, "sync-playground-vitest-shim.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vitest") {
    return { url: SHIM_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
