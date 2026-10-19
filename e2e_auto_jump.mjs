// 端到端：设备连接后自动跳到「传输」页
//
// 全部走真实链路：真实 exe + 真实 HTTP/WebSocket + 真实 Edge 无头渲染。
// 手机端连接由本脚本手写 WebSocket 帧完成，面板收到的是服务端真正广播的
// device_list —— 不注入 fetch / WebSocket 桩。
//
// 两组配置各跑一遍（同一个 exe，改 config.json 后重启）：
//   auto_jump_on_connect = true   → 设备连上后，面板从「历史」页跳回「传输」页
//   auto_jump_on_connect = false  → 设备连上后，面板停在「历史」页不动
//
// 每组都会断言「设备确实出现在面板的设备列表里」—— 否则 WS 没连上时，
// 「没跳转」会假通过。
//
// 两个测试环境上的坑（都踩过）：
//   1. 面板页用 http://127.0.0.1 静态服务器提供，不用 file:// ——
//      file:// 的 Origin 是 null，Edge 对它的 WebSocket 会直接判失败。
//   2. __TAURI__ 桩里 is_running 必须返回 true：refreshStatus 里
//      running=false 会主动 ws.close()，表现成「握手失败(1006)」，极具迷惑性。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法：node e2e_auto_jump.mjs <lanshare.exe>");
  process.exit(2);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error("未找到 Microsoft Edge，无法运行浏览器渲染测试");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-jump-"));
const CFG = path.join(TMP, "lanshare");
const STORE = path.join(TMP, "store");
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const PORT = 18954;
const PAGE_PORT = 18955; // 面板页的临时静态服务器
const PWD = "246810";
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9338;

let pass = 0;
let fail = 0;
const ok = (n, c, e = "") => {
  c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeConfig(autoJump) {
  fs.writeFileSync(
    path.join(CFG, "config.json"),
    JSON.stringify(
      {
        port: PORT,
        password: PWD,
        storage_dir: STORE,
        auto_start: true,
        auto_cleanup: false,
        cleanup_max_mb: 2048,
        cleanup_days: 10,
        auto_jump_on_connect: autoJump,
      },
      null,
      2
    )
  );
}

async function reachable() {
  try {
    return (await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

// ---------- 极简 WebSocket 客户端（手写帧，零 npm 依赖） ----------
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = Buffer.from(Math.random().toString()).toString("base64").slice(0, 22) + "==";
    const sock = net.connect(Number(u.port), u.hostname, () => {
      // 必须带上 query：/ws?role=device&name=… 的角色与名字都在这里
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let handshaked = false;
    const handlers = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaked) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        handshaked = true;
        buf = buf.slice(i + 4);
        resolve({ send, close: () => sock.destroy(), onMessage: (fn) => handlers.push(fn) });
      }
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f;
        let off = 2;
        let len = len0;
        if (len0 === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len0 === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        try {
          handlers.forEach((f) => f(JSON.parse(payload.toString("utf8"))));
        } catch (e) {}
      }
    });
    sock.on("error", reject);
    function send(obj) {
      const data = Buffer.from(JSON.stringify(obj));
      const mask = Buffer.alloc(4); // 全零掩码等价于不加掩码
      let header;
      if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
      }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }
  });
}

/// 复制真实 index.html，注入 __TAURI__ 打桩（资源仍用相对路径，由静态服务器提供）
function makeFixture(autoJump) {
  const idx = fs.readFileSync(path.join(ROOT, "frontend", "index.html"), "utf8");
  const cfg = {
    port: PORT,
    password: PWD,
    storage_dir: STORE,
    auto_start: true,
    auto_cleanup: false,
    cleanup_max_mb: 2048,
    cleanup_days: 10,
    auto_jump_on_connect: autoJump,
  };
  const stub = `<script>
window.__LAN_PORT = ${PORT};
window.__TAURI__ = { core: { invoke: async function (name) {
  if (name === "get_config") return ${JSON.stringify(cfg)};
  if (name === "app_info") return { version: "0.1.0", built_epoch: 0, config_dir: "", program: "" };
  if (name === "firewall_status") return { status: "allowed", program: "", rules: [], elevated: false };
  // 必须为 true：refreshStatus 里 running=false 会主动 ws.close()，
  // 桩返回 null 会让刚建好的连接被关掉（表现成 1006 握手失败）
  if (name === "is_running") return true;
  // 返回 null 而不是 []：refreshDevices 每 3 秒跑一次，空数组会覆盖 WS 渲染出的设备
  if (name === "get_devices") return null;
  return null;
} } };
</script>`;
  const out = idx.replace("<head>", "<head>\n" + stub);
  const p = path.join(TMP, "index.html");
  fs.writeFileSync(p, out);
  return p;
}

