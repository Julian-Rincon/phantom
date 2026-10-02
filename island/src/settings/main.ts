// Settings window — Phantom connection status, sounds, autostart, accent,
// language, and integration keys (GitHub gets a "use gh token" toggle).

import "./settings.css";
import { Bridge, onEvent, type PhantomStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type AccentOverride, type Settings } from "../core/state";
import { ACCENTS } from "../core/accents";
import { setLang, t, type Lang } from "../core/i18n";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

// ── Phantom connection ───────────────────────────────────────────────────────

function phantomSection(status: PhantomStatus | null): HTMLElement {
  const connected = status?.connected ?? false;
  const body = h("div", { style: "display:flex;flex-direction:column;gap:10px" });
  body.append(
    h("div", {
      class: "hint",
      text: connected
        ? `Phantom Island está conectado${status?.version ? ` (v${status.version})` : ""}.`
        : "No se pudo conectar con el servidor de Phantom. Revisa que esté en ejecución.",
    }),
  );
  if (status?.agents?.length) {
    const list = h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    for (const a of status.agents) {
      list.append(
        h(
          "span",
          { class: "status-badge" },
          statusDot(a.available),
          h("span", { text: a.agentType }),
        ),
      );
    }
    body.append(list);
  }
  return h(
    "section",
    {},
    h("h2", {}, statusDot(connected), h("span", { text: t("settings.phantomConnection") })),
    body,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Elige hasta ${MAX_ACTIVE} pastillas para mostrar junto a Phantom — ${used}/${MAX_ACTIVE} en uso. Las claves se guardan en el llavero del sistema, nunca en disco.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (guardado)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Guardar" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (guardado)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    const header = h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
      sw,
      h("i", { class: "dot", style: `background:${def.color}` }),
      h("span", { style: "font-size:12.5px", text: def.name }),
    );

    list.append(h("div", { style: "display:flex;gap:12px;align-items:flex-start" }, header, rows));

    // GitHub's extra fallback toggle, right under its own row.
    if (def.id === "integration_github") {
      const ghRow = h(
        "div",
        { style: "display:flex;flex-direction:column;gap:4px;margin:2px 0 4px 0" },
        h(
          "div",
          { class: "row" },
          toggle(settings.useGhToken, (v) => { settings.useGhToken = v; void save(); }),
          h("label", { text: t("settings.ghToken") }),
        ),
        h("div", { class: "hint", style: "margin-left:0", text: t("settings.ghToken.hint") }),
      );
      list.append(ghRow);
    }
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("settings.screen.primary") }),
    h("option", { value: "cursor", text: t("settings.screen.cursor") }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const accent = h("select", {}) as HTMLSelectElement;
  accent.append(h("option", { value: "auto", text: t("settings.accent.auto") }));
  for (const id of Object.keys(ACCENTS) as AccentOverride[]) {
    if (id === "auto") continue;
    accent.append(h("option", { value: id, text: id }));
  }
  accent.value = settings.accent;
  accent.addEventListener("change", () => {
    settings.accent = accent.value as AccentOverride;
    void save();
  });

  const language = h("select", {}) as HTMLSelectElement;
  language.append(
    h("option", { value: "es", text: t("settings.language.es") }),
    h("option", { value: "en", text: t("settings.language.en") }),
  );
  language.value = settings.language;
  language.addEventListener("change", () => {
    settings.language = language.value as Lang;
    setLang(settings.language);
    void save();
    // Simplest correct behaviour for a flat i18n map on a static page: reload
    // so every already-built string (including this window's own labels)
    // re-renders in the new language.
    window.location.reload();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: t("settings.sound") }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.autoClose") }),
      autoClose,
      h("span", { class: "hint", text: t("settings.autoClose.hint") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.screen") }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.autostart") }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.accent") }),
      accent,
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.language") }),
      language,
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  setLang(settings.language);
  document.documentElement.lang = settings.language;

  const status = await Bridge.phantomStatus();

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Phantom Island" }), h("span", { class: "version", text: version })),
    phantomSection(status),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "Sin telemetría. Las peticiones de red solo van a los servicios que tú configures.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
