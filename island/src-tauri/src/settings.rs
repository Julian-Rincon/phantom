// Preferences, stored as plain JSON under XDG_CONFIG_HOME/phantom-island.
// No secret ever lands here — API keys live in the Secret Service / KWallet
// (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    /// Kept for settings.json forward/backward compatibility with the old
    /// Windows build; always false on Linux, there is no hook relay to install.
    #[serde(default)]
    pub hooks_installed: bool,
    /// Phantom chat model is chosen by Phantom's own routing, not here — kept
    /// only so an old settings.json round-trips instead of failing to parse.
    #[serde(default = "default_model")]
    pub model: String,
    /// Persisted "Phantom Island" chat conversation id, once one exists.
    #[serde(default)]
    pub chat_conversation_id: Option<i32>,
    /// Read a GitHub token from `gh auth token` when no secret is stored.
    /// The front end calls it `useGhToken`.
    #[serde(default = "yes", rename = "useGhToken", alias = "githubUseGhCli")]
    pub github_use_gh_cli: bool,
    /// Accent override ("auto" follows the active model).
    #[serde(default = "default_accent")]
    pub accent: String,
    /// UI language ("es" | "en").
    #[serde(default = "default_language")]
    pub language: String,
    /// Bumped when defaults change in a way old files should pick up.
    #[serde(default)]
    pub settings_version: u32,
}

/// Current defaults generation (see `migrate`).
pub const SETTINGS_VERSION: u32 = 2;

fn yes() -> bool {
    true
}

fn default_accent() -> String {
    "auto".to_string()
}

fn default_language() -> String {
    "es".to_string()
}

/// The island shows what Phantom actually uses: its agents, plus GitHub.
/// Version 1 files still carry the old default pill set (Resend, n8n,
/// Vercel, GitHub) the user never chose, so they are moved to the new one.
pub fn migrate(mut s: Settings) -> Settings {
    if s.settings_version < 2 {
        s.active_integrations = vec!["integration_github".into()];
        s.github_use_gh_cli = true;
        s.settings_version = SETTINGS_VERSION;
    }
    s
}

fn default_model() -> String {
    "claude-sonnet-5".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec!["integration_github".into()],
            screen: "primary".into(),
            autostart: true,
            hooks_installed: false,
            model: default_model(),
            chat_conversation_id: None,
            github_use_gh_cli: true,
            accent: default_accent(),
            language: default_language(),
            settings_version: SETTINGS_VERSION,
        }
    }
}

/// `$XDG_CONFIG_HOME/phantom-island`, falling back to `~/.config/phantom-island`.
pub fn config_dir() -> PathBuf {
    base_dir("XDG_CONFIG_HOME", ".config")
}

/// `$XDG_DATA_HOME/phantom-island` — the inbox and other app-owned data that
/// isn't just preferences. Falls back to `~/.local/share/phantom-island`.
pub fn data_dir() -> PathBuf {
    base_dir("XDG_DATA_HOME", ".local/share")
}

/// `$XDG_STATE_HOME/phantom-island` — the log file. Falls back to
/// `~/.local/state/phantom-island`.
pub fn state_dir() -> PathBuf {
    base_dir("XDG_STATE_HOME", ".local/state")
}

fn base_dir(env_var: &str, fallback_rel: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os(env_var) {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("phantom-island");
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(fallback_rel).join("phantom-island")
}

/// Kept for symmetry with the old Windows `local_dir()` callers (files.rs,
/// log.rs) — on Linux this is just the data dir.
pub fn local_dir() -> PathBuf {
    data_dir()
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => {
            let stored: Settings = serde_json::from_slice(&bytes).unwrap_or_default();
            let before = stored.settings_version;
            let migrated = migrate(stored);
            if migrated.settings_version != before {
                let _ = save(&migrated);
            }
            migrated
        }
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

/// `~/.config/codeg/server.env` — where codeg-server writes `CODEG_TOKEN=`
/// and `CODEG_HOST=`/`CODEG_PORT=` for local clients to read. Shared across
/// the whole Phantom workspace, not under phantom-island's own config dir.
pub fn codeg_server_env_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".config").join("codeg").join("server.env")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_files_move_to_the_phantom_defaults_once() {
        let old = r#"{"soundEnabled":true,"soundVolume":0.12,"autoCloseInterval":15,
            "absenceInterval":180,"activeIntegrations":["integration_resend","integration_n8n"],
            "screen":"primary","autostart":false,"githubUseGhCli":false}"#;
        let parsed: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(parsed.accent, "auto");
        assert_eq!(parsed.language, "es");
        let migrated = migrate(parsed);
        assert_eq!(migrated.active_integrations, vec!["integration_github".to_string()]);
        assert!(migrated.github_use_gh_cli);
        assert_eq!(migrated.settings_version, SETTINGS_VERSION);

        // A later explicit choice survives another migrate pass.
        let mut chosen = migrated.clone();
        chosen.active_integrations = vec![];
        assert!(migrate(chosen).active_integrations.is_empty());
    }

    #[test]
    fn front_end_field_names_round_trip() {
        let s: Settings = serde_json::from_str(
            r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,"absenceInterval":180,
                "activeIntegrations":[],"screen":"primary","autostart":true,
                "useGhToken":false,"accent":"claude","language":"en"}"#,
        )
        .unwrap();
        assert!(!s.github_use_gh_cli);
        assert_eq!(s.accent, "claude");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["useGhToken"], false);
        assert_eq!(v["language"], "en");
    }
}
