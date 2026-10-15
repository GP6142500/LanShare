#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use server::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri::State;

fn main() {
    let app_state = AppState::new();
    let boot = app_state.clone();
    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            let state = app.state::<AppState>();

            // 启动时自动开启局域网服务（独立 tokio 任务）
            tauri::async_runtime::spawn(async move {
                let _ = boot.start().await;
            });

            // 系统托盘
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LanShare · 局域网互传")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // 把端口注入控制面板窗口（初始值；端口变化后以 get_config 为准）
            if let Some(w) = app.get_webview_window("main") {
                let port = state.config().port;
                let js = format!(
                    "window.__LAN_PORT={};window.dispatchEvent(new Event('lan-ready'));",
                    port
                );
                let _ = w.eval(&js);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_service,
            stop_service,
            is_running,
            get_config,
            save_settings,
            get_devices,
            disconnect_device,
            regenerate_password,
            pick_dir,
            open_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running LanShare");
}

// ----------------------------- Tauri 命令 -----------------------------

#[tauri::command]
async fn start_service(state: State<'_, AppState>) -> Result<(), String> {
    state.start().await
}

#[tauri::command]
async fn stop_service(state: State<'_, AppState>) -> Result<(), String> {
    state.stop().await
}

#[tauri::command]
fn is_running(state: State<'_, AppState>) -> bool {
    state.running()
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> server::Config {
    state.config()
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    port: u16,
    password: String,
    storage_dir: String,
) -> Result<(), String> {
    state.apply_settings(port, password, storage_dir).await
}

#[tauri::command]
fn get_devices(state: State<'_, AppState>) -> Vec<server::DeviceInfo> {
    state.devices()
}

#[tauri::command]
fn disconnect_device(state: State<'_, AppState>, id: String) {
    state.disconnect(&id);
}

#[tauri::command]
fn regenerate_password(state: State<'_, AppState>) -> String {
    state.new_password()
}

#[tauri::command]
async fn pick_dir() -> Option<String> {
    use rfd::AsyncFileDialog;
    let dir = AsyncFileDialog::new().pick_folder().await;
    dir.map(|p| p.path().to_string_lossy().to_string())
}

#[tauri::command]
fn open_dir(path: String) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg(&path).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
}
