import { defineConfig } from "vitest/config";

// Vitest runs only the TypeScript suites under test/. A copy of a suite is not the
// suite. Examples are a type-stripped `.js` twin, a file under tmp/ and a file in
// another worktree under .claude/. The pattern starts at the root, so it matches none
// of them.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
