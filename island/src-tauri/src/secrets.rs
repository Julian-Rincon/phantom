// API keys live in the Secret Service (GNOME Keyring) / KWallet via the
// `keyring` crate's `sync-secret-service` backend — never on disk and never
// in the front end. The island can only ask whether a key is present.
//
// Service name is "phantom-island" (NOT the old "fr.louisraille.coucou" —
// Coucou's name/branding is not ours to keep, see README's attribution
// note). A machine that still has secrets under the old service name keeps
// them there, unreachable; nothing in the island needs them, the first time
// the user enters a key here it is stored fresh under the new name.

use keyring::Entry;

const SERVICE: &str = "phantom-island";

/// Every key the island may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

/// Reads a secret. A locked wallet or an unreachable Secret Service daemon
/// is treated the same as "not present" here — callers that need to tell
/// the difference use `get_checked`.
pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| wallet_error(&e))
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(wallet_error(&e)),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

/// A keyring error worth explaining to the user, rather than the raw D-Bus
/// error text. The common case on a fresh Fedora/KDE install is "no Secret
/// Service provider is running yet" (gnome-keyring-daemon / kwalletd not
/// started) or "the wallet is locked".
fn wallet_error(err: &keyring::Error) -> String {
    let text = err.to_string();
    let lower = text.to_lowercase();
    if lower.contains("no such") || lower.contains("not found") || lower.contains("no secret service") {
        "No Secret Service provider is available (GNOME Keyring / KWallet). \
         On KDE, make sure a wallet is unlocked once at login; on a fresh \
         install you may need to run `kwalletmanager5` or `seahorse` once."
            .to_string()
    } else if lower.contains("prompt dismissed") || lower.contains("locked") {
        "The system keyring is locked. Unlock it (you may be prompted) and try again.".to_string()
    } else {
        format!("Keyring error: {text}")
    }
}

/// `gh auth token` — read-only, only called when the user opted in via
/// `Settings::github_use_gh_cli` and no `github-token` secret is stored.
/// Never writes anything back to `gh`'s own config; the value is used for
/// one request and discarded, never logged.
pub fn github_token_from_gh_cli() -> Option<String> {
    let output = std::process::Command::new("gh").args(["auth", "token"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if token.is_empty() { None } else { Some(token) }
}
