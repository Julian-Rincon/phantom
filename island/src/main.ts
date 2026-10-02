// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { setLang } from "./core/i18n";
import { Island } from "./island/island";
import { registerSessionHandlers, loadInitialSessions } from "./island/sessions";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerChatHandlers } from "./island/chat";

// Surface webview errors in the island log (there is no devtools in release).
window.addEventListener("error", (e) => {
  void Bridge.log(`js error: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  void Bridge.log(`js rejection: ${String((e as PromiseRejectionEvent).reason)}`);
});

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  setLang(State.settings.language);
  document.documentElement.lang = State.settings.language;
  island.applySettings();
  State.loadIntegrationTasks();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    setLang(State.settings.language);
    document.documentElement.lang = State.settings.language;
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerSessionHandlers(island);
  registerIntegrationHandlers(island);
  registerChatHandlers();
  void loadInitialSessions();

  // Phantom connection status, polled lazily — a websocket-pushed event would
  // be nicer, but the contract only promises a pull command, and settings is
  // the only place that currently renders it besides the small island badge.
  const pollPhantomStatus = async () => {
    const status = await Bridge.phantomStatus();
    State.phantomConnected = status?.connected ?? false;
    State.notify();
  };
  void pollPhantomStatus();
  window.setInterval(() => void pollPhantomStatus(), 15_000);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
