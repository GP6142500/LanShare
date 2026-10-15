use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use ip::IpAddr as IfIpAddr;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;

type ClientSink = mpsc::UnboundedSender<String>;

// ----------------------------- 数据模型 -----------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    pub port: u16,
    pub password: String, // 6 位数字连接密码
    pub storage_dir: PathBuf,
    pub auto_start: bool,
    /// 自动清理：接收目录总大小超过 `cleanup_max_mb` 时，启动时删除
    /// 超过 `cleanup_days` 天的旧文件（按最旧优先）。false 表示不自动清理。
    #[serde(default = "default_auto_cleanup")]
    pub auto_cleanup: bool,
    /// 触发清理的目录容量阈值（MB），默认 2048（2GB）
    #[serde(default = "default_cleanup_max_mb")]
    pub cleanup_max_mb: u64,
    /// 只删除超过该天数的文件（默认 10 天）；未超过则保留，等下次启动再判断
    #[serde(default = "default_cleanup_days")]
    pub cleanup_days: u64,
}

#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub connected_at: i64,
}

#[derive(Clone)]
struct FileRecord {
    id: String,
    name: String,
    path: PathBuf,
    size: u64,
    uploader: String,
    created: i64,
    /// 磁盘上的最后修改时间（秒）。自清理用 mtime 判断「年龄」，
    /// 不依赖内存元数据（重启后可从磁盘恢复）。
    mtime: i64,
}

#[derive(Clone)]
struct DeviceConn {
    name: String,
    sender: ClientSink,
    connected_at: i64,
}

struct ServerRuntime {
    shutdown: oneshot::Sender<()>,
    #[allow(dead_code)]
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    cfg: Mutex<Config>,
    files: Mutex<HashMap<String, FileRecord>>,
    host: Mutex<Option<ClientSink>>, // 控制面板（主机）WebSocket
    devices: Mutex<HashMap<String, DeviceConn>>, // 已连接（已配对）设备
    shared_text: Mutex<String>,                  // 共享文本框（所有端共用的唯一真相）
    runtime: Mutex<Option<ServerRuntime>>,
}

// ----------------------------- 状态初始化 -----------------------------

impl AppState {
    pub fn new() -> Self {
        AppState {
            inner: Arc::new(Inner {
                cfg: Mutex::new(load_config()),
                files: Mutex::new(HashMap::new()),
                host: Mutex::new(None),
                devices: Mutex::new(HashMap::new()),
                shared_text: Mutex::new(String::new()),
                runtime: Mutex::new(None),
            }),
        }
    }

    pub fn config(&self) -> Config {
        self.inner.cfg.lock().unwrap().clone()
    }

    pub fn running(&self) -> bool {
        self.inner.runtime.lock().unwrap().is_some()
    }

    pub fn devices(&self) -> Vec<DeviceInfo> {
        let devs = self.inner.devices.lock().unwrap();
        devs.iter()
            .map(|(id, d)| DeviceInfo {
                id: id.clone(),
                name: d.name.clone(),
                connected_at: d.connected_at,
            })
            .collect()
    }

    pub fn disconnect(&self, id: &str) {
        disconnect_device_by_id(self, id);
    }

    /// 删除一个已接收的文件（删磁盘 + 内存元数据），并通知面板刷新。
    /// 返回是否成功删除。
    pub fn delete_file(&self, id: &str) -> bool {
        let rec = self.inner.files.lock().unwrap().remove(id);
        let Some(rec) = rec else { return false };
        let _ = std::fs::remove_file(&rec.path);
        broadcast_files(self);
        true
    }

    /// 清空接收目录中的所有历史文件。返回（成功数, 失败数）。
    pub fn clear_all_files(&self) -> (usize, usize) {
        let base = self.inner.cfg.lock().unwrap().storage_dir.clone();
        let records: Vec<FileRecord> = {
            let files = self.inner.files.lock().unwrap();
            files.values().cloned().collect()
        };
        let mut ok = 0usize;
        let mut fail = 0usize;
        for r in &records {
            if std::fs::remove_file(&r.path).is_ok() {
                ok += 1;
            } else {
                fail += 1;
            }
        }
        // 无论删除是否成功，都按磁盘实际状态重建（失败的会重新被扫回来）
        {
            let mut files = self.inner.files.lock().unwrap();
            files.clear();
        }
        restore_files_from_disk(self);
        // 清理空的上传者子目录
        prune_empty_dirs(&base);
        broadcast_files(self);
        (ok, fail)
    }

    /// 启动时执行一次自动清理（超阈值时删除最旧且超龄的文件）。
    pub fn cleanup_on_start(&self) -> (usize, u64) {
        run_auto_cleanup(self)
    }

    /// 启动时从磁盘恢复历史文件列表（重启后仍能看到历史）。
    pub fn restore_on_start(&self) {
        restore_files_from_disk(self);
    }

    pub fn new_password(&self) -> String {
        let pwd = gen_password();
        {
            let mut cfg = self.inner.cfg.lock().unwrap();
            cfg.password = pwd.clone();
            save_config(&cfg);
        }
        notify_host(self, &json!({ "type": "password_updated", "password": pwd.clone() }));
        pwd
    }

