import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees under .claude/ hold full repo copies; without this their
// tests are collected too and inflate the count (3505 vs ~924).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
