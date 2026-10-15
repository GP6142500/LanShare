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
    ) -> Result<(), String> {
        if password.len() != 6 || !password.chars().all(|c| c.is_ascii_digit()) {
            return Err("连接密码必须是 6 位数字".into());
        }
        if port < 1024 {
            return Err("端口需大于 1024".into());
        }
        let (old_port, old_pwd) = {
            let mut cfg = self.inner.cfg.lock().unwrap();
            let old_port = cfg.port;
            let old_pwd = cfg.password.clone();
            cfg.port = port;
            cfg.password = password.clone();
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
    std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Downloads").join("LanShare"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\Users\高鹏\Downloads\LanShare"))
}

fn gen_password() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{}", rng.gen_range(100000..1000000))
}

fn load_config() -> Config {
    let p = config_dir().join("config.json");
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(mut c) = serde_json::from_str::<Config>(&s) {
            if c.password.is_empty() {
                c.password = gen_password();
            }
            // 迁移：早期误设为 Downloads 根目录的配置，改回 Downloads\LanShare
            let s = c.storage_dir.to_string_lossy().to_string();
            if s.ends_with("Downloads") || s.ends_with("Downloads/") || s.ends_with("Downloads\\") {
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

fn file_list(st: &AppState) -> Vec<serde_json::Value> {
    let files = st.inner.files.lock().unwrap();
    files
        .values()
        .map(|r| {
            json!({
                "id": r.id,
                "name": r.name,
                "size": r.size,
                "uploader": r.uploader,
                "created": r.created
            })
        })
        .collect()
}

fn check_password(st: &AppState, pwd: &str) -> bool {
    let cfg = st.inner.cfg.lock().unwrap();
    !cfg.password.is_empty() && pwd == cfg.password
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
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let pwd = q.get("pwd").cloned().unwrap_or_default();
    if !check_password(&st, &pwd) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    Json(json!({ "files": file_list(&st) })).into_response()
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
            path,
            size: data.len() as u64,
            uploader: uploader.clone(),
            created: now_secs(),
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
        let (password, port, files, devices) = {
            let cfg = st.inner.cfg.lock().unwrap();
            let password = cfg.password.clone();
            let port = cfg.port;
            let files = file_list(&st);
            let devices = st.devices();
            (password, port, files, devices)
        };
        let _ = sender
            .send(
                json!({
                    "type": "welcome",
                    "role": "host",
                    "password": password,
                    "port": port,
                    "files": files,
                    "devices": devices
                })
                .to_string()
                .into(),
            )
            .await;
    } else {
        let _ = sender
            .send(json!({ "type": "welcome", "role": "device" }).to_string().into())
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

fn broadcast_text(st: &AppState, from_id: &str, value: &str) {
    let (label, host_opt, devs) = {
        let host = st.inner.host.lock().unwrap().clone();
        let devs = st.inner.devices.lock().unwrap();
        let label = if from_id == "host" {
            "本机".to_string()
        } else {
            devs.get(from_id)
                .map(|d| d.name.clone())
                .unwrap_or_else(|| "设备".into())
        };
        (label, host, devs)
    };
    let msg = json!({ "type": "text", "value": value, "from": label }).to_string();
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
    let files = file_list(st);
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