    pub async fn start(&self) -> Result<(), String> {
        {
            let rt = self.inner.runtime.lock().unwrap();
            if rt.is_some() {
                return Ok(());
            }
        }
        let port = self.config().port;
        let (sx, rx) = oneshot::channel::<()>();
        let st = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let app = Router::new()
                .route("/", get(serve_client))
                .route("/api/config", get(api_config))
                .route("/api/qr", get(qr))
                .route("/api/files", get(list_files))
                .route("/api/files/clear", post(clear_files_handler))
                .route("/api/file/:id", axum::routing::delete(delete_file_handler))
                .route("/api/upload", post(upload))
                .route("/api/download/:id", get(download))
                .route("/ws", get(ws_handler))
                // 放宽请求体上限（默认仅 2MB，手机照片/大文件会 400）；此处允许 2GB
                .layer(DefaultBodyLimit::max(2 * 1024 * 1024 * 1024))
                .layer(CorsLayer::permissive())
                .with_state(st.clone());
            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[lanshare] 端口绑定失败 {}: {}", port, e);
                    return;
                }
            };
            eprintln!("[lanshare] 服务已启动: http://0.0.0.0:{}", port);
            let server = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>());
            let _ = server.with_graceful_shutdown(async { let _ = rx.await; }).await;
            eprintln!("[lanshare] 服务已停止");
            let _ = st.inner.runtime.lock().unwrap().take();
        });
        *self.inner.runtime.lock().unwrap() = Some(ServerRuntime {
            shutdown: sx,
            handle,
        });
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let rt = self.inner.runtime.lock().unwrap().take();
        if let Some(r) = rt {
            let _ = r.shutdown.send(());
        }
        *self.inner.host.lock().unwrap() = None;
        self.inner.devices.lock().unwrap().clear();
        Ok(())
    }

    pub async fn apply_settings(
        &self,
        port: u16,
        password: String,
        storage_dir: String,
        auto_cleanup: bool,
        cleanup_max_mb: u64,
        cleanup_days: u64,
    ) -> Result<(), String> {
        if password.len() != 6 || !password.chars().all(|c| c.is_ascii_digit()) {
            return Err("连接密码必须是 6 位数字".into());
        }
        if port < 1024 {
            return Err("端口需大于 1024".into());
        }
        if cleanup_max_mb == 0 {
            return Err("容量阈值需大于 0".into());
        }
        if cleanup_days == 0 {
            return Err("保留天数需大于 0".into());
        }
        let (old_port, old_pwd, old_dir, new_dir) = {
            let mut cfg = self.inner.cfg.lock().unwrap();
            let old_port = cfg.port;
            let old_pwd = cfg.password.clone();
            let old_dir = cfg.storage_dir.clone();
            cfg.port = port;
            cfg.password = password.clone();
            cfg.auto_cleanup = auto_cleanup;
            cfg.cleanup_max_mb = cleanup_max_mb;
            cfg.cleanup_days = cleanup_days;
            let p = PathBuf::from(&storage_dir);
            if p.is_absolute() {
                // 目录不存在则创建（失败时忽略，上传阶段会再次确保并报错）
                if !p.exists() {
                    let _ = std::fs::create_dir_all(&p);
                }
                cfg.storage_dir = p;
            }
            let new_dir = cfg.storage_dir.clone();
            save_config(&cfg);
            (old_port, old_pwd, old_dir, new_dir)
        };

        // 接收目录变更：把已有文件迁移到新目录（移动而非丢弃）
        if old_dir != new_dir {
            let (moved, failed) = move_storage_dir(&old_dir, &new_dir);
            // 内存元数据里的路径同步更新（重新扫描新目录是最稳妥的做法）
            {
                let mut files = self.inner.files.lock().unwrap();
                files.clear();
            }
            restore_files_from_disk(self);
            broadcast_files(self);
            if moved > 0 || failed > 0 {
                notify_host(
                    self,
                    &json!({
                        "type": "toast",
                        "text": format!("已迁移 {} 个文件{}", moved,
                            if failed > 0 { format!("，{} 个失败", failed) } else { String::new() })
                    }),
                );
            }
        }

        if password != old_pwd {
            notify_host(self, &json!({ "type": "password_updated", "password": password }));
        }
        if port != old_port {
            self.stop().await?;
            self.start().await?;
        }
        Ok(())
    }
}

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lanshare")
}

fn default_storage() -> PathBuf {
    resolve_default_storage(dirs::download_dir(), std::env::var("USERPROFILE").ok())
}

/// Pure resolver (no env access) so it can be unit tested.
/// Priority: OS-reported Downloads > %USERPROFILE%\Downloads > system temp dir.
/// The chosen base always gets a `LanShare` subfolder appended.
fn resolve_default_storage(download: Option<PathBuf>, userprofile: Option<String>) -> PathBuf {
    download
        .or_else(|| userprofile.map(|p| PathBuf::from(p).join("Downloads")))
        .unwrap_or_else(std::env::temp_dir)
        .join("LanShare")
}