/// 极简静态服务器：用 http:// 提供面板页（见文件头的坑 1）
function startStatic(fixturePath) {
  const srv = http.createServer((req, res) => {
    const u = (req.url || "/").split("?")[0];
    const map = {
      "/": [fixturePath, "text/html"],
      "/index.html": [fixturePath, "text/html"],
      "/styles.css": [path.join(ROOT, "frontend", "styles.css"), "text/css"],
      "/panel.js": [path.join(ROOT, "frontend", "panel.js"), "text/javascript"],
    };
    const hit = map[u];
    if (!hit || !fs.existsSync(hit[0])) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": hit[1] + "; charset=utf-8", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(hit[0]));
  });
  return new Promise((resolve) => srv.listen(PAGE_PORT, "127.0.0.1", () => resolve(srv)));
}

/// 用 CDP 打开面板并返回操作句柄
async function openPanel(url) {
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(TMP, "edge-" + Math.random().toString(36).slice(2, 8))}`,
      "--window-size=1180,900",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  edge.stderr.on("data", () => {});

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      targets = await r.json();
      if (targets.some((t) => t.type === "page" && t.webSocketDebuggerUrl)) break;
    } catch {}
    await sleep(300);
  }
  const page = (targets || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) {
    edge.kill();
    return null;
  }

  const cdp = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  cdp.onMessage((m) => {
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      cdp.send({ id: mid, method, params });
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Runtime.enable");
  return { evalJs, kill: () => edge.kill() };
}

/// 模拟一台手机连上来（真实 WebSocket 握手 + pair）
async function connectDevice(name) {
  const ws = await wsConnect(`ws://127.0.0.1:${PORT}/ws?role=device&name=${encodeURIComponent(name)}`);
  ws.send({ type: "pair", password: PWD, name });
  await sleep(800);
  return ws;
}

const ACTIVE_VIEW = `(document.querySelector(".view.active") || {}).id || ""`;

async function runCase(autoJump) {
  console.log(`\n【auto_jump_on_connect = ${autoJump}】`);
  writeConfig(autoJump);

  const child = spawn(EXE, [], {
    env: { ...process.env, LANSHARE_CONFIG_DIR: CFG },
    cwd: TMP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});

  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(await reachable())) await sleep(300);
  const up = await reachable();
  ok("服务已就绪", up);
  if (!up) {
    child.kill();
    return;
  }

  const srv = await startStatic(makeFixture(autoJump));
  const panel = await openPanel(`http://127.0.0.1:${PAGE_PORT}/`);
  ok("面板页面已打开", !!panel);
  if (!panel) {
    srv.close();
    child.kill();
    return;
  }
  await sleep(1500);

  // 配置接线：复选框状态必须反映 config.json
  const checked = await panel.evalJs(`document.getElementById("set-auto-jump").checked`);
  ok(`设置页开关 = ${autoJump}`, checked === autoJump, `实际 ${checked}`);
  ok("初始停在首页", (await panel.evalJs(ACTIVE_VIEW)) === "view-home");

  // 切到历史页，模拟「用户正在找文件」
  await panel.evalJs(`document.querySelector('.nav-item[data-view="history"]').click()`);
  await sleep(200);
  ok("切到历史页成功", (await panel.evalJs(ACTIVE_VIEW)) === "view-history");

  const ws = await connectDevice("测试手机");
  await sleep(1200);

  // 关键前提：设备真的连上了（否则「没跳转」会假通过）
  const devText = await panel.evalJs(`document.getElementById("device-list").textContent`);
  ok("面板收到设备连接事件", String(devText || "").includes("测试手机"), devText);

  const view = await panel.evalJs(ACTIVE_VIEW);
  if (autoJump) {
    ok("自动跳到传输页", view === "view-devices", `实际 ${view}`);
  } else {
    ok("关闭后停在历史页不动", view === "view-history", `实际 ${view}`);
  }

  ws.close();
  await sleep(300);
  panel.kill();
  srv.close();
  child.kill();
  await sleep(900);
}

async function main() {
  console.log("端到端：设备连接后自动跳转\n");
  await runCase(true);
  await runCase(false);

  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`  （临时目录未能删除：${TMP}）`);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常：", e);
  process.exit(1);
});
