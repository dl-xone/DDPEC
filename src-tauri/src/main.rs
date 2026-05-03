// Tauri entry point for DDPEC. Most logic lives in lib.rs so it can be
// shared with future iOS / Linux targets if we go that way.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ddpec_lib::run();
}