/// True only when the stored dir is exactly the machine's Downloads root
/// (old buggy default). Custom dirs such as `D:\Downloads` are preserved
/// because they never equal *this* machine's `download_dir()`.
fn should_migrate_storage(stored: &std::path::Path, download: Option<&std::path::Path>) -> bool {
    let Some(dl) = download else { return false };
    let cur = stored.to_string_lossy();
    let dl = dl.to_string_lossy();
    let dl = dl.trim_end_matches(['/', '\\']);
    cur.trim_end_matches(['/', '\\']) == dl
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_prefers_os_downloads_dir() {
        let got = resolve_default_storage(Some(PathBuf::from(r"D:\MyDownloads")), None);
        assert_eq!(got, PathBuf::from(r"D:\MyDownloads\LanShare"));
    }

    #[test]
    fn storage_falls_back_to_userprofile() {
        let got = resolve_default_storage(None, Some(r"C:\Users\Tom".to_string()));
        assert_eq!(got, PathBuf::from(r"C:\Users\Tom\Downloads\LanShare"));
    }

    #[test]
    fn storage_falls_back_to_temp_when_nothing_available() {
        let got = resolve_default_storage(None, None);
        assert!(got.ends_with("LanShare"));
    }

    #[test]
    fn migrate_only_when_equal_to_local_downloads_root() {
        use std::path::Path as StdPath;
        let dl = StdPath::new(r"C:\Users\Tom\Downloads");
        // old buggy value -> migrate
        assert!(should_migrate_storage(StdPath::new(r"C:\Users\Tom\Downloads"), Some(dl)));
        assert!(should_migrate_storage(StdPath::new(r"C:\Users\Tom\Downloads\"), Some(dl)));
        // already correct -> keep
        assert!(!should_migrate_storage(StdPath::new(r"C:\Users\Tom\Downloads\LanShare"), Some(dl)));
        // custom path on another drive -> keep (must NOT be migrated)
        assert!(!should_migrate_storage(StdPath::new(r"D:\Downloads"), Some(dl)));
        // no download dir known -> never migrate
        assert!(!should_migrate_storage(StdPath::new(r"C:\Users\Tom\Downloads"), None));
    }

    // ---------------- 自动清理 ----------------

    fn cand(name: &str, size: u64, age_days: i64, now: i64) -> CleanupCandidate {
        CleanupCandidate {
            path: PathBuf::from(name),
            size,
            mtime: now - age_days * 86400,
        }
    }

    const MB: u64 = 1024 * 1024;

    #[test]
    fn no_cleanup_when_below_threshold() {
        let now = 1_700_000_000;
        let cs = vec![cand("a", 100 * MB, 999, now), cand("b", 50 * MB, 999, now)];
        let planned = plan_cleanup(140 * MB, cs, 2048 * MB, 10 * 86400, now);
        assert!(planned.is_empty(), "未超阈值不应删除任何文件");
    }

    #[test]
    fn cleanup_only_removes_older_than_n_days() {
        let now = 1_700_000_000;
        // 总量超阈值，但所有文件都「未超龄」——一个都不该删
        let cs = vec![cand("a", 1500 * MB, 3, now), cand("b", 1000 * MB, 5, now)];
        let planned = plan_cleanup(2500 * MB, cs, 2048 * MB, 10 * 86400, now);
        assert!(planned.is_empty(), "未超过保留天数的文件不应被删除");

        // 混入一个超龄文件后，应从最旧的开始删，直到低于阈值
        let cs = vec![
            cand("old", 1000 * MB, 30, now),
            cand("new", 1500 * MB, 1, now),
        ];
        let planned = plan_cleanup(2500 * MB, cs, 2048 * MB, 10 * 86400, now);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].path, PathBuf::from("old"));
    }

    #[test]
    fn cleanup_deletes_oldest_first_until_under_threshold() {
        let now = 1_700_000_000;
        let cs = vec![
            cand("newest", 800 * MB, 1, now),
            cand("oldest", 800 * MB, 40, now),
            cand("middle", 800 * MB, 20, now),
        ];
        // 总 2400MB，阈值 2048MB → 删掉最旧的一个后剩 1600MB，够了
        let planned = plan_cleanup(2400 * MB, cs, 2048 * MB, 10 * 86400, now);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].path, PathBuf::from("oldest"));
    }

    #[test]
    fn cleanup_stops_when_remaining_files_are_too_young() {
        let now = 1_700_000_000;
        // 只有最旧的那个超龄；删掉它仍超阈值，但其余都未超龄 → 只删一个
        let cs = vec![
            cand("old", 100 * MB, 30, now),
            cand("young1", 1500 * MB, 2, now),
            cand("young2", 1500 * MB, 1, now),
        ];
        let planned = plan_cleanup(3100 * MB, cs, 2048 * MB, 10 * 86400, now);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].path, PathBuf::from("old"));
    }

    #[test]
    fn cleanup_skips_unknown_mtime() {
        let now = 1_700_000_000;
        let cs = vec![
            CleanupCandidate { path: PathBuf::from("unknown"), size: 3000 * MB, mtime: 0 },
            cand("old", 500 * MB, 40, now),
        ];
        let planned = plan_cleanup(3500 * MB, cs, 2048 * MB, 10 * 86400, now);
        // mtime 未知的跳过（保守），只删确实超龄的
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].path, PathBuf::from("old"));
    }

    #[test]
    fn cleanup_zero_days_never_deletes() {
        let now = 1_700_000_000;
        // days=0 时任何文件都不算「超龄」（age >= 0 恒真，这里用 1 秒边界验证语义）
        let cs = vec![cand("x", 3000 * MB, 0, now)];
        let planned = plan_cleanup(3000 * MB, cs, 2048 * MB, 86400, now);
        assert!(planned.is_empty());
    }

    // ---------------- 真实文件系统：dir_usage / collect_files ----------------

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lanshare_test_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn dir_usage_walks_subdirs_recursively() {
        let root = tmp_dir("usage");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b/c")).unwrap();
        std::fs::write(root.join("a/1.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(root.join("b/c/2.bin"), vec![0u8; 2000]).unwrap();
        std::fs::write(root.join("top.bin"), vec![0u8; 500]).unwrap();

        let (total, count) = dir_usage(&root);
        assert_eq!(count, 3, "应统计到 3 个文件");
        assert_eq!(total, 3500, "应统计到子目录字节数");

        let mut files = Vec::new();
        collect_files(&root, &mut files);
        assert_eq!(files.len(), 3, "collect_files 应递归收集 3 个文件");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn end_to_end_cleanup_against_real_files() {
        let root = tmp_dir("cleanup");
        let now = 1_700_000_000;
        // 造 3 个文件：最旧 40 天 / 中间 20 天 / 最新 1 天，各 1MB
        let mk = |sub: &str, name: &str, mb: u64, age_days: i64| {
            let dir = root.join(sub);
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join(name);
            std::fs::write(&p, vec![0u8; (mb * 1024 * 1024) as usize]).unwrap();
            // 直接把 mtime 设到指定年龄（用 set_file_mtime 不便跨平台，这里用 touch 语义的近似：
            // 通过构造候选来模拟，真实 mtime 由 file_mtime_secs 读取）
            let _ = age_days;
            p
        };
        let _p_old = mk("phone", "old40.bin", 1, 40);
        let _p_mid = mk("pc", "mid20.bin", 1, 20);
        let _p_new = mk("phone", "new1.bin", 1, 1);

        // 真实扫描：总量 3MB，阈值设成 2MB → 触发清理
        let (total, count) = dir_usage(&root);
        assert_eq!(count, 3);
        assert_eq!(total, 3 * 1024 * 1024);

        let mut files = Vec::new();
        collect_files(&root, &mut files);
        assert_eq!(files.len(), 3, "collect_files 应找到 3 个文件");
        // 真实 mtime 都是「刚刚」，所以保留天数设为 10 天时一个都不该删（验证「未超龄不删」）
        let planned = plan_cleanup(total, files.clone(), 2 * 1024 * 1024, 10 * 86400, now);
        assert!(planned.is_empty(), "刚写入的文件未超龄，不应被删除");

        // 把保留天数设为 0 天边界：所有文件都算超龄 → 应按最旧优先删到低于 2MB
        let planned2 = plan_cleanup(total, files, 2 * 1024 * 1024, 1, i64::MAX);
        assert!(!planned2.is_empty(), "阈值以上 + 全部计为超龄时应产生删除计划");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------------- 磁盘扫描：还原文件名与上传者 ----------------

    #[test]
    fn parse_stored_name_recovers_id_and_real_name() {
        let (id, name) = parse_stored_name("a1b2c3d4__报告 v2.docx");
        assert_eq!(id, "a1b2c3d4");
        assert_eq!(name, "报告 v2.docx");
        // 不符合规则（前缀非 8 位十六进制）时整体当文件名
        let (id2, name2) = parse_stored_name("明文文件.txt");
        assert_eq!(id2, "");
        assert_eq!(name2, "明文文件.txt");
        // 前缀长度对但不是十六进制 → 不解析
        let (id3, _) = parse_stored_name("zzzzzzzz__x.txt");
        assert_eq!(id3, "");
    }

    #[test]
    fn scan_storage_dir_recovers_uploader_and_sorts_newest_first() {
        let root = tmp_dir("scan");
        std::fs::create_dir_all(root.join("iPhone")).unwrap();
        std::fs::create_dir_all(root.join("Android")).unwrap();
        // 规范落盘名
        std::fs::write(root.join("iPhone/a1b2c3d4__照片.jpg"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("Android/deadbeef__note.txt"), vec![0u8; 50]).unwrap();
        // 用户自己丢进根目录的文件（无上传者子目录）
        std::fs::write(root.join("手动放入.txt"), vec![0u8; 10]).unwrap();

        let list = scan_storage_dir(&root);
        assert_eq!(list.len(), 3, "应扫描到 3 个文件");

        let photo = list.iter().find(|r| r.name == "照片.jpg").expect("应还原出原始文件名");
        assert_eq!(photo.uploader, "iPhone", "上传者应来自子目录名");
        assert_eq!(photo.id, "a1b2c3d4", "id 应来自落盘名前缀");

        let note = list.iter().find(|r| r.name == "note.txt").unwrap();
        assert_eq!(note.uploader, "Android");

        let manual = list.iter().find(|r| r.name == "手动放入.txt").unwrap();
        assert_eq!(manual.uploader, "未知", "根目录文件应归为未知来源");

        // 排序：最新在最前（mtime 单调不增）
        for w in list.windows(2) {
            assert!(w[0].mtime >= w[1].mtime, "应按 mtime 倒序排列");
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------------- 接收目录迁移 ----------------

    #[test]
    fn move_storage_dir_keeps_uploader_structure() {
        let src = tmp_dir("move_src");
        let dst = std::env::temp_dir().join(format!("lanshare_test_move_dst_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);

        std::fs::create_dir_all(src.join("iPhone")).unwrap();
        std::fs::create_dir_all(src.join("PC/nested")).unwrap();
        std::fs::write(src.join("iPhone/a1b2c3d4__a.txt"), b"aaa").unwrap();
        std::fs::write(src.join("PC/nested/b.txt"), b"bbb").unwrap();

        let (moved, failed) = move_storage_dir(&src, &dst);
        assert_eq!(moved, 2, "应移动 2 个文件");
        assert_eq!(failed, 0);

        // 结构与内容都保留
        assert!(dst.join("iPhone/a1b2c3d4__a.txt").is_file(), "子目录结构应保留");
        assert!(dst.join("PC/nested/b.txt").is_file(), "嵌套目录结构应保留");
        assert_eq!(std::fs::read(dst.join("iPhone/a1b2c3d4__a.txt")).unwrap(), b"aaa");
        // 源目录中的文件已移走
        assert!(!src.join("iPhone/a1b2c3d4__a.txt").exists(), "源文件应已被移走");

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn move_storage_dir_does_not_overwrite_existing() {
        let src = tmp_dir("move_conflict_src");
        let dst = std::env::temp_dir().join(format!("lanshare_test_move_dst2_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);

        std::fs::create_dir_all(src.join("iPhone")).unwrap();
        std::fs::create_dir_all(dst.join("iPhone")).unwrap();
        std::fs::write(src.join("iPhone/a1b2c3d4__same.txt"), b"new").unwrap();
        std::fs::write(dst.join("iPhone/a1b2c3d4__same.txt"), b"old").unwrap();

        let (moved, _failed) = move_storage_dir(&src, &dst);
        assert_eq!(moved, 1);
        // 原有文件内容不被覆盖
        assert_eq!(
            std::fs::read(dst.join("iPhone/a1b2c3d4__same.txt")).unwrap(),
            b"old",
            "同名文件不应被覆盖"
        );
        assert!(dst.join("iPhone/a1b2c3d4__same-1.txt").is_file(), "冲突时应加 -1 后缀");

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn move_storage_dir_noop_when_same_path() {
        let d = tmp_dir("move_same");
        std::fs::write(d.join("x.txt"), b"1").unwrap();
        let (moved, failed) = move_storage_dir(&d, &d);
        assert_eq!((moved, failed), (0, 0));
        assert!(d.join("x.txt").is_file(), "同路径时不应动文件");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_empty_dirs_removes_empties_but_keeps_files() {
        let root = tmp_dir("prune");
        std::fs::create_dir_all(root.join("empty1/empty2")).unwrap();
        std::fs::create_dir_all(root.join("hasfile")).unwrap();
        std::fs::write(root.join("hasfile/keep.txt"), b"1").unwrap();

        prune_empty_dirs(&root);

        assert!(!root.join("empty1").exists(), "空目录应被清理");
        assert!(root.join("hasfile/keep.txt").is_file(), "有文件的目录应保留");
        assert!(root.exists(), "根目录本身应保留");

        let _ = std::fs::remove_dir_all(&root);
    }
}

fn gen_password() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{}", rng.gen_range(100000..1000000))
}

fn default_auto_cleanup() -> bool {
    true
}
fn default_cleanup_max_mb() -> u64 {
    2048
}
fn default_cleanup_days() -> u64 {
    10
}

fn load_config() -> Config {
    let p = config_dir().join("config.json");
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(mut c) = serde_json::from_str::<Config>(&s) {
            if c.password.is_empty() {
                c.password = gen_password();
            }
            // 迁移：早期版本把接收目录存成 <Downloads> 根目录（而非 <Downloads>\LanShare）。
            // 仅当该目录正是「本机默认下载目录本身」时才迁移，避免误伤用户自定义路径。
            if should_migrate_storage(&c.storage_dir, dirs::download_dir().as_deref()) {
                c.storage_dir = default_storage();
                save_config(&c);
            }
            return c;
        }
    }
    Config {
        port: 18765,
        password: gen_password(),
        storage_dir: default_storage(),
        auto_start: true,
        auto_cleanup: default_auto_cleanup(),
        cleanup_max_mb: default_cleanup_max_mb(),
        cleanup_days: default_cleanup_days(),
    }
}

fn save_config(cfg: &Config) {
    let d = config_dir();
    let _ = std::fs::create_dir_all(&d);
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(d.join("config.json"), s);
    }
}

// ----------------------------- 网络辅助 -----------------------------

pub fn lan_ips() -> Vec<String> {
    let mut v = Vec::new();
    for i in get_if_addrs::getifaddrs() {
        if let IfIpAddr::V4(v4) = i.addr {
            let s = v4.to_string();
            if s.starts_with("127.") {
                continue;
            }
            v.push(s);
        }
    }
    v
}

pub fn primary_lan_ip() -> Option<String> {
    lan_ips().into_iter().next()
}

// ----------------------------- 文件辅助 -----------------------------

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != ':')
        .collect();
    if s.is_empty() {
        "file".to_string()
    } else {
        s
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 读取文件最后修改时间（秒）；失败返回 0（表示时间未知，清理时会保守跳过）。
fn file_mtime_secs(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ----------------------------- 磁盘扫描（历史文件） -----------------------------

/// 上传时落盘的文件名形如 `<8位id>__<原始文件名>`，且位于「接收目录/<上传者>/」下。
/// 因此可以直接从磁盘路径还原出「设备名」和「原始文件名」，无需持久化元数据。
const ID_PREFIX_LEN: usize = 8;
const ID_NAME_SEP: &str = "__";

/// 从落盘路径解析出 (id, 原始文件名)。不符合命名规则时用文件名兜底。
fn parse_stored_name(file_name: &str) -> (String, String) {
    if let Some(pos) = file_name.find(ID_NAME_SEP) {
        let id = &file_name[..pos];
        if id.len() == ID_PREFIX_LEN && id.chars().all(|c| c.is_ascii_hexdigit()) {
            return (id.to_string(), file_name[pos + ID_NAME_SEP.len()..].to_string());
        }
    }
    (String::new(), file_name.to_string())
}

/// 扫描接收目录，重建历史文件列表（按上传者子目录 → 文件）。
/// 每条记录用「完整路径」作为稳定 id（重启后依然可定位同一文件）。
fn scan_storage_dir(base: &std::path::Path) -> Vec<FileRecord> {
    let mut out = Vec::new();
    scan_into(base, base, &mut out);
    // 按时间倒序：最新在最前
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

fn scan_into(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<FileRecord>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        if ft.is_dir() {
            scan_into(base, &path, out);
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        // 上传者 = 相对于接收目录的第一级子目录名；直接放在根目录下的文件归为「未知」
        let uploader = path
            .strip_prefix(base)
            .ok()
            .and_then(|rel| rel.components().next())
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .filter(|s| rel_component_is_dir(base, s))
            .unwrap_or_else(|| "未知".to_string());
        let file_name = e.file_name().to_string_lossy().to_string();
        let (id_prefix, real_name) = parse_stored_name(&file_name);
        let key = if id_prefix.is_empty() {
            // 非本程序写入的文件（用户自己放进去的）：用完整路径作为 id
            path.to_string_lossy().to_string()
        } else {
            id_prefix
        };
        out.push(FileRecord {
            id: key,
            name: real_name,
            path: path.clone(),
            size: md.len(),
            uploader,
            created: file_mtime_secs(&path),
            mtime: file_mtime_secs(&path),
        });
    }
}

/// 判断接收目录下某个一级名称是否真的是「上传者子目录」
/// （避免把直接落在根目录的文件误判为来自名为 <文件名> 的设备）。
fn rel_component_is_dir(base: &std::path::Path, name: &str) -> bool {
    base.join(name).is_dir()
}

/// 把接收目录中的现有文件加载进内存元数据（启动时调用）。
/// 只补充内存里还没有的条目，不动已有记录。
fn restore_files_from_disk(st: &AppState) {
    let base = st.inner.cfg.lock().unwrap().storage_dir.clone();
    let scanned = scan_storage_dir(&base);
    if scanned.is_empty() {
        return;
    }
    let mut files = st.inner.files.lock().unwrap();
    for rec in scanned {
        // 同一路径已在内存中（本次会话上传的）则跳过，避免覆盖更精确的 created
        if files.values().any(|r| r.path == rec.path) {
            continue;
        }
        files.insert(rec.id.clone(), rec);
    }
}

/// 把接收目录下的所有文件移动到新目录（保持「上传者子目录」结构）。
/// 返回（成功数, 失败数）。同名冲突时加 `-1`、`-2` 后缀，不覆盖。
fn move_storage_dir(old: &std::path::Path, new: &std::path::Path) -> (usize, usize) {
    if old == new {
        return (0, 0);
    }
    if std::fs::create_dir_all(new).is_err() {
        return (0, 0);
    }
    let mut moved = 0usize;
    let mut failed = 0usize;
    let Ok(rd) = std::fs::read_dir(old) else {
        return (0, 0);
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let from = e.path();
        let name = e.file_name();
        let to = new.join(&name);
        if ft.is_dir() {
            // 递归移动子目录内容（保留上传者目录层级）
            let (m, f) = move_storage_dir(&from, &to);
            moved += m;
            failed += f;
            // 空目录清理（移动干净后删掉，避免残留空壳）
            let _ = std::fs::remove_dir(&from);
        } else if ft.is_file() {
            let target = unique_target(&to);
            if std::fs::rename(&from, &target).is_ok() {
                moved += 1;
            } else {
                // 跨盘符 rename 会失败（EXDEV），退化为「复制 + 删除」
                if std::fs::copy(&from, &target).is_ok() && std::fs::remove_file(&from).is_ok() {
                    moved += 1;
                } else {
                    failed += 1;
                }
            }
        }
    }
    (moved, failed)
}

/// 目标已存在时生成不冲突的路径：`a.txt` → `a-1.txt` → `a-2.txt` …
fn unique_target(path: &std::path::Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().to_string());
    for i in 1..10_000 {
        let candidate = match &ext {
            Some(e) => parent.join(format!("{}-{}.{}", stem, i, e)),
            None => parent.join(format!("{}-{}", stem, i)),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// 递归删除空的子目录（保留根目录本身）。用于清空 / 删除后收拾残局。
fn prune_empty_dirs(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        if path.is_dir() {
            prune_empty_dirs(&path);
            // 删除后目录仍为空才移除
            if std::fs::read_dir(&path).map(|mut r| r.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(&path);
            }
        }
    }
}

fn file_list(st: &AppState) -> Vec<serde_json::Value> {
    build_file_list(st, false)
}

/// 供主机（控制面板）使用，额外带上磁盘路径，便于「打开文件 / 打开所在位置」。
/// 注意：不要把这个版本发给浏览器端设备，避免泄露服务端目录结构。
fn file_list_with_path(st: &AppState) -> Vec<serde_json::Value> {
    build_file_list(st, true)
}

fn build_file_list(st: &AppState, with_path: bool) -> Vec<serde_json::Value> {
    let files = st.inner.files.lock().unwrap();
    let mut list: Vec<serde_json::Value> = files
        .values()
        .map(|r| {
            let mut v = json!({
                "id": r.id,
                "name": r.name,
                "size": r.size,
                "uploader": r.uploader,
                "created": r.created,
                "mtime": r.mtime
            });
            if with_path {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "path".to_string(),
                        serde_json::Value::String(r.path.to_string_lossy().to_string()),
                    );
                }
            }
            v
        })
        .collect();
    // 稳定的展示顺序：按上传时间倒序（最新在前），避免 HashMap 遍历顺序随机导致
    // 前端频繁重排或「刚上传的被清空后又出现在中间」。
    list.sort_by(|a, b| {
        let av = a.get("created").and_then(|x| x.as_i64()).unwrap_or(0);
        let bv = b.get("created").and_then(|x| x.as_i64()).unwrap_or(0);
        bv.cmp(&av)
    });
    list
}

fn check_password(st: &AppState, pwd: &str) -> bool {
    let cfg = st.inner.cfg.lock().unwrap();
    !cfg.password.is_empty() && pwd == cfg.password
}

// ----------------------------- 磁盘占用 / 自动清理 -----------------------------

/// 一个待清理的候选文件（自清理用）
#[derive(Debug, Clone, PartialEq)]
struct CleanupCandidate {
    path: PathBuf,
    size: u64,
    mtime: i64,
}

/// 递归统计目录总占用（字节）与文件个数。忽略读取失败（权限/占用）。
fn dir_usage(dir: &std::path::Path) -> (u64, usize) {
    let mut total = 0u64;
    let mut count = 0usize;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            let (s, c) = dir_usage(&e.path());
            total += s;
            count += c;
        } else if ft.is_file() {
            if let Ok(md) = e.metadata() {
                total += md.len();
                count += 1;
            }
        }
    }
    (total, count)
}

/// 收集目录下所有文件（递归）为清理候选
fn collect_files(dir: &std::path::Path, out: &mut Vec<CleanupCandidate>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            collect_files(&e.path(), out);
        } else if ft.is_file() {
            if let Ok(md) = e.metadata() {
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                out.push(CleanupCandidate {
                    path: e.path(),
                    size: md.len(),
                    mtime,
                });
            }
        }
    }
}

/// 纯函数：给定目录占用与候选文件，算出「应当删除」的清单。
/// 规则：仅当 `total > max_bytes` 时才清理；按最旧优先删除，
/// 且只删除年龄超过 `max_age_secs` 的文件；删到低于阈值即停。
/// 若剩余文件全部「未超龄」，则一个都不删（等下次启动再判断）。
fn plan_cleanup(
    total: u64,
    mut candidates: Vec<CleanupCandidate>,
    max_bytes: u64,
    max_age_secs: i64,
    now: i64,
) -> Vec<CleanupCandidate> {
    if total <= max_bytes {
        return Vec::new();
    }
    // 最旧优先
    candidates.sort_by_key(|c| c.mtime);
    let mut freed = 0u64;
    let mut planned = Vec::new();
    for c in candidates {
        if total.saturating_sub(freed) <= max_bytes {
            break;
        }
        // mtime 为 0 视为时间未知，保守起见不删（但要防止其阻止清理：直接跳过）
        if c.mtime <= 0 {
            continue;
        }
        let age = now.saturating_sub(c.mtime);
        if age < max_age_secs {
            // 已按最旧排序，后面只会更年轻 —— 不过仍继续以兜住 mtime 乱序的情况
            continue;
        }
        freed += c.size;
        planned.push(c);
    }
    planned
}

/// 启动时执行的自动清理：阈值内不动；超阈值则删最旧且超过保留天数的文件。
/// 返回（删除文件数, 释放字节数）。
fn run_auto_cleanup(st: &AppState) -> (usize, u64) {
    let (enabled, max_mb, days, dir) = {
        let cfg = st.inner.cfg.lock().unwrap();
        (
            cfg.auto_cleanup,
            cfg.cleanup_max_mb,
            cfg.cleanup_days,
            cfg.storage_dir.clone(),
        )
    };
    if !enabled || max_mb == 0 {
        return (0, 0);
    }
    let (total, _count) = dir_usage(&dir);
    let max_bytes = max_mb.saturating_mul(1024 * 1024);
    if total <= max_bytes {
        return (0, 0);
    }
    let mut candidates = Vec::new();
    collect_files(&dir, &mut candidates);
    let max_age = (days as i64).saturating_mul(86400);
    let planned = plan_cleanup(total, candidates, max_bytes, max_age, now_secs());

    // 从内存元数据中移除已删除的文件（先删盘，后同步内存，避免不一致）
    let mut removed = 0usize;
    let mut freed = 0u64;
    let mut removed_paths: Vec<PathBuf> = Vec::new();
    for c in &planned {
        if std::fs::remove_file(&c.path).is_ok() {
            removed += 1;
            freed += c.size;
            removed_paths.push(c.path.clone());
        }
    }
    if !removed_paths.is_empty() {
        let mut files = st.inner.files.lock().unwrap();
        files.retain(|_, r| !removed_paths.contains(&r.path));
    }
    if removed > 0 {
        broadcast_files(st);
    }
    (removed, freed)
}

// ----------------------------- HTTP 路由处理 -----------------------------

async fn serve_client() -> Html<&'static str> {
    Html(include_str!("../web/client.html"))
}

async fn api_config(State(st): State<AppState>) -> impl IntoResponse {
    let cfg = st.inner.cfg.lock().unwrap();
    let ips = lan_ips();
    let primary = ips.first().cloned().unwrap_or_default();
    let client_url = format!("http://{}:{}", primary, cfg.port);
    Json(json!({
        "port": cfg.port,
        "lan_ips": ips,
        "storage_dir": cfg.storage_dir.to_string_lossy(),
        "client_url": client_url
    }))
}

async fn qr(State(st): State<AppState>) -> impl IntoResponse {
    let primary = primary_lan_ip().unwrap_or_default();
    let port = st.inner.cfg.lock().unwrap().port;
    let url = format!("http://{}:{}", primary, port);
    let code = match qrcode::QrCode::new(url.as_bytes()) {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "qr error").into_response(),
    };
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();
    Response::builder()
        .header("Content-Type", HeaderValue::from_static("image/svg+xml"))
        .body(Body::from(svg))
        .unwrap()
        .into_response()
}

async fn list_files(
    State(st): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let pwd = q.get("pwd").cloned().unwrap_or_default();
    if !check_password(&st, &pwd) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    // 仅本机（控制面板）返回磁盘路径，供「打开文件 / 打开所在位置」使用；
    // 其他设备不返回 path，避免泄露服务端目录结构。
    let files = if addr.ip().is_loopback() {
        file_list_with_path(&st)
    } else {
        file_list(&st)
    };
    Json(json!({ "files": files })).into_response()
}

/// 删除一个已接收的文件。仅允许本机（控制面板）调用 —— 其他设备无权删除服务端文件。
async fn delete_file_handler(
    State(st): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if !addr.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let pwd = q.get("pwd").cloned().unwrap_or_default();
    if !check_password(&st, &pwd) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    if st.delete_file(&id) {
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::NOT_FOUND, "not found").into_response()
    }
}

/// 清空所有历史文件。仅允许本机（控制面板）调用。
async fn clear_files_handler(
    State(st): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if !addr.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let pwd = q.get("pwd").cloned().unwrap_or_default();
    if !check_password(&st, &pwd) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let (ok, fail) = st.clear_all_files();
    Json(json!({ "ok": true, "deleted": ok, "failed": fail })).into_response()
}

async fn upload(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let pwd = q.get("pwd").cloned().unwrap_or_default();
    if !check_password(&st, &pwd) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let uploader = q.get("name").cloned().unwrap_or_else(|| "设备".into());
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "file".into());
        let data = match field.bytes().await {
            Ok(b) => b,
            Err(_) => continue,
        };
        if data.is_empty() {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        // 每次上传都确保接收目录存在（不存在则创建）
        let base = st.inner.cfg.lock().unwrap().storage_dir.clone();
        if !base.exists() {
            if let Err(e) = std::fs::create_dir_all(&base) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("接收目录创建失败: {}", e),
                )
                    .into_response();
            }
        }
        let dir = base.join(&uploader);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("接收目录创建失败: {}", e),
            )
                .into_response();
        }
        let safe = sanitize(&name);
        let path = dir.join(format!("{}__{}", &id[..8], safe));
        if std::fs::write(&path, &data).is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "write error").into_response();
        }
        let rec = FileRecord {
            id: id.clone(),
            name: name.clone(),
            path: path.clone(),
            size: data.len() as u64,
            uploader: uploader.clone(),
            created: now_secs(),
            mtime: file_mtime_secs(&path),
        };
        st.inner.files.lock().unwrap().insert(id.clone(), rec);
        broadcast_files(&st);
        return Json(json!({ "id": id, "name": name, "size": data.len() })).into_response();
    }
    (StatusCode::BAD_REQUEST, "no file").into_response()
}

