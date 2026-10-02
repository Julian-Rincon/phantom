// SoundEngine — every UI sound is synthesized on the fly with WebAudio, no
// files. The reference app's sounds are not licensed for reuse, and shipping
// zero audio assets is simpler anyway: nothing to bundle, nothing to lose.
//
// Each sound is a short, soft chime/click built from a couple of oscillators
// or a filtered noise burst with a hand-tuned envelope — tuned to read as
// "gentle UI feedback", never a notification ding. Default volume 0.12,
// slider range 0–0.2, same semantics the island has always used.

export const SOUND_NAMES = [
  "peek", "open", "close", "hover", "blip", "slap", "annoyed", "dizzy", "greet",
  "finish", "error", "approval", "approve", "tick", "send", "love", "rate",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

type Gen = (ctx: AudioContext, out: AudioNode, t0: number) => void;

/** A short tone: one oscillator, an exponential-ish envelope, optional pitch
 *  glide and a gentle lowpass so nothing buzzes. */
function tone(
  freq: number, duration: number, opts: {
    type?: OscillatorType; peak?: number; glideTo?: number; filterHz?: number;
  } = {},
): Gen {
  const { type = "sine", peak = 0.9, glideTo, filterHz } = opts;
  return (ctx, out, t0) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.02, duration * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

    let node: AudioNode = osc;
    if (filterHz != null) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = filterHz;
      osc.connect(f);
      node = f;
    }
    node.connect(gain);
    gain.connect(out);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  };
}

/** Two tones in quick succession — the little "up-chirp" / "down-chirp" used
 *  for open/close/approve/error. */
function chirp(f1: number, f2: number, duration: number, opts: { type?: OscillatorType; peak?: number } = {}): Gen {
  return (ctx, out, t0) => {
    tone(f1, duration * 0.55, { ...opts, glideTo: f2 })(ctx, out, t0);
  };
}

/** Filtered noise burst — soft "shh" used for annoyed/slap/dizzy accents. */
function noiseBurst(duration: number, opts: { peak?: number; filterHz?: number; type?: BiquadFilterType } = {}): Gen {
  const { peak = 0.5, filterHz = 1200, type = "bandpass" } = opts;
  return (ctx, out, t0) => {
    const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterHz;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    src.connect(f);
    f.connect(gain);
    gain.connect(out);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  };
}

/** Runs several generators back to back / overlapping, each with its own
 *  offset from the sound's start — a tiny arpeggio or a layered hit. */
function seq(...parts: [number, Gen][]): Gen {
  return (ctx, out, t0) => {
    for (const [offset, gen] of parts) gen(ctx, out, t0 + offset);
  };
}

const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5;

/** One generator per named sound, all under ~350ms and gentle on the ear. */
const SOUNDS: Record<SoundName, Gen> = {
  // A soft upward chirp — something peeking into view.
  peek: chirp(380, 620, 0.16, { type: "sine", peak: 0.7 }),
  // The island opening — a brighter, slightly longer rise.
  open: chirp(420, 760, 0.2, { type: "triangle", peak: 0.8 }),
  // Closing — the same shape, falling.
  close: chirp(640, 340, 0.18, { type: "triangle", peak: 0.7 }),
  // A faint tick — hovering the phantom.
  hover: tone(900, 0.06, { type: "sine", peak: 0.35 }),
  // UI click — very short, very quiet.
  blip: tone(700, 0.05, { type: "square", peak: 0.25, filterHz: 2200 }),
  // A soft thud — the phantom got slapped.
  slap: seq([0, noiseBurst(0.08, { peak: 0.5, filterHz: 500, type: "lowpass" })], [0, tone(160, 0.08, { type: "sine", peak: 0.5 })]),
  // A short descending "tsk" — annoyed.
  annoyed: chirp(500, 320, 0.14, { type: "sawtooth", peak: 0.35 }),
  // A wobbling pair of tones — dizzy.
  dizzy: seq([0, tone(500, 0.12, { type: "sine", glideTo: 300, peak: 0.45 })], [0.08, tone(300, 0.14, { type: "sine", glideTo: 560, peak: 0.4 })]),
  // A friendly little three-note greeting.
  greet: seq([0, tone(C5, 0.12, { peak: 0.6 })], [0.1, tone(E5, 0.12, { peak: 0.6 })], [0.2, tone(G5, 0.18, { peak: 0.65 })]),
  // The happy-jump "finished" chime — a bright major triad arpeggio.
  finish: seq([0, tone(E5, 0.14, { peak: 0.6 })], [0.08, tone(G5, 0.14, { peak: 0.6 })], [0.16, tone(C6, 0.2, { peak: 0.65 })]),
  // A soft minor-second dip — something went wrong, no alarm bells.
  error: seq([0, tone(392, 0.16, { type: "sine", peak: 0.5 })], [0.1, tone(349.23, 0.2, { type: "sine", peak: 0.45 })]),
  // Permission ping — two quick equal notes, attention without urgency.
  approval: seq([0, tone(A5, 0.1, { peak: 0.55 })], [0.1, tone(A5, 0.14, { peak: 0.55 })]),
  // Allow pressed — a clean upward resolve.
  approve: chirp(523.25, 880, 0.16, { type: "sine", peak: 0.6 }),
  // A tiny progress tick.
  tick: tone(D5, 0.04, { type: "sine", peak: 0.3 }),
  // Message sent — a short upward flick.
  send: chirp(500, 700, 0.1, { type: "sine", peak: 0.45 }),
  // Hearts — two overlapping soft high notes.
  love: seq([0, tone(E5, 0.18, { peak: 0.45 })], [0.05, tone(A5, 0.2, { peak: 0.4 })]),
  // Out of tokens — a low, slightly weary two-note fall.
  rate: seq([0, tone(330, 0.2, { type: "sine", peak: 0.4 })], [0.14, tone(262, 0.24, { type: "sine", peak: 0.35 })]),
};

class SoundEngine {
  enabled = true;
  volume = 0.12;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private loading: Promise<void> | null = null;
  private idleTimer: number | null = null;

  /** Creates the AudioContext. Kept async/memoized for symmetry with the old
   *  file-loading engine — there is nothing to decode any more. */
  preload(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.master = master;
    })();
    return this.loading;
  }

  /** WebView2/WebKit can hand us a suspended context; call after any user input. */
  resume() {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.ctx?.resume();
  }

  /** Called when the island goes quiet — suspends the context so it costs
   *  nothing while idle. `play()` resumes it on its own. */
  idle() {
    if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend();
    }, 1500);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(0.2, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  play(name: SoundName | string) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const master = this.master;
    const gen = SOUNDS[name as SoundName];
    if (!ctx || !master || !gen) return;
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (ctx.state === "suspended") void ctx.resume();
    try {
      gen(ctx, master, ctx.currentTime);
    } catch {
      /* a synthesis glitch must never break the island */
    }
  }
}

export const Sound = new SoundEngine();
