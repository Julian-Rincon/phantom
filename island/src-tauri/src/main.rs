// Phantom Island runs without a console window on a release build; the
// island itself is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Native Wayland + layer-shell is the default on Plasma (see
    // `island::init_layer_shell`); PHANTOM_ISLAND_X11=1 forces the old
    // XWayland path for compositors without layer-shell. Must run before GTK
    // initialises, so it is the very first thing in `main`.
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("PHANTOM_ISLAND_X11").is_some()
    {
        // Safety: called before any GTK/webkit/winit initialisation, from the
        // single thread `main()` runs on — no other thread can be racing a
        // read of the environment yet.
        unsafe {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    phantom_island_lib::run()
}
