/**
 * Haptic feedback via the Vibration API (`navigator.vibrate`).
 *
 * This is the tactile companion to {@link SoundEngine}: the clearing (evaluate)
 * animation buzzes the phone in time with the merge blips and lands a bigger
 * pulse on a win / a dull one on a loss.
 *
 * Support caveats — the reason this is best-effort and silently no-ops:
 *   - **iOS Safari has no Vibration API at all**, so iPhones never buzz from a
 *     web page. This is a hard platform limitation, not something we can shim.
 *   - Android Chrome/Firefox support it; a prior user gesture ("sticky
 *     activation") is required, which the card drag/drop that triggers the
 *     round's auto-resolve satisfies.
 *   - The OS/browser may still ignore it if the device has vibration disabled.
 *
 * `navigator.vibrate` throws in no browser we target, but we guard anyway so a
 * quirky embedded webview can't take down the render loop.
 */
export class Haptics {
  /** User/app switch. When false, every call is a silent no-op. */
  enabled = true;
  private readonly supported =
    typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v && this.supported) {
      try {
        navigator.vibrate(0); // cancel anything in flight
      } catch {
        /* ignore */
      }
    }
  }

  /** Whether this device can actually buzz (false on iOS / desktop). */
  get available(): boolean {
    return this.supported;
  }

  private buzz(pattern: number | number[]): void {
    if (!this.enabled || !this.supported) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }

  /**
   * One tree level collapsed during the clearing animation. `depth` (1 = first
   * level above the leaves) lengthens the pulse slightly so the buzzes build
   * toward the root merge, mirroring `SoundEngine.merge`'s rising pitch.
   */
  merge(depth: number): void {
    this.buzz(Math.min(28, 9 + depth * 4));
  }

  /** Round cleared — a short celebratory triple tap. */
  win(): void {
    this.buzz([0, 45, 35, 45, 35, 90]);
  }

  /**
   * Beat the run (cleared the final round) — a longer rolling fanfare that
   * builds to a big finish, timed to ride under the bubble-spray celebration.
   */
  victory(): void {
    this.buzz([0, 50, 40, 50, 40, 60, 40, 70, 50, 90, 60, 200]);
  }

  /** Run over — a single dull buzz. */
  lose(): void {
    this.buzz([0, 220]);
  }
}

/** Shared singleton used across the app. */
export const haptics = new Haptics();
