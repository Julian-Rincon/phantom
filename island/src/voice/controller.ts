// Voice ("Live") mode glue: mic capture + VAD → `voice_stt`, and a small TTS
// queue → `voice_tts` with barge-in. DOM/WebAudio heavy on purpose — the pure
// logic it drives (`vad.ts`) is unit tested separately.

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { getLang } from "../core/i18n";
import { computeRms, createInitialVadState, stepVad, type VadState } from "./vad";
import { shouldSendUtterance } from "./utterance-filter";

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let vadState: VadState = createInitialVadState();
let rafId: number | null = null;
let onUtterance: ((text: string) => void) | null = null;

const MIME = "audio/webm;codecs=opus";

function pickMime(): string {
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(MIME)) return MIME;
  return "audio/webm";
}

async function blobToBytes(blob: Blob): Promise<number[]> {
  const buf = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buf));
}

function tick() {
  rafId = requestAnimationFrame(tick);
  if (!analyser) return;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  const rms = computeRms(buf);
  State.voiceLevel = Math.min(1, rms * 8);

  const { state, event } = stepVad(vadState, rms, performance.now());
  vadState = state;
  if (!event) return;

  if (event.type === "speech-start") {
    stopSpeaking(); // barge-in: cut off whatever Phantom was saying
    chunks = [];
    recorder?.start();
  } else if (event.type === "speech-end" || event.type === "speech-rejected") {
    recorder?.stop();
  }
}

/** Starts continuous mic listening. Resolves once permission is granted and
 *  capture is live; rejects (caller should hide the voice UI) otherwise. */
export async function startVoice(handler: (text: string) => void): Promise<void> {
  try {
    await openCapture(handler);
  } catch (err) {
    stopVoice(); // release whatever was opened before the failure
    throw err;
  }
}

async function openCapture(handler: (text: string) => void): Promise<void> {
  onUtterance = handler;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("este WebView no expone el micrófono (mediaDevices)");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("este WebView no soporta MediaRecorder");
  }
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  audioCtx = new Ctor();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const mime = pickMime();
  recorder = new MediaRecorder(stream, { mimeType: mime });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    if (blob.size < 512) return; // too short to be real speech
    void (async () => {
      try {
        const bytes = await blobToBytes(blob);
        const result = await Bridge.voiceStt(bytes, mime);
        const text = result.text.trim();
        const real = shouldSendUtterance({
          text,
          language: result.language ?? "",
          durationMs: result.duration_ms ?? 0,
          agentBusy: State.stateOverride === "thinking" || speaking,
          expectedLang: getLang() === "es" ? "es" : "en",
        });
        if (real) onUtterance?.(text);
        else if (text) void Bridge.log(`voice: ignored noise "${text.slice(0, 40)}"`);
      } catch (err) {
        void Bridge.log(`voice: transcription failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  vadState = createInitialVadState();
  State.voiceActive = true;
  State.notify();
  tick();
}

export function stopVoice() {
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
  recorder?.stop();
  recorder = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void audioCtx?.close();
  audioCtx = null;
  analyser = null;
  onUtterance = null;
  State.voiceActive = false;
  State.voiceLevel = 0;
  stopSpeaking();
  State.notify();
}

// ── TTS queue with barge-in ──────────────────────────────────────────────────

let speakQueue: string[] = [];
let currentAudio: HTMLAudioElement | null = null;
let speaking = false;

async function drainQueue() {
  if (speaking) return;
  const next = speakQueue.shift();
  if (!next) {
    State.voiceSpeaking = false;
    State.notify();
    return;
  }
  speaking = true;
  State.voiceSpeaking = true;
  State.notify();
  try {
    const { wavBase64 } = await Bridge.voiceTts(next, getLang());
    const audio = new Audio(`data:audio/wav;base64,${wavBase64}`);
    currentAudio = audio;
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
    });
  } catch (err) {
    void Bridge.log(`voice: speech failed — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    currentAudio = null;
    speaking = false;
    void drainQueue();
  }
}

export async function speakSentence(text: string): Promise<void> {
  if (!text.trim()) return;
  speakQueue.push(text.trim());
  void drainQueue();
}

/** Barge-in: stop whatever is currently playing and drop the rest of the queue. */
export function stopSpeaking() {
  speakQueue = [];
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  speaking = false;
  State.voiceSpeaking = false;
}
