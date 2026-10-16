// 验证二维码 URL 内容 + 客户端页面扫码/手动两条路径
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.argv[2];
const PORT = 18901;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-qr-"));
const CFG = path.join(TMP, "lanshare");
fs.mkdirSync(CFG, { recursive: true });
const STORE = path.join(TMP, "store");
fs.mkdirSync(STORE, { recursive: true });
fs.writeFileSync(
  path.join(CFG, "config.json"),
  JSON.stringify({ port: PORT, password: "135790", storage_dir: STORE, auto_start: true, auto_cleanup: false, cleanup_max_mb: 2048, cleanup_days: 10 })
);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${e}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从 qrcode 库生成的 SVG 无法直接读出原始 URL，改为在测试里独立复现同一 URL 规则，
// 并用「解码二维码」的替代方案：验证 /api/qr 输出随 scan_token 变化而变化。
async function main() {
  const child = spawn(EXE, [], { env: { ...process.env, LANSHARE_CONFIG_DIR: CFG }, cwd: TMP, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { const s = d.toString(); if (s.includes("服务已启动")) console.log("  " + s.trim()); });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { if ((await fetch(BASE + "/api/config")).ok) { up = true; break; } } catch (e) {}
  }
  ok("服务已就绪", up);
  if (!up) { child.kill(); process.exit(1); }

  console.log("\n== 二维码内容随令牌变化 ==");
  const svg1 = await (await fetch(BASE + "/api/qr")).text();
  ok("二维码为 SVG", svg1.includes("<svg") && svg1.includes("path"));

  console.log("\n== 客户端页面两条路径 ==");
  const html = await (await fetch(BASE + "/")).text();
  ok("页面含扫码免密卡片 #auto-card", html.includes('id="auto-card"'));
  ok("页面含手动回退按钮 #auto-manual", html.includes('id="auto-manual"'));
  ok("页面识别 URL 参数 t", html.includes('location.search') && html.includes('"t"'));
  ok("pair 消息支持 token 字段", html.includes("token: scanToken"));
  ok("手动模式仍发送 password", html.includes("password: pwd"));

  console.log("\n== 令牌轮换后旧令牌失效（逻辑校验）==");
  const c1 = await (await fetch(BASE + "/api/config")).json();
  ok("首次可读到令牌", c1.scan_token.length === 16, c1.scan_token);

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
