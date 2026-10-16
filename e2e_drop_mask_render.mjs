// 真实浏览器验证：用 Edge headless + CDP 打开遮罩验证页，
// 注入带 Files 的 dragenter 事件，截图确认遮罩确实渲染出来。
//
// 这一步是为了验证「HTML/CSS 本身能显示遮罩」，与 Tauri 的 dragDropEnabled 无关。
// Tauri 内的真实拖拽需在软件里手动确认（配置已改为 dragDropEnabled:false）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = process.argv[2]; // file:// URL
if (!PAGE) { console.error("用法：node e2e_drop_mask_render.mjs <file-url>"); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-mask-"));
const PORT = 9333;
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
      // 解析帧（仅处理服务端→客户端的文本帧，假设无分片）
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
  console.log("真实浏览器：拖拽遮罩渲染验证\n");
  const profile = path.join(TMP, "profile");
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1200,800", PAGE,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  edge.stderr.on("data", () => {});

  // 等 CDP 就绪
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

  // 1) 初始：遮罩应隐藏
  const before = await send("Runtime.evaluate", {
    expression: `document.getElementById("drop-mask").classList.contains("hidden")`,
    returnByValue: true,
  });
  ok("初始状态：遮罩隐藏", before.result && before.result.result && before.result.result.value === true);

  // 2) 派发一个带 Files 的 dragenter（构造真实的 DragEvent）
  await send("Runtime.evaluate", {
    expression: `
      (function(){
        var dt = new DataTransfer();
        // 用真实 File 让 types 含 "Files"
        try { dt.items.add(new File(["x"], "test.txt", {type:"text/plain"})); } catch(e) {}
        var ev = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt });
        window.dispatchEvent(ev);
        return Array.from(dt.types);
      })()
    `,
    returnByValue: true,
  });

  await sleep(400);

  // 3) 遮罩应显示，且盒子可见
  const after = await send("Runtime.evaluate", {
    expression: `
      (function(){
        var m = document.getElementById("drop-mask");
        var box = m.querySelector(".drop-mask-box");
        var r = box.getBoundingClientRect();
        return JSON.stringify({
          hidden: m.classList.contains("hidden"),
          display: getComputedStyle(m).display,
          boxW: Math.round(r.width), boxH: Math.round(r.height),
          title: m.querySelector(".drop-mask-title").textContent,
          sub: m.querySelector(".drop-mask-sub").textContent
        });
      })()
    `,
    returnByValue: true,
  });
  const info = JSON.parse(after.result.result.value);
  ok("拖入文件后：遮罩显示（hidden 已移除）", info.hidden === false, JSON.stringify(info));
  ok("遮罩层为可见的 grid/flex 显示", info.display !== "none", `display=${info.display}`);
  ok("遮罩盒子有实际尺寸（真的渲染出来了）", info.boxW > 100 && info.boxH > 60, `box=${info.boxW}x${info.boxH}`);
  ok("文案：松开即可上传", info.title === "松开即可上传", info.title);
  ok("文案：文件将保存到本机接收目录", info.sub === "文件将保存到本机接收目录", info.sub);

  // 4) 截图存档
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    const out = path.join(process.cwd(), "drop-mask-preview.png");
    fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    ok("已生成截图 drop-mask-preview.png", fs.existsSync(out) && fs.statSync(out).size > 1000);
  }

  // 5) 拖拽离开（dragleave with relatedTarget=null）→ 遮罩隐藏
  await send("Runtime.evaluate", {
    expression: `window.dispatchEvent(new DragEvent("dragleave", { bubbles:true, cancelable:true, relatedTarget: null }))`,
    returnByValue: true,
  });
  await sleep(300);
  const gone = await send("Runtime.evaluate", {
    expression: `document.getElementById("drop-mask").classList.contains("hidden")`,
    returnByValue: true,
  });
  ok("拖出窗口后：遮罩隐藏", gone.result.result.value === true);

  cdp.close();
  edge.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常：", e); process.exit(1); });
