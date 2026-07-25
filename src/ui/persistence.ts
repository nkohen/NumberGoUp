/**
 * Save/load for a static, browser-only game.
 *
 * Two complementary layers, so it "just works" everywhere and is also durable:
 *
 *  1. **localStorage autosave** — after every meaningful action we stash the
 *     full run under one key. This powers the title screen's "Continue" button
 *     and survives refreshes/tab-closes with zero prompts. Always available.
 *
 *  2. **A real save file** — the player can bind a `.ngu.json` file once (via the
 *     File System Access API, on Chromium). From then on autosave ALSO writes to
 *     that file, so the run is backed up outside the browser cache and is
 *     portable between machines. Browsers without that API (Firefox/Safari/iOS)
 *     fall back to a one-off download for saving and a file picker for loading;
 *     localStorage autosave still gives them seamless "Continue".
 *
 * The payload is a versioned {@link SaveData} wrapping a {@link GameSnapshot}.
 */
import type { GameSnapshot } from "../core/game";

/** Bump when the snapshot shape changes incompatibly; older saves are rejected. */
export const SAVE_VERSION = 1;

/** localStorage key holding the most recent autosave. */
const LOCAL_KEY = "ngu.save";

/** Default filename offered when the player saves to a file. */
export const SAVE_FILENAME = "number-go-up.ngu.json";

/** The on-disk / on-storage payload: a snapshot plus a little metadata. */
export interface SaveData {
  /** Format version (see {@link SAVE_VERSION}). */
  v: number;
  /** Save time (ms since epoch) — shown as "saved 5m ago" style hints. */
  ts: number;
  /** The serialized run. */
  game: GameSnapshot;
}

/** Wrap a snapshot as a versioned, timestamped save payload. */
export function makeSave(game: GameSnapshot): SaveData {
  return { v: SAVE_VERSION, ts: Date.now(), game };
}

/** True if `d` looks like a save of a version we can load. */
function isValidSave(d: unknown): d is SaveData {
  if (!d || typeof d !== "object") return false;
  const s = d as Partial<SaveData>;
  return s.v === SAVE_VERSION && !!s.game && typeof s.game === "object";
}

// --- localStorage autosave ---------------------------------------------------

export function saveLocal(data: SaveData): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
  } catch {
    /* storage full / disabled — nothing we can do, file save still works */
  }
}

export function loadLocal(): SaveData | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return isValidSave(data) ? data : null;
  } catch {
    return null;
  }
}

export function hasLocalSave(): boolean {
  return loadLocal() !== null;
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}

// --- File System Access API (Chromium) --------------------------------------
// Minimal typings — these aren't in the default TS DOM lib. Everything is
// feature-detected at runtime, so non-supporting browsers never touch them.

