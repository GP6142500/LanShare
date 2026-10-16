// 端到端：端口修改 → 重启 → 端口稳定不漂移，且未被回退逻辑改写。
//
// 复现用户现场：改了端口 → 点「立即重启」→ 新进程应当绑定到新端口；
// 若旧 socket 仍在 TIME_WAIT 导致绑定失败，start() 会回退到随机端口并回写配置，
// 界面就会又显示「端口已修改，重启后生效」。SO_REUSEADDR 修复后应不再发生。
//
// 用法：node e2e_restart_port_stable.mjs <lanshare.exe 路径>

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法：node e2e_restart_port_stable.mjs <lanshare.exe>");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-restart-"));
const CFG = path.join(TMP, "lanshare");
const STORE = path.join(TMP, "store");
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const PORT_A = 18931;
const PORT_B = 18932;

// 预置：密码合法、端口为 A、目录存在
fs.writeFileSync(
  path.join(CFG, "config.json"),
  JSON.stringify(
    {
      port: PORT_A,
      password: "246810",
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
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startApp() {
  const child = spawn(EXE, [], {
    env: { ...process.env, LANSHARE_CONFIG_DIR: CFG },
    cwd: TMP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (/实际监听端口|绑定失败|服务已启动/.test(s)) process.stderr.write("[app] " + s);
  });
  return child;
}

async function reachable(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitReachable(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await reachable(port)) return true;
    await sleep(300);
  }
  return false;
}

function readCfg() {
  return JSON.parse(fs.readFileSync(path.join(CFG, "config.json"), "utf8"));
}

async function main() {
  console.log("端到端：重启后端口应稳定\n");

  // --- 阶段 1：以端口 A 启动 ---
  let child = startApp();
  const upA = await waitReachable(PORT_A);
  ok("首次启动：服务在配置端口 A 上就绪", upA, `port=${PORT_A}`);
  if (!upA) { child.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); }
  ok("首次启动：落盘端口仍为 A", readCfg().port === PORT_A, `got=${readCfg().port}`);

  // --- 阶段 2：改配置为端口 B（模拟用户在设置页修改并保存）---
  const c = readCfg();
  c.port = PORT_B;
  fs.writeFileSync(path.join(CFG, "config.json"), JSON.stringify(c, null, 2));
  ok("修改后：落盘端口为 B（尚未重启，服务仍在 A）", readCfg().port === PORT_B);
  ok("修改后：A 仍可访问（未热切）", await reachable(PORT_A));

  // --- 阶段 3：退出并用新配置重启（等价于点「立即重启」）---
  child.kill();
  await sleep(1200); // 留出 socket 关闭 / TIME_WAIT 窗口
  ok("旧进程退出后：A 已不可访问", !(await reachable(PORT_A)));

  child = startApp();
  const upB = await waitReachable(PORT_B);
  ok("重启后：服务在端口 B 上就绪（端口未被回退）", upB, `port=${PORT_B}`);

  // --- 关键断言：端口没有被回退逻辑改写 ---
  const after = readCfg();
  ok(
    "重启后：config.json 的端口仍是 B（未被回退改写）",
    after.port === PORT_B,
    `got=${after.port}`
  );
  ok("重启后：接收目录未被改动", after.storage_dir === STORE, `got=${after.storage_dir}`);

  // --- 阶段 4：连续再重启两次，端口必须始终稳定在 B ---
  for (let i = 1; i <= 2; i++) {
    child.kill();
    await sleep(900);
    child = startApp();
    const up = await waitReachable(PORT_B, 12000);
    const p = readCfg().port;
    ok(`第 ${i} 次连续重启：端口仍稳定为 B`, up && p === PORT_B, `port=${p} up=${up}`);
  }

  child.kill();
  await sleep(400);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常：", e);
  process.exit(1);
});
