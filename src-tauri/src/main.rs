#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use server::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::new();
            let port = state.inner.cfg.lock().unwrap().port;

            // 启动 axum 局域网服务（独立 tokio 任务）
            tauri::async_runtime::spawn(server::run_server(state.clone()));

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

            // 把端口注入控制面板窗口
            if let Some(w) = app.get_webview_window("main") {
                let js = format!(
                    "window.__LAN_PORT={};window.dispatchEvent(new Event('lan-ready'));",
                    port
                );
                let _ = w.eval(&js);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LanShare");
}
