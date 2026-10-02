// Dev harness: a real `Island` instance, driven by buttons instead of a live
// Tauri backend. `IS_TAURI` is false in a plain browser, so every `Bridge.*`
// call is already a safe no-op — this file only needs to poke `State` and a
// few dev-only hooks on `Island` (see island.ts "Dev-harness hooks") to reach
// every expression and view without a native window.

import "../src/style.css";
import { Island } from "../src/island/island";
import { State } from "../src/core/state";
import { Sound } from "../src/core/sound";
import { accentHex } from "../src/core/accents";
import { setLang } from "../src/core/i18n";
import { chatReducer } from "../src/core/chatReducer";

const root = document.getElementById("root")!;
const buttonsEl = document.getElementById("buttons")!;
const logEl = document.getElementById("log")!;

function log(msg: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n${logEl.textContent}`.slice(0, 4000);
}

setLang("es");
void Sound.preload();
const island = new Island(root);
island.applySettings();
State.loadIntegrationTasks();

document.addEventListener(
  "click",
  () => Sound.resume(),
  { once: true },
);

// ── Fake session data ────────────────────────────────────────────────────────

let nextChatId = 1;
const CLAUDE_STEPS = [
  "Leyendo src/app.ts",
  "Ejecutando npm test",
  "Editando src/components/Button.tsx",
  "Buscando referencias a `useAuth`",
];

function seedSessions() {
  const claude = State.upsertSession("demo-claude", "claude_code", accentHex("claude"), {
    model: "claude-sonnet-5", folder: "/home/dev/proyectos/acme-web", conversationId: 1,
  });
  for (const step of CLAUDE_STEPS) State.appendStep(claude.id, step);
  State.updateTask(claude.id, "working");

  const hermes = State.upsertSession("demo-hermes", "hermes", accentHex("hermes"), {
    model: "hermes-3", folder: "/home/dev/proyectos/hermes-bot", conversationId: 2,
  });
  State.appendStep(hermes.id, "Procesando mensaje de Telegram");
  State.updateTask(hermes.id, "thinking");

  const opencode = State.upsertSession("demo-opencode", "open_code", accentHex("general"), {
    model: "gpt-4o", folder: "/home/dev/proyectos/landing", conversationId: 3,
  });
  State.appendStep(opencode.id, "Generando componente Hero");
  State.updateTask(opencode.id, "finished");

  State.setFocus(claude.id);
  island.reveal();
  island.setView("overview");
  log("3 sesiones simuladas: Claude Code, Hermes, OpenCode");
}

function triggerPermission() {
  seedSessions();
  State.pendingApproval = {
    connectionId: "demo-claude",
    requestId: "req-1",
    agentType: "claude_code",
    toolCallLabel: "Bash · npm run db:migrate --force",
    options: [
      { optionId: "allow_once", name: "Permitir", kind: "allow_once" },
      { optionId: "reject_once", name: "Denegar", kind: "reject_once" },
    ],
  };
  State.isPinned = true;
  island.alert("approval");
  log("Permiso pendiente: Bash · npm run db:migrate --force");
}

function triggerLimit() {
  seedSessions();
  State.pendingLimit = {
    agent: "Claude Opus 5",
    resetHint: "5am",
    successor: { agent: "Claude Sonnet 5", model: "claude-sonnet-5", reason: "más rápido y ya disponible" },
    runnerUp: { agent: "OpenCode", model: "gpt-4o", reason: "segunda mejor opción medida" },
    conversationId: 1,
  };
  island.alert("limit");
  log("Límite de tokens simulado para Claude Opus 5");
}

function triggerChat() {
  State.chatHistory = [];
  island.alert("prompt");
  const userId = nextChatId++;
  State.chatHistory = chatReducer(State.chatHistory, { type: "user", id: userId, content: "¿Qué cambió en el último commit?" });
  const assistantId = nextChatId++;
  State.stateOverride = "thinking";
  State.notify();
  const full = "Cambiaste el manejo de sesiones para usar conexiones de Phantom en vez de los hooks de Claude Code. También añadí la tarjeta de límite de tokens.";
  let i = 0;
  const timer = window.setInterval(() => {
    i += 3;
    State.chatHistory = chatReducer(State.chatHistory, {
      type: "delta", id: assistantId, textDelta: full.slice(Math.max(0, i - 3), i),
    });
    State.notify();
    if (i >= full.length) {
      window.clearInterval(timer);
      State.chatHistory = chatReducer(State.chatHistory, {
        type: "done", id: assistantId, agent: "Claude", model: "claude-sonnet-5",
      });
      State.stateOverride = null;
      Sound.play("finish");
      State.notify();
    }
  }, 40);
  log("Chat simulado con respuesta en streaming");
}

let voiceTimer: number | null = null;
function toggleVoiceDemo() {
  if (voiceTimer != null) {
    window.clearInterval(voiceTimer);
    voiceTimer = null;
    State.voiceActive = false;
    State.voiceLevel = 0;
    State.voiceSpeaking = false;
    State.notify();
    log("Modo voz (simulado) detenido");
    return;
  }
  island.alert("prompt");
  State.voiceActive = true;
  let t = 0;
  voiceTimer = window.setInterval(() => {
    t += 0.1;
    State.voiceLevel = Math.max(0, Math.sin(t * 3) * 0.6 + 0.4);
    State.voiceSpeaking = Math.floor(t) % 4 === 3;
    State.notify();
  }, 60);
  log("Modo voz (simulado): el brillo del fantasma reacciona al nivel de entrada");
}

const actions: { label: string; run: () => void }[] = [
  { label: "Inactivo", run: () => { island.collapse(); log("Isla colapsada (inactivo)"); } },
  { label: "Asomarse (greet)", run: () => { island.launch(); log("Reproduciendo el saludo de lanzamiento"); } },
  { label: "Sesiones", run: seedSessions },
  { label: "Permiso pendiente", run: triggerPermission },
  { label: "Sin tokens (límite)", run: triggerLimit },
  { label: "Chat", run: triggerChat },
  { label: "Voz (simulada)", run: toggleVoiceDemo },
  {
    label: "Voz (micrófono real)",
    run: () => {
      import("../src/voice/controller").then(({ startVoice, stopVoice }) => {
        if (State.voiceActive) { stopVoice(); log("Micrófono detenido"); return; }
        island.alert("prompt");
        startVoice((text) => log(`Transcrito: "${text}"`)).then(
          () => log("Micrófono activo — habla para ver el VAD"),
          (err) => log(`Permiso de micrófono denegado: ${err}`),
        );
      });
    },
  },
  { label: "Soltar archivo", run: () => { island.devSimulateDrop("demo/informe-q3.pdf"); log("Simulando la secuencia de arrastrar y soltar"); } },
  { label: "Mareado (3 clics)", run: () => { island.devTriggerDizzy(); log("3 clics rápidos → mareado"); } },
  { label: "Corazones", run: () => { island.devTriggerLove(); log("Corazones flotando"); } },
];

for (const a of actions) {
  const btn = document.createElement("button");
  btn.className = "trigger";
  btn.textContent = a.label;
  btn.addEventListener("click", a.run);
  buttonsEl.append(btn);
}

island.launch();
log("Arnés listo.");
