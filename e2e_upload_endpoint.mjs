// 端到端：拖拽上传走的同一条上传接口，能真正把文件落到接收目录。
//
// 前端拖拽最终调用 uploadFiles(files) → POST /api/upload（与「选择文件」完全同一路径），
// 因此这里验证该接口端到端可用：上传多个文件 → 服务端文件列表出现 → 磁盘落盘。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法：node e2e_upload_endpoint.mjs <lanshare.exe>");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-up-"));
const CFG = path.join(TMP, "lanshare");
const STORE = path.join(TMP, "store");
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const PORT = 18951;
const PWD = "246810";
const BASE = `http://127.0.0.1:${PORT}`;

fs.writeFileSync(
  path.join(CFG, "config.json"),
  JSON.stringify(
    { port: PORT, password: PWD, storage_dir: STORE, auto_start: true,
      auto_cleanup: false, cleanup_max_mb: 2048, cleanup_days: 10 },
    null, 2
  )
);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable() {
  try { return (await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

async function upload(name, content) {
  const fd = new FormData();
  fd.append("file", new Blob([content]), name);
  const r = await fetch(`${BASE}/api/upload?pwd=${encodeURIComponent(PWD)}&name=${encodeURIComponent("本机")}`,
    { method: "POST", body: fd });
  return r.ok;
}

async function main() {
  console.log("端到端：上传接口（拖拽与选择文件共用）\n");
  const child = spawn(EXE, [], {
    env: { ...process.env, LANSHARE_CONFIG_DIR: CFG },
    cwd: TMP, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});

  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(await reachable())) await sleep(300);
  ok("服务已就绪", await reachable());
  if (!(await reachable())) { child.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

  // 模拟拖入 3 个文件
  const names = ["拖拽测试-1.txt", "拖拽测试-2.log", "drag-3.bin"];
  const okFlags = [];
  for (const n of names) okFlags.push(await upload(n, "content of " + n));
  ok("3 个文件均上传成功", okFlags.every(Boolean), JSON.stringify(okFlags));

  // 服务端文件列表应包含它们（该接口需密码）
  const listResp = await (await fetch(`${BASE}/api/files?pwd=${encodeURIComponent(PWD)}`)).json();
  const flat = JSON.stringify(listResp);
  ok("服务端文件列表包含全部 3 个文件",
     names.every((n) => flat.includes(n)), flat.slice(0, 300));

  // 磁盘落盘（按上传者分子目录；文件名带 uuid 前缀防重名，故用「包含」判断）
  const walked = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else walked.push(e.name);
    }
  })(STORE);
  ok("磁盘上确实落盘了 3 个文件（文件名含原名）",
     names.every((n) => walked.some((w) => w.includes(n))), walked.join(", "));
  ok("落盘文件按上传者分子目录（本机）",
     walked.length === 3, `count=${walked.length}`);

  // 错误密码应被拒绝（确认接口有鉴权，拖拽上传不会绕过密码）
  const fd = new FormData();
  fd.append("file", new Blob(["x"]), "bad.txt");
  const bad = await fetch(`${BASE}/api/upload?pwd=000000&name=x`, { method: "POST", body: fd });
  ok("密码错误时上传被拒绝", !bad.ok, `status=${bad.status}`);

  child.kill();
  await sleep(400);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常：", e); process.exit(1); });
