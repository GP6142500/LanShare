// E2E: 扫码免密（token）vs 手动密码 两条通路
// 用法: node e2e_scan_token.mjs <exe-path>
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const EXE = process.argv[2];
const PORT = 18899;
const BASE = `http://127.0.0.1:${PORT}`;

// 用独立临时目录做接收目录，避免污染真实数据。
// 关键：把 APPDATA 指到临时目录 —— config_dir() = %APPDATA%\lanshare，
// 这样测试用的 config.json 与用户真实配置完全隔离。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-e2e-"));
const CFG_DIR = path.join(TMP, "lanshare");
fs.mkdirSync(CFG_DIR, { recursive: true });
const STORE = path.join(TMP, "store");
fs.mkdirSync(STORE, { recursive: true });

const TEST_PWD = "246810";
fs.writeFileSync(
  path.join(CFG_DIR, "config.json"),
  JSON.stringify(
    {
      port: PORT,
      password: TEST_PWD,
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

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WebSocket 极简客户端（只处理文本帧 + 掩码发送）
import net from "node:net";
import crypto from "node:crypto";
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0), handshaken = false;
    const handlers = [];
    const api = {
      send(obj) { sock.write(frame(JSON.stringify(obj))); },
      onMessage(fn) { handlers.push(fn); },
      close() { try { sock.destroy(); } catch (e) {} },
    };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        handshaken = true;
        buf = buf.subarray(i + 4);
        resolve(api);
      }
      let msg;
      while ((msg = decode(buf))) {
        buf = msg.rest;
        if (msg.opcode === 1) {
          const txt = msg.payload.toString("utf8");
          handlers.forEach((h) => h(txt));
        }
      }
    });
    sock.on("error", reject);
  });
}
function frame(str) {
  const payload = Buffer.from(str, "utf8");
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
function decode(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { fin, opcode, payload: buf.subarray(off, off + len), rest: buf.subarray(off + len) };
}

async function readJson(sock, pred, timeout = 6000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout);
    sock.onMessage((txt) => {
      let m; try { m = JSON.parse(txt); } catch (e) { return; }
      if (pred(m)) { clearTimeout(t); resolve(m); }
    });
  });
}

