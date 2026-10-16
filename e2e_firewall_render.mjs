// 真实浏览器验证：用 Edge headless + CDP 打开真实的 index.html（注入 Tauri 桩），
// 断言防火墙提示横幅与设置页卡片真的能渲染出来。
//
// 与 e2e_drop_mask_render 同理：不依赖 Tauri 运行时，只验证 HTML/CSS/JS 本身。
// 通过 window.__TAURI__ 注入桩，让面板以「防火墙未放行」的状态启动。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = process.argv[2]; // file:// URL 指向 index.html
if (!PAGE) { console.error("用法：node e2e_firewall_render.mjs <file-url>"); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-fw-"));
const PORT = 9334;
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 极简 CDP 客户端（WebSocket 手写帧）
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
    let buf = Buffer.alloc(0), handshaked = false;
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
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
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
  console.log("真实浏览器：防火墙提示渲染验证\n");
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
  if (!page) { ok("CDP 页面就绪", false, "无法连接调试端口"); edge.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); }
  ok("CDP 页面就绪", true);

  const cdp = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  cdp.onMessage((m) => { if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    cdp.send({ id: mid, method, params });
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await sleep(600);

  // 注入 Tauri 桩：让面板以「防火墙未放行」状态跑起来。
  // 必须在面板脚本执行前注入 —— 用 Page.addScriptToEvaluateOnNewDocument 再 reload。
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__LAN_PORT = 18765;
      window.__TAURI__ = {
        core: { invoke: function (cmd) {
          if (cmd === "firewall_status") {
            return Promise.resolve({ status: "blocked", program: "C:\\\\Users\\\\x\\\\AppData\\\\Local\\\\LanShare\\\\lanshare.exe", rules: [], elevated: false });
          }
          if (cmd === "get_config") {
            return Promise.resolve({ port: 18765, password: "123456", storage_dir: "C:\\\\recv", auto_cleanup: true, cleanup_max_mb: 2048, cleanup_days: 10 });
          }
          if (cmd === "is_running") return Promise.resolve(true);
          if (cmd === "rotate_scan_token") return Promise.resolve("tok");
          if (cmd === "list_devices") return Promise.resolve([]);
          return Promise.resolve(null);
        } },
        event: { listen: function(){ return Promise.resolve(function(){}); } }
      };
      // 拦掉对外网请求，避免 headless 下长时间 pending
      window.fetch = function () { return Promise.resolve({ ok: false, text: function(){ return Promise.resolve(""); }, json: function(){ return Promise.resolve({}); } }); };
      window.WebSocket = function () { this.close = function(){}; this.send = function(){}; };
    `,
  });
  await send("Page.reload", { ignoreCache: true });
  await sleep(1500);

  // 1) 横幅已显示
  const banner = await send("Runtime.evaluate", {
    expression: `
      (function(){
        var a = document.getElementById("fw-alert");
        if (!a) return JSON.stringify({ missing: true });
        var r = a.getBoundingClientRect();
        return JSON.stringify({
          hidden: a.classList.contains("hidden"),
          display: getComputedStyle(a).display,
          w: Math.round(r.width), h: Math.round(r.height),
          title: (a.querySelector(".alert-title") || {}).textContent || "",
          text: (document.getElementById("fw-text") || {}).textContent || "",
          hasFix: !!document.getElementById("fw-fix"),
          hasRecheck: !!document.getElementById("fw-recheck"),
          hasDismiss: !!document.getElementById("fw-dismiss")
        });
      })()
    `,
    returnByValue: true,
  });
  const b = JSON.parse(banner.result.result.value);
  ok("横幅存在", !b.missing);
  ok("横幅已显示（hidden 已移除）", b.hidden === false, JSON.stringify(b));
  ok("横幅为可见布局", b.display !== "none", `display=${b.display}`);
  ok("横幅有实际尺寸（真的渲染出来）", b.w > 300 && b.h > 60, `${b.w}x${b.h}`);
  ok("标题文案正确", b.title === "局域网设备可能连不上", b.title);
  ok("正文含程序路径", String(b.text).includes("lanshare.exe"), String(b.text).slice(0, 60));
  ok("正文说明局域网连不上", String(b.text).includes("连不上"));
  ok("三个操作按钮齐全", b.hasFix && b.hasRecheck && b.hasDismiss);

  // 3) 截图存档（先首页横幅，再设置页防火墙卡片）
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    const out = path.join(process.cwd(), "firewall-alert-preview.png");
    fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    ok("已生成首页横幅截图 firewall-alert-preview.png", fs.existsSync(out) && fs.statSync(out).size > 1000);
  }

  // 4) 切到设置页，检查防火墙卡片状态行
  await send("Runtime.evaluate", {
    expression: `(function(){ var n=document.querySelector('.nav-item[data-view="settings"]'); if(n) n.click(); return !!n; })()`,
    returnByValue: true,
  });
  await sleep(500);
  const st = await send("Runtime.evaluate", {
    expression: `
      (function(){
        var dot = document.getElementById("fw-dot");
        var txt = document.getElementById("fw-state-text");
        var det = document.getElementById("fw-detail");
        if (!dot || !txt) return JSON.stringify({ missing: true });
        return JSON.stringify({
          dotClass: dot.className,
          text: txt.textContent,
          detail: det ? det.textContent : "",
          allowBtn: !!document.getElementById("fw-allow"),
          checkBtn: !!document.getElementById("fw-check")
        });
      })()
    `,
    returnByValue: true,
  });
  const s = JSON.parse(st.result.result.value);
  ok("设置页有防火墙状态行", !s.missing);
  ok("状态行显示「未放行」", String(s.text).includes("未放行"), s.text);
  ok("状态圆点为红/off", String(s.dotClass).includes("off"), s.dotClass);
  ok("详情含待放行程序路径", String(s.detail).includes("lanshare.exe"), String(s.detail).slice(0, 60));
  ok("设置页有「一键放行」按钮", s.allowBtn);
  ok("设置页有「重新检测」按钮", s.checkBtn);

  // 4b) 滚动到卡片处再截一张
  await send("Runtime.evaluate", {
    expression: `(function(){ var c = document.getElementById("fw-state-text"); if (c && c.scrollIntoView) c.scrollIntoView({ block: "center" }); return true; })()`,
    returnByValue: true,
  });
  await sleep(300);
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  if (shot2.result && shot2.result.data) {
    const out = path.join(process.cwd(), "firewall-settings-preview.png");
    fs.writeFileSync(out, Buffer.from(shot2.result.data, "base64"));
    ok("已生成设置页截图 firewall-settings-preview.png", fs.existsSync(out) && fs.statSync(out).size > 1000);
  }

  // 4) 点「不再提示」→ 横幅收起 + 写入标记
  await send("Runtime.evaluate", {
    expression: `(function(){ document.getElementById("fw-dismiss").click(); return true; })()`,
    returnByValue: true,
  });
  await sleep(300);
  const dismissed = await send("Runtime.evaluate", {
    expression: `
      (function(){
        return JSON.stringify({
          hidden: document.getElementById("fw-alert").classList.contains("hidden"),
          flag: (function(){ try { return localStorage.getItem("lanshare.fw.dismissed"); } catch(e){ return "err"; } })()
        });
      })()
    `,
    returnByValue: true,
  });
  const d = JSON.parse(dismissed.result.result.value);
  ok("点「不再提示」后横幅收起", d.hidden === true, JSON.stringify(d));
  ok("「不再提示」写入了 localStorage", d.flag === "1", String(d.flag));

  cdp.close();
  edge.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
