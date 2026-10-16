#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod firewall;
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
            // 启动时自动开启局域网服务（独立 tokio 任务）
            // 端口注入推迟到服务真正绑定之后再做：start() 在端口被占用时会回退到系统分配的
            // 端口并回写配置，若在 setup() 阶段就取 state.config().port，注入的可能是回退前的
            // 旧值，前端会拿它当基准，误判成「端口被改过」。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 自动清理：超容量阈值时删除最旧且超过保留天数的历史文件
                let (n, freed) = boot.cleanup_on_start();
                if n > 0 {
                    eprintln!(
                        "[lanshare] 自动清理完成：删除 {} 个文件，释放 {} MB",
                        n,
                        freed / 1024 / 1024
                    );
                }
                // 扫描接收目录，恢复历史文件列表（重启后仍可管理历史）
                boot.restore_on_start();
                let _ = boot.start().await;
                // 服务已绑定（端口已确定为最终值），此时再注入端口并唤醒前端
                let port = boot.config().port;
                inject_port(&handle, port);
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

            // 把端口注入控制面板窗口这件事，已挪到服务绑定成功之后（见上方 spawn 块），
            // 保证前端拿到的 __LAN_PORT 一定是最终实际监听端口。

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
            open_dir,
            open_path,
            reveal_path,
            open_storage_dir,
            delete_received_file,
            clear_history_files,
            rotate_scan_token,
            firewall_status,
            firewall_fix,
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running LanShare");
}

// ----------------------------- Tauri 命令 -----------------------------

/// 把最终端口注入主窗口，并派发 lan-ready 事件唤醒面板。
/// 必须在服务绑定成功之后调用：端口回退会改写配置，过早注入会拿到旧值。
fn inject_port(app: &tauri::AppHandle, port: u16) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "window.__LAN_PORT={};window.dispatchEvent(new Event('lan-ready'));",
            port
        );
        let _ = w.eval(&js);
    }
}

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
    auto_cleanup: bool,
    cleanup_max_mb: u64,
    cleanup_days: u64,
) -> Result<(), String> {
    state
        .apply_settings(port, password, storage_dir, auto_cleanup, cleanup_max_mb, cleanup_days)
        .await
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

/// 轮换扫码免密令牌，返回新令牌（二维码 URL 会带上它）。
/// 旧令牌立即失效 —— 换密码或手动刷新二维码时调用。
#[tauri::command]
fn rotate_scan_token(state: State<'_, AppState>) -> String {
    state.rotate_scan_token()
}

/// 关于信息：版本号 / 构建时间 / 配置文件路径 / 程序路径。
/// 版本号取自 Cargo.toml（编译期常量），构建时间由 build.rs 注入的编译期环境变量提供。
#[tauri::command]
fn app_info() -> serde_json::Value {
    // build.rs 注入的构建时刻（UTC 秒）。option_env! 避免未注入时编译失败。
    let built_epoch: u64 = option_env!("LANSHARE_BUILD_TIME")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": env!("CARGO_PKG_NAME"),
        "product": "LanShare",
        "description": env!("CARGO_PKG_DESCRIPTION"),
        "authors": env!("CARGO_PKG_AUTHORS"),
        // 交给前端按本地时区格式化；0 表示未知
        "built_epoch": built_epoch,
        "config_dir": server::config_dir().to_string_lossy().to_string(),
        "program": std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 查询 Windows 防火墙是否已放行本程序（局域网能否连进来）。
/// 只读、无需管理员，故可在每次打开界面时调用。
#[tauri::command]
async fn firewall_status() -> firewall::FirewallInfo {
    // PowerShell 查询有百毫秒级开销，放到阻塞线程池，别卡住 UI 线程
    tauri::async_runtime::spawn_blocking(firewall::check)
        .await
        .unwrap_or(firewall::FirewallInfo {
            status: firewall::FirewallStatus::Unknown,
            program: String::new(),
            rules: vec![],
            elevated: false,
        })
}

/// 一键放行：以管理员权限（UAC 提权）为当前程序添加防火墙入站规则。
///
/// 用 `Start-Process -Verb RunAs` 拉起一个提权 PowerShell 执行放行脚本 ——
/// 这样不必让整个应用常驻管理员，只在用户点按钮时提权一次。
/// 提权后需重新 `firewall_status()` 确认结果（提权进程是独立的，无法直接回传）。
#[tauri::command]
async fn firewall_fix() -> Result<(), String> {
    #[cfg(windows)]
    {
        let script = firewall::elevation_script();
        // 把脚本编码成 Base64 再交给 powershell -EncodedCommand，
        // 避免路径中的引号/中文/空格在多次转义中被破坏。
        let encoded = base64_utf16le(&script);
        let launcher = format!(
            "Start-Process -FilePath 'powershell' -Verb RunAs -ArgumentList \
             '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{}' -Wait",
            encoded
        );
        let out = tauri::async_runtime::spawn_blocking(move || {
            firewall::run_powershell(&launcher)
        })
        .await
        .map_err(|e| format!("提权任务失败: {}", e))?;
        return match out {
            Some(_) => Ok(()),
            // 用户在 UAC 对话框点了「否」，或提权被策略拦截
            None => Err("未获得管理员授权，未能添加防火墙规则".into()),
        };
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".into())
    }
}

/// 把字符串编码为 UTF-16LE 的 Base64（PowerShell `-EncodedCommand` 要求的格式）。
#[cfg(windows)]
fn base64_utf16le(s: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
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

/// 用系统默认程序打开一个文件
#[tauri::command]
fn open_path(path: String) {
    #[cfg(windows)]
    {
        // explorer 会按扩展名调用默认关联程序打开文件
        let _ = std::process::Command::new("explorer").arg(&path).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
}

/// 打开文件所在位置，并在资源管理器中选中该文件
#[tauri::command]
fn reveal_path(path: String) {
    #[cfg(windows)]
    {
        // 必须用 /select,"<path>" 的原始形式：路径含空格时若不加引号，
        // explorer 会把空格后的部分当成另一个参数，导致定位失败。
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }
}

/// 删除一条已接收的文件（删磁盘 + 内存元数据）。仅主机控制面板使用。
#[tauri::command]
fn delete_received_file(state: State<'_, AppState>, id: String) -> bool {
    state.delete_file(&id)
}

/// 清空接收目录里的所有历史文件。返回（成功数, 失败数）。
#[tauri::command]
fn clear_history_files(state: State<'_, AppState>) -> (usize, usize) {
    state.clear_all_files()
}

/// 打开当前接收目录
#[tauri::command]
fn open_storage_dir(state: State<'_, AppState>) {
    let dir = state.config().storage_dir;
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    }
}
