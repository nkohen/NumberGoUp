import { defineConfig } from "vite";

// Number Go Up is a pure client-side game. We use a relative base so the
// production build can be hosted from any subpath (e.g. GitHub Pages) or
// opened directly. The `test` block configures Vitest for the core logic.
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    outDir: "dist",
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
