use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::extract::{Multipart, Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

type ClientSink = mpsc::UnboundedSender<String>;

// ----------------------------- 数据模型 -----------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    pub port: u16,
    pub storage_dir: PathBuf,
    pub host_token: String,
    pub paired: Vec<PairedDevice>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub token: String,
}

struct FileRecord {
    id: String,
    name: String,
    path: PathBuf,
    size: u64,
    uploader: String,
    created: i64,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    cfg: Mutex<Config>,
    files: Mutex<HashMap<String, FileRecord>>,
    clients: Mutex<HashMap<String, ClientSink>>, // 键: "host" 或设备 id
    pending: Mutex<HashMap<String, PendingDevice>>,
}

#[derive(Clone)]
struct PendingDevice {
    id: String,
    name: String,
}

// ----------------------------- 状态初始化 -----------------------------

impl AppState {
    pub fn new() -> Self {
        AppState {
            inner: Arc::new(Inner {
                cfg: Mutex::new(load_config()),
                files: Mutex::new(HashMap::new()),
                clients: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }
}

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lanshare")
}

fn default_storage() -> PathBuf {
    dirs::download_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("LanShare")
}

fn load_config() -> Config {
    let p = config_dir().join("config.json");
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(c) = serde_json::from_str::<Config>(&s) {
            return c;
        }
    }
    Config {
        port: 18765,
        storage_dir: default_storage(),
        host_token: uuid::Uuid::new_v4().to_string(),
        paired: Vec::new(),
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
    if let Ok(ifaces) = get_if_addrs::get_if_addrs() {
        for i in ifaces {
            if !i.is_loopback() {
                if let std::net::IpAddr::V4(ip) = i.addr {
                    v.push(ip.to_string());
                }
            }
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

// ----------------------------- 上传者解析 -----------------------------

fn resolve_uploader(st: &AppState, token: &str) -> Option<String> {
    let cfg = st.inner.cfg.lock().unwrap();
    if token == cfg.host_token {
        return Some("host".to_string());
    }
    if let Some(d) = cfg.paired.iter().find(|d| d.token == token) {
        return Some(d.name.clone());
    }
    None
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
        "paired_count": cfg.paired.len(),
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
    let mut headers = HashMap::new();
    headers.insert("Content-Type", "image/svg+xml");
    let _ = headers;
    Response::builder()
        .header("Content-Type", HeaderValue::from_static("image/svg+xml"))
        .body(Body::from(svg))
        .unwrap()
        .into_response()
}

async fn list_files(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({ "files": file_list(&st) }))
}

async fn upload(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let token = q.get("token").cloned().unwrap_or_default();
    let uploader = match resolve_uploader(&st, &token) {
        Some(n) => n,
        None => return (StatusCode::FORBIDDEN, "forbidden").into_response(),
    };
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.file_name().map(|s| s.to_string()).unwrap_or_else(|| "file".into());
        let data = match field.bytes().await {
            Ok(b) => b,
            Err(_) => continue,
        };
        if data.is_empty() {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = st
            .inner
            .cfg
            .lock()
            .unwrap()
            .storage_dir
            .join(&uploader);
        let _ = std::fs::create_dir_all(&dir);
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
        return Json(json!({ "id": id, "name": name, "size": data.len() })).into_response();
    }
    (StatusCode::BAD_REQUEST, "no file").into_response()
}

async fn download(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = q.get("token").cloned().unwrap_or_default();
    if resolve_uploader(&st, &token).is_none() {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let rec = st.inner.files.lock().unwrap().get(&id).cloned();
    match rec {
        Some(r) => {
            let ct = mime_guess::from_path(&r.name).first_or_octet_stream();
            let data = std::fs::read(&r.path).unwrap_or_default();
            let fname = percent_encoding::utf8_percent_encode(&r.name, percent_encoding::NON_ALPHANUMERIC).to_string();
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
    ws.on_upgrade(move |socket| handle_socket(socket, st, addr, role, q))
}

async fn handle_socket(
    socket: axum::extract::ws::WebSocket,
    st: AppState,
    addr: SocketAddr,
    role: String,
    q: HashMap<String, String>,
) {
    use axum::extract::ws::Message;
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // 身份判定
    let id: String = if role == "host" {
        if !addr.ip().is_loopback() {
            let _ = sender.send(Message::Close(None)).await;
            return;
        }
        "host".to_string()
    } else {
        let token = q.get("token").cloned().unwrap_or_default();
        let mut cfg = st.inner.cfg.lock().unwrap();
        if token == cfg.host_token {
            drop(cfg);
            uuid::Uuid::new_v4().to_string()
        } else if let Some(dev) = cfg.paired.iter().find(|d| d.token == token) {
            let id = dev.id.clone();
            drop(cfg);
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let name = q.get("name").cloned().unwrap_or_else(|| "设备".into());
            drop(cfg);
            st.inner
                .pending
                .lock()
                .unwrap()
                .insert(id.clone(), PendingDevice { id: id.clone(), name: name.clone() });
            let msg = json!({ "type": "pairing_request", "id": id, "name": name }).to_string();
            if let Some(h) = st.inner.clients.lock().unwrap().get("host").cloned() {
                let _ = h.send(msg);
            }
            id
        }
    };

    st.inner.clients.lock().unwrap().insert(id.clone(), tx);

    // 欢迎消息
    let welcome = if role == "host" {
        let token = st.inner.cfg.lock().unwrap().host_token.clone();
        json!({ "type": "welcome", "role": "host", "token": token, "files": file_list(&st) })
    } else {
        let paired = st
            .inner
            .cfg
            .lock()
            .unwrap()
            .paired
            .iter()
            .any(|d| d.id == id);
        json!({ "type": "welcome", "role": "device", "id": id, "paired": paired })
    };
    let _ = sender.send(Message::Text(welcome.to_string())).await;

    if role == "host" {
        let cfg = st.inner.cfg.lock().unwrap();
        let paired: Vec<_> = cfg
            .paired
            .iter()
            .map(|d| json!({ "id": d.id, "name": d.name }))
            .collect();
        let _ = sender
            .send(
                json!({ "type": "paired_list", "devices": paired })
                    .to_string()
                    .into(),
            )
            .await;
    }

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                if sender.send(Message::Text(msg)).await.is_err() { break; }
            }
            ws_msg = receiver.next() => {
                match ws_msg {
                    Some(Ok(Message::Text(t))) => {
                        if handle_ws_text(&st, &id, &role, &t).await { /* 继续 */ }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // 清理
    st.inner.clients.lock().unwrap().remove(&id);
    if role != "host" {
        st.inner.pending.lock().unwrap().remove(&id);
        let msg = json!({ "type": "device_left", "id": id }).to_string();
        if let Some(h) = st.inner.clients.lock().unwrap().get("host").cloned() {
            let _ = h.send(msg);
        }
    }
}

/// 返回 false 表示应关闭连接
async fn handle_ws_text(st: &AppState, id: &str, role: &str, text: &str) -> bool {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return true,
    };
    let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match typ {
        "text" => {
            if let Some(value) = v.get("value").and_then(|x| x.as_str()) {
                broadcast_text(st, id, value);
            }
        }
        "pair_approve" if role == "host" => {
            if let Some(tid) = v.get("id").and_then(|x| x.as_str()) {
                approve_pair(st, tid);
            }
        }
        "revoke" if role == "host" => {
            if let Some(tid) = v.get("id").and_then(|x| x.as_str()) {
                revoke_pair(st, tid);
            }
        }
        "set_storage" if role == "host" => {
            if let Some(dir) = v.get("dir").and_then(|x| x.as_str()) {
                let p = PathBuf::from(dir);
                if p.is_absolute() {
                    let mut cfg = st.inner.cfg.lock().unwrap();
                    cfg.storage_dir = p;
                    save_config(&cfg);
                    let _ = st
                        .inner
                        .clients
                        .lock()
                        .unwrap()
                        .get("host")
                        .cloned()
                        .map(|h| {
                            h.send(json!({ "type": "storage_updated", "dir": dir }).to_string())
                        });
                }
            }
        }
        _ => {}
    }
    true
}

fn broadcast_text(st: &AppState, from: &str, value: &str) {
    let clients = st.inner.clients.lock().unwrap().clone();
    for (cid, tx) in clients {
        if cid == from {
            continue;
        }
        let _ = tx.send(json!({ "type": "text", "value": value, "from": from }).to_string());
    }
}

fn approve_pair(st: &AppState, id: &str) {
    let mut pending = st.inner.pending.lock().unwrap();
    let dev = match pending.remove(id) {
        Some(d) => d,
        None => return,
    };
    drop(pending);
    let token = uuid::Uuid::new_v4().to_string();
    let paired_dev = PairedDevice {
        id: dev.id.clone(),
        name: dev.name.clone(),
        token: token.clone(),
    };
    {
        let mut cfg = st.inner.cfg.lock().unwrap();
        cfg.paired.push(paired_dev);
        save_config(&cfg);
    }
    if let Some(dtx) = st.inner.clients.lock().unwrap().get(&dev.id).cloned() {
        let _ = dtx.send(
            json!({ "type": "paired", "id": dev.id, "token": token, "name": dev.name })
                .to_string(),
        );
    }
    if let Some(h) = st.inner.clients.lock().unwrap().get("host").cloned() {
        let _ = h.send(
            json!({ "type": "device_paired", "id": dev.id, "name": dev.name })
                .to_string(),
        );
    }
}

fn revoke_pair(st: &AppState, id: &str) {
    {
        let mut cfg = st.inner.cfg.lock().unwrap();
        cfg.paired.retain(|d| d.id != id);
        save_config(&cfg);
    }
    if let Some(dtx) = st.inner.clients.lock().unwrap().get(id).cloned() {
        let _ = dtx.send(json!({ "type": "revoked" }).to_string());
    }
    if let Some(h) = st.inner.clients.lock().unwrap().get("host").cloned() {
        let _ = h.send(json!({ "type": "device_revoked", "id": id }).to_string());
    }
}

// ----------------------------- 启动服务 -----------------------------

pub async fn run_server(st: AppState) {
    let port = st.inner.cfg.lock().unwrap().port;
    let app = Router::new()
        .route("/", get(serve_client))
        .route("/api/config", get(api_config))
        .route("/api/qr", get(qr))
        .route("/api/files", get(list_files))
        .route("/api/upload", post(upload))
        .route("/api/download/:id", get(download))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(st);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[lanshare] 端口绑定失败 {}: {}", port, e);
            return;
        }
    };
    eprintln!("[lanshare] 服务已启动: http://0.0.0.0:{}", port);
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("[lanshare] 服务异常: {}", e);
    }
}
