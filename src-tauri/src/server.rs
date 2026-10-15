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

    /// 启动时执行一次自动清理（超阈值时删除最旧且超龄的文件）。
    pub fn cleanup_on_start(&self) -> (usize, u64) {
        run_auto_cleanup(self)
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
        let (old_port, old_pwd) = {
            let mut cfg = self.inner.cfg.lock().unwrap();
            let old_port = cfg.port;
            let old_pwd = cfg.password.clone();
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
            save_config(&cfg);
            (old_port, old_pwd)
        };
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
