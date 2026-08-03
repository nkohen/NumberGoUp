import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
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
  plugins: [
    devLogPlugin(),
    // Installable, offline-capable PWA. `registerType: "prompt"` means a new
    // deploy does NOT silently swap under the player — instead the app surfaces
    // an explicit "update available" prompt (see src/pwa.ts) and only reloads
    // when they accept. The service worker precaches the built bundle, and the
    // Google Fonts (Baloo 2) are runtime-cached so the app keeps its look
    // offline after the first online launch.
    VitePWA({
      registerType: "prompt",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Number Go Up",
        short_name: "NGU",
        description:
          "A minimalist roguelike deck-building game. Build an arithmetic tree, make the number go up.",
        theme_color: "#0b1026",
        background_color: "#0b1026",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: "es2020",
    outDir: "dist",
    // `sandbox.html` (the interaction-combinator toy) and `play.html` (the
    // "clear the net" demo built on it) are dev-only, in src/inet/. They are
    // deliberately NOT part of the shipped game: `vite dev` already serves any
    // HTML file in the project root, so it is reachable at /sandbox.html with no
    // configuration, and leaving it out of the build keeps it off the PWA
    // precache. Set INET_SANDBOX=1 to emit it as a second input when you want a
    // static copy to host.
    rollupOptions: process.env.INET_SANDBOX
      ? { input: { main: "index.html", sandbox: "sandbox.html", play: "play.html" } }
      : {},
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