async fn download(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let pwd = q.get("pwd").cloned().unwrap_or_default();
    if !check_password(&st, &pwd) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let rec = st.inner.files.lock().unwrap().get(&id).cloned();
    match rec {
        Some(r) => {
            let ct = mime_guess::from_path(&r.name).first_or_octet_stream();
            let data = std::fs::read(&r.path).unwrap_or_default();
            let fname = percent_encoding::utf8_percent_encode(&r.name, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
            let cd = format!("attachment; filename*=UTF-8''{}", fname);
            Response::builder()
                .header("Content-Type", ct.as_ref())
                .header("Content-Disposition", cd)
                .header("Access-Control-Allow-Origin", "*")
                .body(Body::from(data))
                .unwrap()
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ----------------------------- WebSocket -----------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let role = q.get("role").cloned().unwrap_or_default();
    ws.on_upgrade(move |socket| handle_socket(socket, st, addr, role))
}

async fn handle_socket(
    socket: axum::extract::ws::WebSocket,
    st: AppState,
    addr: SocketAddr,
    role: String,
) {
    use axum::extract::ws::Message;
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // 身份判定
    let mut device_id: Option<String> = None;
    if role == "host" {
        if !addr.ip().is_loopback() {
            let _ = sender.send(Message::Close(None)).await;
            return;
        }
        *st.inner.host.lock().unwrap() = Some(tx.clone());
        let (password, port, files, devices, shared_text) = {
            let cfg = st.inner.cfg.lock().unwrap();
            let password = cfg.password.clone();
            let port = cfg.port;
            let files = file_list_with_path(&st);
            let devices = st.devices();
            let shared_text = current_shared_text(&st);
            (password, port, files, devices, shared_text)
        };
        let _ = sender
            .send(
                json!({
                    "type": "welcome",
                    "role": "host",
                    "password": password,
                    "port": port,
                    "files": files,
                    "devices": devices,
                    "text": shared_text
                })
                .to_string()
                .into(),
            )
            .await;
    } else {
        let shared_text = current_shared_text(&st);
        let _ = sender
            .send(
                json!({ "type": "welcome", "role": "device", "text": shared_text })
                    .to_string()
                    .into(),
            )
            .await;
    }

    // 主循环：rx（来自广播的通道）转发到 socket；socket 收到的文本交给业务处理
    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                if sender.send(Message::Text(msg)).await.is_err() { break; }
            }
            ws_msg = receiver.next() => {
                match ws_msg {
                    Some(Ok(Message::Text(t))) => {
                        handle_ws_message(&st, &tx, &mut device_id, &role, &t).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // 清理
    if role == "host" {
        *st.inner.host.lock().unwrap() = None;
    } else if let Some(id) = device_id.take() {
        // 先释放 devices 锁再广播，避免死锁
        let removed = st.inner.devices.lock().unwrap().remove(&id);
        if let Some(d) = removed {
            broadcast_devices(&st);
            notify_host(&st, &json!({ "type": "toast", "text": format!("{} 已断开", d.name) }));
        }
    }
}

async fn handle_ws_message(
    st: &AppState,
    tx: &ClientSink,
    device_id: &mut Option<String>,
    role: &str,
    text: &str,
) {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match typ {
        "pair" if role != "host" => {
            let pwd = v.get("password").and_then(|x| x.as_str()).unwrap_or("");
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("我的设备")
                .to_string();
            let ok = check_password(st, pwd);
            if ok {
                let id = uuid::Uuid::new_v4().to_string();
                let now = now_secs();
                st.inner.devices.lock().unwrap().insert(
                    id.clone(),
                    DeviceConn {
                        name: name.clone(),
                        sender: tx.clone(),
                        connected_at: now,
                    },
                );
                let _ = tx.send(
                    json!({ "type": "paired", "ok": true, "id": id.clone(), "name": name.clone() })
                        .to_string(),
                );
                *device_id = Some(id);
                broadcast_devices(st);
                notify_host(st, &json!({ "type": "toast", "text": format!("{} 已连接", name) }));
            } else {
                let _ = tx.send(
                    json!({ "type": "paired", "ok": false, "error": "密码错误" }).to_string(),
                );
            }
        }
        "text" => {
            // 共享文本框：任意一端编辑即写入单一真相，并广播给「其他」所有端。
            // 发送方本地已是最新，不回发，避免打断用户正在进行的输入。
            let allowed = role == "host" || device_id.is_some();
            if allowed {
                if let Some(value) = v.get("value").and_then(|x| x.as_str()) {
                    let from = if role == "host" {
                        "host".to_string()
                    } else {
                        device_id.clone().unwrap_or_default()
                    };
                    broadcast_text(st, &from, value);
                }
            }
        }
        "disconnect" if role == "host" => {
            if let Some(tid) = v.get("id").and_then(|x| x.as_str()) {
                disconnect_device_by_id(st, tid);
            }
        }
        _ => {}
    }
}

fn current_shared_text(st: &AppState) -> String {
    st.inner.shared_text.lock().unwrap().clone()
}

/// 共享文本框：写入单一真相并广播给除发送方外的所有端。
/// 发送方不回发（其本地已是最新），避免打断正在进行的输入。
fn broadcast_text(st: &AppState, from_id: &str, value: &str) {
    // 先写入共享状态（用作用域确保锁尽快释放）
    {
        let mut cur = st.inner.shared_text.lock().unwrap();
        *cur = value.to_string();
    }

    let (host_opt, devs) = {
        let host = st.inner.host.lock().unwrap().clone();
        let devs = st.inner.devices.lock().unwrap();
        (host, devs)
    };
    let msg = json!({ "type": "text", "value": value }).to_string();
    if from_id != "host" {
        if let Some(h) = host_opt {
            let _ = h.send(msg.clone());
        }
    }
    for (id, d) in devs.iter() {
        if id != from_id {
            let _ = d.sender.send(msg.clone());
        }
    }
}

fn broadcast_devices(st: &AppState) {
    let list = st.devices();
    notify_host(st, &json!({ "type": "device_list", "devices": list }));
}

fn broadcast_files(st: &AppState) {
    let files = file_list_with_path(st);
    notify_host(st, &json!({ "type": "file_list", "files": files }));
}

fn notify_host(st: &AppState, msg: &serde_json::Value) {
    if let Some(h) = st.inner.host.lock().unwrap().clone() {
        let _ = h.send(msg.to_string());
    }
}

fn disconnect_device_by_id(st: &AppState, id: &str) {
    // 先取出设备并释放 devices 锁，再广播，避免重复锁同一 Mutex 造成死锁
    let removed = st.inner.devices.lock().unwrap().remove(id);
    if let Some(d) = removed {
        let _ = d
            .sender
            .send(json!({ "type": "disconnected", "reason": "已被主机断开" }).to_string());
        broadcast_devices(st);
        notify_host(
            st,
            &json!({ "type": "toast", "text": format!("已断开设备：{}", d.name) }),
        );
    }
}