interface FSWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FSFileHandle {
  readonly name: string;
  createWritable(): Promise<FSWritable>;
  getFile(): Promise<File>;
}
interface SaveFilePickerOpts {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type WinWithFS = Window & {
  showSaveFilePicker?: (o?: SaveFilePickerOpts) => Promise<FSFileHandle>;
  showOpenFilePicker?: (o?: SaveFilePickerOpts & { multiple?: boolean }) => Promise<FSFileHandle[]>;
};

/** Whether the browser can bind a file we auto-save to (Chromium desktop). */
export function canBindFile(): boolean {
  return typeof window !== "undefined" && typeof (window as WinWithFS).showSaveFilePicker === "function";
}

// NB: the File System Access picker rejects multi-dot extensions like
// ".ngu.json" (throws "contains invalid characters"), so the accept filter uses
// the plain ".json" our filenames end in. The <input> fallback is more lenient.
const FILE_TYPES = [{ description: "Number Go Up save", accept: { "application/json": [".json"] } }];

/** The bound save-file handle, kept in memory for the session once chosen. */
let boundHandle: FSFileHandle | null = null;

export function hasBoundFile(): boolean {
  return boundHandle !== null;
}

export function boundFileName(): string | null {
  return boundHandle?.name ?? null;
}

/**
 * Prompt for a file to save into and bind it for future autosaves. Writes the
 * given data immediately. Returns true if a file was chosen. (Chromium only —
 * guard with {@link canBindFile}.)
 */
export async function bindAndSaveFile(data: SaveData): Promise<boolean> {
  const w = window as WinWithFS;
  if (!w.showSaveFilePicker) return false;
  try {
    const handle = await w.showSaveFilePicker({ suggestedName: SAVE_FILENAME, types: FILE_TYPES });
    boundHandle = handle;
    await writeBoundFile(data);
    return true;
  } catch {
    // User cancelled the picker, or permission denied.
    return false;
  }
}

/** Write to the currently bound file, if any. Best-effort; errors are swallowed. */
export async function writeBoundFile(data: SaveData): Promise<void> {
  if (!boundHandle) return;
  try {
    const writable = await boundHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  } catch {
    /* file went away or permission lapsed — autosave-to-local still holds */
  }
}

/**
 * "Delete" the bound save by emptying it (a payload with no run), then unbind.
 * Called when a run ends so a lost run can't be resurrected by re-loading the
 * file. The file itself can't be removed via this API, but an empty payload
 * fails validation on load, so it reads as "no save".
 */
export async function clearBoundFile(): Promise<void> {
  if (!boundHandle) return;
  try {
    const writable = await boundHandle.createWritable();
    await writable.write(JSON.stringify({ v: SAVE_VERSION, ts: Date.now(), game: null }));
    await writable.close();
  } catch {
    /* best-effort */
  }
  boundHandle = null;
}

// --- Fallback download / upload (all browsers) ------------------------------

/** Trigger a plain download of the save file (fallback when no file binding). */
export function downloadSave(data: SaveData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = SAVE_FILENAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Outcome of a load attempt — distinguishes a real failure from a cancel. */
export type LoadResult =
  | { data: SaveData }
  | { data: null; cancelled: boolean };

/**
 * Let the player choose a save file to load. Uses the File System Access open
 * picker when available (and binds the chosen file for future autosaves),
 * otherwise a hidden <input type=file>. Returns the parsed save, or a null
 * result flagged `cancelled` when the user just dismissed the picker (so the UI
 * can stay quiet) vs. a genuine bad/empty file (so it can warn).
 *
 * IMPORTANT: this must be invoked synchronously from the click handler — the
 * picker call has to happen inside the user gesture, or the first attempt is
 * rejected (the "have to tap twice" bug).
 */
export async function openSaveFile(): Promise<LoadResult> {
  const w = window as WinWithFS;
  if (w.showOpenFilePicker) {
    let handle: FSFileHandle;
    try {
      [handle] = await w.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    } catch {
      return { data: null, cancelled: true }; // user dismissed the picker
    }
    try {
      const file = await handle.getFile();
      const data = JSON.parse(await file.text());
      if (!isValidSave(data)) return { data: null, cancelled: false };
      boundHandle = handle; // continue auto-saving to the file we just loaded
      return { data };
    } catch {
      return { data: null, cancelled: false }; // unreadable / not JSON
    }
  }
  // Fallback: a hidden file input. It must be attached to the DOM for the
  // change event to fire reliably in some browsers (Safari), which is another
  // cause of the "first tap does nothing" symptom.
  return new Promise<LoadResult>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.ngu.json,application/json";
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (r: LoadResult) => {
      input.remove();
      resolve(r);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return done({ data: null, cancelled: true });
      try {
        const data = JSON.parse(await file.text());
        done(isValidSave(data) ? { data } : { data: null, cancelled: false });
      } catch {
        done({ data: null, cancelled: false });
      }
    };
    input.oncancel = () => done({ data: null, cancelled: true });
    input.click();
  });
}
