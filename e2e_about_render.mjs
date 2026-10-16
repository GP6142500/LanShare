// 真实浏览器验证：设置页「关于」卡片渲染。
// 注入 __TAURI__ 桩返回 app_info，断言版本/构建时间/路径都落到 DOM 上。
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = process.argv[2];
if (!PAGE) { console.error("用法：node e2e_about_render.mjs <file-url>"); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-about-"));
const PORT = 9335;
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = Buffer.from(Math.random().toString()).toString("base64").slice(0, 22) + "==";
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), handshaked = false;
    const handlers = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaked) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        handshaked = true; buf = buf.slice(i + 4);
        resolve({ send, close: () => sock.destroy(), onMessage: (fn) => handlers.push(fn) });
      }
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        try { const msg = JSON.parse(payload.toString("utf8")); handlers.forEach((f) => f(msg)); } catch (e) {}
      }
    });
    sock.on("error", reject);
    function send(obj) {
      const data = Buffer.from(JSON.stringify(obj));
      const mask = Buffer.from([0, 0, 0, 0]);
      let header;
      if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }
  });
}

async function main() {
  console.log("真实浏览器：设置页「关于」卡片渲染验证\n");
  const profile = path.join(TMP, "profile");
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1200,900", PAGE,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  edge.stderr.on("data", () => {});

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      targets = await r.json();
      if (targets.some((t) => t.type === "page" && t.webSocketDebuggerUrl)) break;
    } catch {}
    await sleep(300);
  }
  const page = (targets || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) { ok("CDP 页面就绪", false); edge.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); }
  ok("CDP 页面就绪", true);

  const cdp = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  cdp.onMessage((m) => { if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res); cdp.send({ id: mid, method, params });
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__LAN_PORT = 18765;
      window.__TAURI__ = { core: { invoke: function (cmd) {
        if (cmd === "app_info") return Promise.resolve({
          version: "0.1.0", name: "lanshare", product: "LanShare",
          built_epoch: 1760582100,
          config_dir: "C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\lanshare",
          program: "C:\\\\Users\\\\x\\\\AppData\\\\Local\\\\LanShare\\\\lanshare.exe",
          os: "windows", arch: "x86_64"
        });
        if (cmd === "get_config") return Promise.resolve({ port: 18765, password: "123456", storage_dir: "C:\\\\recv", auto_cleanup: true, cleanup_max_mb: 2048, cleanup_days: 10 });
        if (cmd === "is_running") return Promise.resolve(true);
        if (cmd === "firewall_status") return Promise.resolve({ status: "allowed", program: "x", rules: [], elevated: false });
        if (cmd === "rotate_scan_token") return Promise.resolve("tok");
        return Promise.resolve(null);
      } }, event: { listen: function(){ return Promise.resolve(function(){}); } } };
      window.fetch = function () { return Promise.resolve({ ok: false, text: function(){ return Promise.resolve(""); }, json: function(){ return Promise.resolve({}); } }); };
      window.WebSocket = function () { this.close = function(){}; this.send = function(){}; };
    `,
  });
  await send("Page.reload", { ignoreCache: true });
  await sleep(1600);

  // 切到设置页
  await send("Runtime.evaluate", {
    expression: `(function(){ var n=document.querySelector('.nav-item[data-view="settings"]'); if(n) n.click(); return !!n; })()`,
    returnByValue: true,
  });
  await sleep(500);

  const r = await send("Runtime.evaluate", {
    expression: `
      (function(){
        var card = document.getElementById("about-card");
        if (!card) return JSON.stringify({ missing: true });
        function t(id){ var e=document.getElementById(id); return e ? e.textContent : null; }
        var rect = card.getBoundingClientRect();
        return JSON.stringify({
          version: t("about-version"),
          built: t("about-built"),
          config: t("about-config"),
          program: t("about-program"),
          w: Math.round(rect.width), h: Math.round(rect.height),
          lastCard: (function(){
            var cards = document.querySelectorAll("#view-settings .card");
            return cards.length ? cards[cards.length-1].id : null;
          })()
        });
      })()
    `,
    returnByValue: true,
  });
  const v = JSON.parse(r.result.result.value);
  ok("关于卡片存在", !v.missing);
  ok("关于卡片是设置页最后一张卡片", v.lastCard === "about-card", String(v.lastCard));
  ok("版本号已填充", v.version === "0.1.0", String(v.version));
  ok("构建时间已格式化为本地时间", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(v.built)), String(v.built));
  ok("配置文件路径已填充", String(v.config).includes("lanshare"), String(v.config));
  ok("程序路径已填充", String(v.program).includes("lanshare.exe"), String(v.program));
  ok("卡片有实际尺寸", v.w > 300 && v.h > 100, `${v.w}x${v.h}`);

  await send("Runtime.evaluate", {
    expression: `(function(){ var c = document.getElementById("about-card"); if (c && c.scrollIntoView) c.scrollIntoView({ block: "center" }); return true; })()`,
    returnByValue: true,
  });
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    const out = path.join(process.cwd(), "about-card-preview.png");
    fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    ok("已生成截图 about-card-preview.png", fs.existsSync(out) && fs.statSync(out).size > 1000);
  }

  cdp.close(); edge.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
