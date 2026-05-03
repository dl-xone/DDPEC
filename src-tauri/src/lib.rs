// DDPEC native shell. Wires:
//   - The main DDPEC editor window (full HID + audio path)
//   - A menubar tray icon that toggles a compact dropdown window
//   - Auto-start at login via tauri-plugin-autostart
//
// Audio capture and DSP all happen in the webview (Web Audio API talking
// to BlackHole as a regular input device). The Rust side is just a
// system-tray host + window manager + auto-start bridge.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Cmd+Shift+E toggles System EQ from anywhere on the Mac. We dispatch
    // the same engage/disengage events the dropdown emits so the main
    // webview's existing handler does the work — Rust just routes the
    // hotkey to the currently active state.
    let toggle_shortcut = Shortcut::new(
        Some(Modifiers::SUPER | Modifiers::SHIFT),
        Code::KeyE,
    );

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::AppleScript,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(toggle_shortcut)
                .expect("DDPEC: failed to register System EQ toggle shortcut")
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &toggle_shortcut {
                        if let Some(main) = app.get_webview_window("main") {
                            // The webview keeps its own truth about engagement.
                            // We emit a "toggle" command and let it figure out
                            // engage vs disengage based on current state.
                            let _ = main.emit("ddpec:cmd:toggle", ());
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            setup_tray(&app.handle())?;
            // The dropdown window is created hidden; we only show it when
            // the user clicks the tray icon.
            if let Some(window) = app.get_webview_window("dropdown") {
                let _ = window.hide();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide the dropdown window when it loses focus (typical menubar
            // dropdown UX). Main window is left alone — clicking elsewhere
            // shouldn't dismiss the editor.
            if window.label() == "dropdown" {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        });

    builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_main_window,
        commands::request_engage_main,
        commands::request_disengage_main,
        commands::set_preamp_main,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("DDPEC: error running tauri application");
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open editor", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit DDPEC", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    TrayIconBuilder::with_id("ddpec-tray")
        .tooltip("DDPEC — System EQ")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = commands::open_main_window(app.clone());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click → toggle the dropdown panel near the tray icon.
            // Right click is reserved for the context menu (handled by
            // Tauri above when show_menu_on_left_click is false).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                if let Some(window) = app.get_webview_window("dropdown") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        // Anchor the dropdown beneath the tray icon. Tauri's
                        // tray click position is in screen coords; we offset
                        // by half the window width so the panel centers
                        // under the icon.
                        let _ = window.set_position(tauri::PhysicalPosition {
                            x: position.x as i32 - 140,
                            y: position.y as i32 + 4,
                        });
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

mod commands {
    use tauri::{AppHandle, Manager};

    #[tauri::command]
    pub fn open_main_window(app: AppHandle) -> Result<(), String> {
        if let Some(window) = app.get_webview_window("main") {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            // Hide the dropdown if it was open — opening the editor implies
            // the user is moving on from the compact panel.
            if let Some(dropdown) = app.get_webview_window("dropdown") {
                let _ = dropdown.hide();
            }
            Ok(())
        } else {
            Err("main window not found".into())
        }
    }

    // The following commands forward dropdown-initiated actions to the
    // main window via Tauri events. The main window's webview listens
    // for these events and acts on them. v1 uses simple event-bridging;
    // a future iteration may move to Channels for streaming acks.
    #[tauri::command]
    pub fn request_engage_main(app: AppHandle) -> Result<(), String> {
        if let Some(window) = app.get_webview_window("main") {
            window
                .emit("ddpec:cmd:engage", ())
                .map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[tauri::command]
    pub fn request_disengage_main(app: AppHandle) -> Result<(), String> {
        if let Some(window) = app.get_webview_window("main") {
            window
                .emit("ddpec:cmd:disengage", ())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[tauri::command]
    pub fn set_preamp_main(app: AppHandle, db: i32) -> Result<(), String> {
        if let Some(window) = app.get_webview_window("main") {
            window
                .emit("ddpec:cmd:preamp", db)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
