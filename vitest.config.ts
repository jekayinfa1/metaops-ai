import { defineConfig } from "vitest/config";

// node:sqlite is a Node >=22 builtin that Vite's resolver does not know;
// keep it external so the test workers load it from Node itself.
const nodeSqliteExternal = {
  name: "node-sqlite-external",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (id === "node:sqlite" || id === "sqlite") return { id: "node:sqlite", external: true };
    return null;
  }
};

export default defineConfig({
  plugins: [nodeSqliteExternal],
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000, pool: "forks" }
});
