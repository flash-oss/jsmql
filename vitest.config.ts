import { defineConfig, configDefaults } from "vitest/config";

// `tmp/` is scratch: probe scripts, harvested copies of the suites, and whatever a
// running agent left there. A copy of a suite under it is not the suite.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".claude/**", "tmp/**"] } });
