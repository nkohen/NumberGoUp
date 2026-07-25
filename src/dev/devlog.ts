/**
 * Dev-only gameplay logging.
 *
 * Every meaningful game action is posted as one structured event to the Vite
 * dev server's `/__devlog` endpoint (see `devLogPlugin` in vite.config.ts),
 * which appends it as a line of NDJSON to `dev-logs/session-*.ndjson`. That
 * file lives on disk so it can be read and discussed directly while we develop
 * and tune the game.
 *
 * This whole module is inert unless `import.meta.env.DEV` is true, so nothing
 * is bundled into (or phoned home from) a production build. Failures to reach
 * the endpoint are swallowed — logging must never affect gameplay.
 */

export interface DevLogEvent {
  /** Milliseconds since the page loaded (monotonic, cheap to compare). */
  t: number;
  /** Event kind, e.g. "run_start", "play", "evaluate". */
  type: string;
  /** Arbitrary structured payload for this event kind. */
  [key: string]: unknown;
}

const ENABLED = import.meta.env.DEV;
const ENDPOINT = "/__devlog";

/** A stable id for this browser session, so runs can be grouped/separated. */
const SESSION_ID = makeSessionId();

// Simple sequential queue so events land in the file in the order they fired,
// even though each POST is async.
let chain: Promise<void> = Promise.resolve();
const t0 = performance.now();

/** Record one gameplay event. No-op outside dev. */
export function devLog(type: string, data: Record<string, unknown> = {}): void {
  if (!ENABLED) return;
  const event: DevLogEvent = {
    t: Math.round(performance.now() - t0),
    session: SESSION_ID,
    type,
    ...data,
  };
  chain = chain.then(() =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true,
    })
      .then(() => undefined)
      .catch(() => undefined),
  );
}

function makeSessionId(): string {
  // Avoid Math.random dependence on any particular seed; time + counter is fine
  // for grouping. (Not used for anything security-sensitive.)
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}
