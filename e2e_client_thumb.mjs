// 端到端：局域网客户端页（client.html）的文件列表缩略图
//
// 背景：缩略图最初只做进了主机控制面板（frontend/panel.js），
// 手机打开 client.html 看到的仍是纯文字行。本用例锁住「客户端也有缩略图」。
//
// 做法：起真实 exe → 上传一张 PNG 与一个 TXT →
// Edge headless + CDP 打开 http://127.0.0.1:<port>/ →
// 填密码点「连接」（走真实 WebSocket 配对）→ 断言列表里
// 图片行是真 <img> 且加载成功、非图片行是扩展名徽章。
//
// 不注入任何 fetch / WebSocket 桩：这一页的所有数据都来自真实服务。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法：node e2e_client_thumb.mjs <lanshare.exe>");
  process.exit(2);
}

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error("未找到 Microsoft Edge，无法运行浏览器渲染测试");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-cthumb-"));
const CFG = path.join(TMP, "lanshare");
const STORE = path.join(TMP, "store");
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const PORT = 18954;
const CDP_PORT = 9336;
const PWD = "246813";
const BASE = `http://127.0.0.1:${PORT}`;

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
    },
    null,
    2
  )
);

let pass = 0;
let fail = 0;
const ok = (n, c, e = "") => {
  c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 生成一张真 PNG（600x400，缩略图后应为 320x213） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = Math.floor((x / w) * 255);
      raw[p++] = Math.floor((y / h) * 255);
      raw[p++] = 170;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 极简 CDP 客户端（WebSocket 手写帧，零 npm 依赖） ----------
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = Buffer.from(Math.random().toString()).toString("base64").slice(0, 22) + "==";
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
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
          const msg = JSON.parse(payload.toString("utf8"));
          handlers.forEach((f) => f(msg));
        } catch (e) {}
      }
    });
    sock.on("error", reject);
    function send(obj) {
      const data = Buffer.from(JSON.stringify(obj));
      const mask = Buffer.from([0, 0, 0, 0]);
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

async function reachable() {
  try {
    return (await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function upload(name, buf) {
  const fd = new FormData();
  fd.append("file", new Blob([buf]), name);
  const r = await fetch(
    `${BASE}/api/upload?pwd=${encodeURIComponent(PWD)}&name=${encodeURIComponent("手机")}`,
    { method: "POST", body: fd }
  );
  return r.ok;
}

async function main() {
  console.log("端到端：客户端页文件列表缩略图\n");
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
    console.error("服务未启动，终止");
    process.exit(1);
  }

  ok(
    "上传 1 张图片 + 1 个文本",
    (await upload("海边.png", makePng(600, 400))) && (await upload("说明.txt", Buffer.from("hello")))
  );

  // ---------- 启动 Edge 并连接 CDP ----------
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(TMP, "edge-profile")}`,
      "--window-size=430,900",
      BASE + "/",
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
    ok("CDP 页面就绪", false, "无法连接调试端口");
    child.kill();
    edge.kill();
    process.exit(1);
  }
  ok("CDP 页面就绪", true);

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
  await send("Page.enable");
  await sleep(800);

  // 页面已自动用空密码尝试过一次连接（sessionStorage 无值）→ 会失败并进入重试。
  // 这里填好密码点「连接」：ws 还开着就直接 doPair，否则重连。
  await evalJs(`
    (function(){
      document.getElementById("pwd").value = ${JSON.stringify(PWD)};
      document.getElementById("name").value = "测试手机";
      document.getElementById("connect").click();
      return true;
    })()
  `);

  // 等配对成功 + 列表拉到数据 + 缩略图加载完成
  let connected = false;
  for (let i = 0; i < 40; i++) {
    const st = await evalJs(`JSON.stringify({
      stext: (document.getElementById("stext")||{}).textContent || "",
      main: !document.getElementById("main-area").classList.contains("hidden"),
      items: document.querySelectorAll("#files .item").length
    })`);
    const s = JSON.parse(st || "{}");
    if (s.stext === "已连接" && s.main && s.items >= 2) {
      connected = true;
      break;
    }
    await sleep(300);
  }
  ok("客户端连接成功且列表已渲染", connected);

  // 给 <img> 一点时间真正解码完成（naturalWidth > 0）
  for (let i = 0; i < 20; i++) {
    const done = await evalJs(
      `(function(){var i=document.querySelector("#files .thumb img");return !!(i && i.complete && i.naturalWidth>0);})()`
    );
    if (done) break;
    await sleep(200);
  }

  const info = JSON.parse(
    (await evalJs(`
      (function(){
        var items = Array.prototype.slice.call(document.querySelectorAll("#files .item"));
        function row(el){
          var img = el.querySelector(".thumb img");
          var badge = el.querySelector(".thumb .ext");
          var t = el.querySelector(".thumb");
          var r = t ? t.getBoundingClientRect() : null;
          return {
            name: (el.querySelector(".name")||{}).textContent || "",
            sub: (el.querySelector(".sub")||{}).textContent || "",
            hasImg: !!img,
            src: img ? img.getAttribute("src") : "",
            loaded: !!(img && img.complete && img.naturalWidth > 0),
            nw: img ? img.naturalWidth : 0,
            nh: img ? img.naturalHeight : 0,
            badge: badge ? badge.textContent : "",
            tw: r ? Math.round(r.width) : 0,
            th: r ? Math.round(r.height) : 0
          };
        }
        return JSON.stringify({
          rows: items.map(row),
          empty: !!document.querySelector("#files .empty")
        });
      })()
    `)) || "{}"
  );

  const rows = info.rows || [];
  const imgRow = rows.find((r) => r.name === "海边.png");
  const txtRow = rows.find((r) => r.name === "说明.txt");

  ok("列表渲染出 2 行（非空）", rows.length === 2 && !info.empty, JSON.stringify(info));
  ok("图片行使用 <img> 缩略图", !!(imgRow && imgRow.hasImg && !imgRow.badge), JSON.stringify(imgRow));
  ok("缩略图地址走 /api/thumb/", !!(imgRow && /\/api\/thumb\//.test(imgRow.src)), imgRow && imgRow.src);
  ok(
    "缩略图地址带密码与版本号",
    !!(imgRow && /pwd=[^&]+&v=\d+/.test(imgRow.src)),
    imgRow && imgRow.src
  );
  ok("缩略图真的加载成功（naturalWidth>0）", !!(imgRow && imgRow.loaded && imgRow.nw > 0), JSON.stringify(imgRow));
  ok(
    "缩略图按 320px 长边缩放（600x400 → 320x213）",
    !!(imgRow && imgRow.nw === 320 && Math.abs(imgRow.nh - 213) <= 1),
    imgRow && `${imgRow.nw}x${imgRow.nh}`
  );
  ok("缩略图容器为 44x44", !!(imgRow && imgRow.tw === 44 && imgRow.th === 44), imgRow && `${imgRow.tw}x${imgRow.th}`);
  ok("文本行退化为扩展名徽章 TXT", !!(txtRow && !txtRow.hasImg && txtRow.badge === "TXT"), JSON.stringify(txtRow));
  ok("文本行同样有 44x44 的占位", !!(txtRow && txtRow.tw === 44 && txtRow.th === 44), txtRow && `${txtRow.tw}x${txtRow.th}`);
  ok(
    "行内仍保留文件名与大小",
    !!(imgRow && /手机 · \d/.test(imgRow.sub) && txtRow && /手机 · \d/.test(txtRow.sub)),
    `${imgRow && imgRow.sub} | ${txtRow && txtRow.sub}`
  );

  // 截图存档，便于人工核对
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    const out = path.join(process.cwd(), "client-thumb-preview.png");
    fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    ok("已生成截图 client-thumb-preview.png", fs.existsSync(out) && fs.statSync(out).size > 5000);
  }

  cdp.close();
  edge.kill();
  child.kill();
  await sleep(600);
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
