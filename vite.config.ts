import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

/**
 * Dev-only plugin: receives gameplay events POSTed to `/__devlog` (see
 * src/dev/devlog.ts) and appends them as NDJSON to `dev-logs/`. This exists
 * only while running `vite dev`; it is never part of the production build, so
 * the game stays a pure static client-side app when shipped.
 *
 * One file is written per server start (`session-<timestamp>.ndjson`) plus a
 * stable `latest.ndjson` mirror, so the most recent play session is always at a
 * predictable path.
 */
function devLogPlugin(): Plugin {
  const dir = path.resolve(__dirname, "dev-logs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionFile = path.join(dir, `session-${stamp}.ndjson`);
  const latestFile = path.join(dir, "latest.ndjson");

  return {
    name: "ngu-devlog",
    apply: "serve",
    configureServer(server) {
      fs.mkdirSync(dir, { recursive: true });
      // Fresh latest.ndjson each server start.
      fs.writeFileSync(latestFile, "");

      server.middlewares.use("/__devlog", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            // Validate it parses; store the compact single line.
            const event = JSON.parse(body);
            const line = JSON.stringify(event) + "\n";
            fs.appendFileSync(sessionFile, line);
            fs.appendFileSync(latestFile, line);
          } catch {
            /* ignore malformed events */
          }
          res.statusCode = 204;
          res.end();
        });
      });

      server.config.logger.info(
        `  \x1b[36m➜\x1b[0m  Dev log:  dev-logs/latest.ndjson`,
      );
    },
  };
}

// Number Go Up is a pure client-side game. We use a relative base so the
// production build can be hosted from any subpath (e.g. GitHub Pages) or
// opened directly. The `test` block configures Vitest for the core logic.
export default defineConfig({
  base: "./",
  plugins: [devLogPlugin()],
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
