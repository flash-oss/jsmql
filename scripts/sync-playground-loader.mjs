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