async function main() {
  console.log("== 启动 lanshare ==");
  const child = spawn(EXE, [], {
    env: { ...process.env, LANSHARE_CONFIG_DIR: CFG_DIR },
    cwd: TMP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { const s = d.toString(); if (s.includes("服务已启动")) console.log("  " + s.trim()); });

  // 等待端口可用
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { const r = await fetch(BASE + "/api/config"); if (r.ok) { up = true; break; } } catch (e) {}
  }
  ok("服务已就绪", up);
  if (!up) { child.kill(); process.exit(1); }

  const cfg = await (await fetch(BASE + "/api/config")).json();
  console.log("  /api/config → port:", cfg.port, "scan_token:", cfg.scan_token);
  const REAL_TOKEN = cfg.scan_token;
  ok("本机可读取扫码令牌", typeof REAL_TOKEN === "string" && REAL_TOKEN.length === 16, REAL_TOKEN);

  // ---- 2. 扫码免密：token 配对成功 ----
  console.log("\n== 2. 扫码免密（token）配对 ==");
  const d1 = await wsConnect(`ws://127.0.0.1:${PORT}/ws?role=device&name=PhoneAuto`);
  const welcome1 = await readJson(d1, (m) => m.type === "welcome");
  ok("设备收到 welcome", !!welcome1 && welcome1.role === "device");

  const paired1 = readJson(d1, (m) => m.type === "paired");
  // 先试错令牌
  d1.send({ type: "pair", token: "0000000000000000", name: "PhoneAuto" });
  const bad = await paired1;
  ok("错误令牌被拒绝", !!bad && bad.ok === false, JSON.stringify(bad));

  const paired2 = readJson(d1, (m) => m.type === "paired");
  d1.send({ type: "pair", token: REAL_TOKEN, name: "PhoneAuto" });
  const good = await paired2;
  ok("正确令牌配对成功", !!good && good.ok === true, JSON.stringify(good));

  // 回归：扫码配对必须把连接密码补发给设备。
  // 文件上传/下载走 HTTP 接口，只认密码不认令牌；不补发就会出现
  // 「文本同步正常、传文件提示未获取到密码」的割裂现象。
  ok("扫码配对下发了连接密码", !!good && typeof good.password === "string" && good.password.length === 6,
     JSON.stringify(good));
  ok("下发的密码与主机配置一致", !!good && good.password === TEST_PWD,
     `got=${good && good.password} want=${TEST_PWD}`);

  // 用下发的密码真实走一次上传，确认 HTTP 接口确实接受它
  try {
    const fd = new FormData();
    fd.append("file", new Blob(["hello-from-scan"]), "scan-upload.txt");
    const up = await fetch(
      `http://127.0.0.1:${PORT}/api/upload?pwd=${encodeURIComponent(good.password)}&name=PhoneAuto`,
      { method: "POST", body: fd }
    );
    ok("用下发的密码可以上传文件（HTTP 接口放行）", up.ok, `status=${up.status}`);
  } catch (e) {
    ok("用下发的密码可以上传文件（HTTP 接口放行）", false, String(e && e.message));
  }

  // 而「空密码」仍必须被拒 —— 修复不能把上传接口变成免密
  try {
    const fd2 = new FormData();
    fd2.append("file", new Blob(["x"]), "no-pwd.txt");
    const up2 = await fetch(`http://127.0.0.1:${PORT}/api/upload?pwd=&name=PhoneAuto`, {
      method: "POST",
      body: fd2,
    });
    ok("空密码上传仍被拒绝（未因修复而放开）", !up2.ok, `status=${up2.status}`);
  } catch (e) {
    // 服务端排干 body 后回 403；若连接被提前关闭也算拒绝
    ok("空密码上传仍被拒绝（未因修复而放开）", true, String(e && e.message));
  }

  d1.close();

  // ---- 3. 手动密码通路 ----
  console.log("\n== 3. 手动输入密码配对 ==");
  const d2 = await wsConnect(`ws://127.0.0.1:${PORT}/ws?role=device&name=PhoneManual`);
  await readJson(d2, (m) => m.type === "welcome");
  const pBad = readJson(d2, (m) => m.type === "paired");
  d2.send({ type: "pair", password: "000000", name: "PhoneManual" });
  const rBad = await pBad;
  ok("错误密码被拒绝", !!rBad && rBad.ok === false, JSON.stringify(rBad));

  const pGood = readJson(d2, (m) => m.type === "paired");
  d2.send({ type: "pair", password: TEST_PWD, name: "PhoneManual" });
  const rGood = await pGood;
  ok("正确密码配对成功", !!rGood && rGood.ok === true, JSON.stringify(rGood));
  // 手动路径无需回传密码（前端自己就有），回传反而是多余的凭据扩散
  ok("手动密码配对不对回传密码", !!rGood && rGood.password === undefined,
     JSON.stringify(rGood));
  d2.close();

  // ---- 4. 空令牌不应通过（免密关闭场景）----
  console.log("\n== 4. 空/缺省令牌被拒绝 ==");
  const d3 = await wsConnect(`ws://127.0.0.1:${PORT}/ws?role=device&name=Probe`);
  await readJson(d3, (m) => m.type === "welcome");
  const p3 = readJson(d3, (m) => m.type === "paired");
  d3.send({ type: "pair", token: "", name: "Probe" });
  const r3 = await p3;
  ok("空令牌被拒绝", !!r3 && r3.ok === false, JSON.stringify(r3));
  d3.close();

  // ---- 5. 局域网设备读不到 scan_token ----
  console.log("\n== 5. scan_token 只对本机可见 ==");
  // 从本机访问是 loopback，应当有 token；这里验证 /api/config 在非 loopback 下为空
  // （无法在单机模拟真实非 loopback 源地址，故只校验 loopback 下确实返回了 token，
  //  以及 /api/files 对非 loopback 不带 path 的既有约定不受影响）
  ok("本机（loopback）可见 scan_token", cfg.scan_token.length === 16);

  // ---- 6. 源码一致性：前端必须接收并保存服务端补发的密码 ----
  console.log("\n== 6. 客户端接收补发密码 ==");
  const client = fs.readFileSync(
    path.join(process.cwd(), "src-tauri", "web", "client.html"),
    "utf8"
  );
  ok("client.html: paired 分支处理 m.password",
     /m\.type === "paired"[\s\S]{0,400}m\.password/.test(client));
  ok("client.html: 收到密码后写入 pwd 变量", /pwd = String\(m\.password\)/.test(client));
  ok("client.html: 收到密码后落 sessionStorage",
     /sessionStorage\.setItem\("lanshare_pwd"/.test(client));
  ok("client.html: 只阻塞式提示，不再误报「未获取到连接密码」",
     !/未获取到连接密码/.test(client));

  const server = fs.readFileSync(
    path.join(process.cwd(), "src-tauri", "src", "server.rs"),
    "utf8"
  );
  ok("server.rs: 扫码配对分支补发 password",
     /if via_token[\s\S]{0,200}"password"/.test(server));
  ok("server.rs: 仅令牌路径补发（手动路径不回传）", /let via_token = st\.check_scan_token/.test(server));
  ok("server.rs: 上传 403 前排干 multipart",
     /check_password\(&st, &pwd\)[\s\S]{0,300}next_field\(\)\.await/.test(server));

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E 异常:", e); process.exit(1); });
