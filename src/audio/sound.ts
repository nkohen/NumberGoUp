/**
 * Procedural sound effects via the Web Audio API.
 *
 * Everything is synthesized at runtime (no audio asset files), which keeps the
 * build tiny and the sounds tweakable in code. Browsers require audio to start
 * from a user gesture, so the context is created lazily and `resume()`d on the
 * first interaction (see `unlock`).
 *
 * The palette is intentionally soft and "bubbly": short sine/triangle blips with
 * quick exponential decays, a few pitched arpeggios for the satisfying moments
 * (placing, merging, winning).
 */

type Wave = OscillatorType;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  /** Create/resume the audio context. Call from a user gesture (pointerdown). */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** A single enveloped oscillator "blip". */
  private blip(
    freq: number,
    opts: {
      wave?: Wave;
      dur?: number;
      gain?: number;
      delay?: number;
      slideTo?: number;
      attack?: number;
    } = {},
  ): void {
    if (!this.ctx || !this.master || this.muted) return;
    const {
      wave = "sine",
      dur = 0.18,
      gain = 0.25,
      delay = 0,
      slideTo,
      attack = 0.006,
    } = opts;
    const t0 = this.now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Play a short arpeggio of notes (frequencies in Hz). */
  private arp(
    freqs: number[],
    step = 0.06,
    opts: { wave?: Wave; dur?: number; gain?: number } = {},
  ): void {
    freqs.forEach((f, i) =>
      this.blip(f, { ...opts, delay: i * step, dur: opts.dur ?? 0.16 }),
    );
  }

  // --- Named game sounds ------------------------------------------------------

  /** Picking up a card bubble. */
  pickup(): void {
    this.blip(520, { wave: "sine", dur: 0.09, gain: 0.16, slideTo: 640 });
  }

  /** Hovering a valid drop target. */
  hoverTarget(): void {
    this.blip(760, { wave: "sine", dur: 0.05, gain: 0.08 });
  }

  /** An illegal drop / rejected action. */
  error(): void {
    this.blip(180, { wave: "sawtooth", dur: 0.16, gain: 0.14, slideTo: 120 });
  }

  /** A card successfully placed — a bright pop. */
  place(): void {
    this.blip(660, { wave: "triangle", dur: 0.12, gain: 0.22, slideTo: 880 });
  }

  /**
   * An edge "sprouts" when an operation splits a value into two children.
   * A quick rising two-note chirp that sounds like a little bubble forming.
   */
  sprout(): void {
    this.blip(440, { wave: "sine", dur: 0.1, gain: 0.18, slideTo: 720 });
    this.blip(880, { wave: "sine", dur: 0.14, gain: 0.12, delay: 0.05, slideTo: 1040 });
  }

  /**
   * Two bubbles merge during evaluation. `depth` (0 = leaves) raises the pitch
   * so the final root merge lands on a satisfying high note. `value` nudges the
   * timbre so bigger numbers feel weightier.
   */
  merge(depth: number, big = false): void {
    const base = 300 + depth * 70;
    this.blip(base, { wave: big ? "triangle" : "sine", dur: 0.16, gain: 0.2, slideTo: base * 1.5 });
    if (big) this.blip(base * 2, { wave: "sine", dur: 0.12, gain: 0.1, delay: 0.02 });
  }

  /** Round cleared — a happy ascending arpeggio. */
  win(): void {
    this.arp([523.25, 659.25, 783.99, 1046.5], 0.09, {
      wave: "triangle",
      gain: 0.22,
      dur: 0.22,
    });
  }

  /** Run over — a soft descending minor figure. */
  lose(): void {
    this.arp([440, 349.23, 293.66, 220], 0.12, {
      wave: "sine",
      gain: 0.2,
      dur: 0.26,
    });
  }

  /** Purchasing / choosing an upgrade — a warm confirming chime. */
  upgrade(): void {
    this.arp([392, 587.33, 784], 0.07, { wave: "triangle", gain: 0.2, dur: 0.2 });
  }

  /** UI button click. */
  click(): void {
    this.blip(600, { wave: "square", dur: 0.04, gain: 0.08 });
  }
}

/** Shared singleton used across the app. */
export const sound = new SoundEngine();
