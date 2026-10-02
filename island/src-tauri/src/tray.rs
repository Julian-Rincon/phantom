// Notification-area icon: Open, Settings, Pause, Quit.
//
// Uses Tauri's `tray-icon` feature, which on Linux renders through
// libayatana-appindicator3 (StatusNotifierItem) — present on Plasma 6 via
// the `libappindicator-gtk3` package the install step depends on.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir Phantom Island", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Configuración…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pausar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &sep1, &settings, &pause, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("phantom-island")
        .tooltip("Phantom Island")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
