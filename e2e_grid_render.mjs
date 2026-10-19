// 端到端：控制面板的「缩略图网格」视图（真实浏览器渲染）
//
// 与 e2e_thumb.mjs 的分工：
//   e2e_thumb.mjs        只验证后端接口（生成 / 缓存 / 鉴权 / 清理）
//   e2e_grid_render.mjs  验证前端真的把卡片画出来了 —— 真实 Edge 无头渲染，
//                        数据来自真实服务、缩略图也是真的 HTTP 请求
//
// 做法：把 frontend/index.html 复制成临时 fixture，注入 __TAURI__ / __LAN_PORT
// 打桩，再把 styles.css / panel.js 指向真实文件；用 --dump-dom 取渲染后的 DOM。
// Edge 的 --virtual-time-budget 会快进 panel.js 里的 setTimeout(refreshFiles, 800)。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法：node e2e_grid_render.mjs <lanshare.exe>");
  process.exit(2);
}

// 脚本自身所在目录就是仓库根（本文件放在仓库根）
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error("未找到 Microsoft Edge，无法运行浏览器渲染测试");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-grid-"));
const CFG = path.join(TMP, "lanshare");
const STORE = path.join(TMP, "store");
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const PORT = 18953;
const PWD = "864209";
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

// ---------- 生成小尺寸 PNG（够用即可，重点是数量与类型） ----------
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
      raw[p++] = 150;
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
    `${BASE}/api/upload?pwd=${encodeURIComponent(PWD)}&name=${encodeURIComponent("平板")}`,
    { method: "POST", body: fd }
  );
  return r.ok;
}

const toFileUrl = (p) => "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "");

/// 复制真实 index.html，注入打桩脚本，资源指向真实文件
function makeFixture() {
  const idx = fs.readFileSync(path.join(ROOT, "frontend", "index.html"), "utf8");
  const cfg = {
    port: PORT,
    password: PWD,
    storage_dir: STORE,
    auto_start: true,
    auto_cleanup: false,
    cleanup_max_mb: 2048,
    cleanup_days: 10,
  };
  const stub = `<script>
window.__LAN_PORT = ${PORT};
window.__TAURI__ = { core: { invoke: async function (name) {
  if (name === "get_config") return ${JSON.stringify(cfg)};
  if (name === "app_info") return { version: "0.1.0", built_epoch: 0, config_dir: "", program: "" };
  if (name === "firewall_status") return { status: "allowed", program: "", rules: [], elevated: false };
  if (name === "list_devices") return [];
  return null;
} } };
// 截图用：加载后自动切到「历史」页，让 --screenshot 拍到网格卡片
window.addEventListener("load", function () {
  setTimeout(function () {
    var b = document.querySelector('.nav-item[data-view="history"]');
    if (b) b.click();
  }, 50);
});
</script>`;
  let out = idx.replace("<head>", "<head>\n" + stub);
  out = out.replace('href="styles.css"', `href="${toFileUrl(path.join(ROOT, "frontend", "styles.css"))}"`);
  out = out.replace('src="panel.js"', `src="${toFileUrl(path.join(ROOT, "frontend", "panel.js"))}"`);
  const p = path.join(TMP, "fixture.html");
  fs.writeFileSync(p, out);
  return p;
}

/// 跑一次无头 Edge，返回 { dom, png }
function runEdge(url, { dump = true, shot = "" } = {}) {
  return new Promise((resolve) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${path.join(TMP, "edge-" + Math.random().toString(36).slice(2, 8))}`,
      "--window-size=1180,900",
      "--virtual-time-budget=9000",
    ];
    if (dump) args.push("--dump-dom");
    if (shot) args.push(`--screenshot=${shot}`);
    args.push(url);
    const c = spawn(EDGE, args, { stdio: ["ignore", "pipe", "pipe"] });
    let dom = "";
    c.stdout.on("data", (d) => (dom += d.toString("utf8")));
    c.stderr.on("data", () => {});
    c.on("close", () => resolve({ dom }));
  });
}

const countOf = (s, re) => (s.match(re) || []).length;

/// 从整页 DOM 里截出某个列表容器的片段。
/// 传输页与历史页各有一个列表，两者的卡片结构相同 —— 必须分开统计，
/// 否则「3 个文件」会被数成 6。
function sliceContainer(dom, id) {
  const i = dom.indexOf(`id="${id}"`);
  if (i < 0) return "";
  const end = dom.indexOf("</section>", i);
  return end > 0 ? dom.slice(i, end) : dom.slice(i, i + 8000);
}

async function main() {
  console.log("端到端：缩略图网格视图渲染\n");
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

  // 两张图片 + 一个非图片，正好覆盖「缩略图」与「类型徽章」两条分支
  ok("上传 2 张图片 + 1 个文本",
     (await upload("风景.png", makePng(600, 400))) &&
     (await upload("截图.png", makePng(400, 600))) &&
     (await upload("报告.txt", Buffer.from("plain text"))));

  const fixture = makeFixture();

  // ---- 网格视图 ----
  const { dom: grid } = await runEdge(toFileUrl(fixture) + "?view=grid");
  console.log(`  （DOM 长度 ${grid.length}）`);
  const gTx = sliceContainer(grid, "file-list"); // 传输页
  const gHist = sliceContainer(grid, "history-list"); // 历史页

  ok("容器带 grid class（切换生效）", /class="list grid"/.test(grid), grid.slice(0, 200));
  ok("传输页渲染出 3 张文件卡片", countOf(gTx, /class="card-item"/g) === 3,
     `count=${countOf(gTx, /class="card-item"/g)}`);
  ok("历史页同样渲染出 3 张卡片", countOf(gHist, /class="card-item"/g) === 3,
     `count=${countOf(gHist, /class="card-item"/g)}`);
  ok("两张图片走 <img> 缩略图分支", countOf(gTx, /\/api\/thumb\//g) === 2,
     `count=${countOf(gTx, /\/api\/thumb\//g)}`);
  ok("缩略图 URL 带密码与版本号",
     /\/api\/thumb\/[^"?]+\?pwd=[^"&]+&(?:amp;)?v=\d+/.test(gTx), gTx.slice(0, 400));
  ok("文本文件退化为类型徽章", countOf(gTx, /class="ext-badge xt-text"/g) === 1,
     `count=${countOf(gTx, /class="ext-badge xt-text"/g)}`);
  ok("徽章文字为 TXT", />TXT</.test(gTx));
  ok("卡片带文件名", gTx.includes("风景.png") && gTx.includes("截图.png") && gTx.includes("报告.txt"));
  ok("设备名徽标只出现在历史页卡片上",
     gHist.includes("平板") && !gTx.includes('class="ci-up"'));
  ok("切换按钮处于 grid 选中态",
     /class="vt-btn active"[^>]*data-mode="grid"|data-mode="grid"[^>]*class="vt-btn active"/.test(grid));

  // ---- 列表视图（同一份数据，另一种渲染） ----
  const { dom: list } = await runEdge(toFileUrl(fixture) + "?view=list");
  const lTx = sliceContainer(list, "file-list");
  const lHist = sliceContainer(list, "history-list");
  ok("列表视图不出现卡片", countOf(list, /class="card-item"/g) === 0);
  ok("传输页渲染出 3 行", countOf(lTx, /class="item clickable"/g) === 3,
     `count=${countOf(lTx, /class="item clickable"/g)}`);
  ok("历史页渲染出 3 行", countOf(lHist, /class="item clickable"/g) === 3,
     `count=${countOf(lHist, /class="item clickable"/g)}`);
  ok("列表视图不请求缩略图", countOf(list, /\/api\/thumb\//g) === 0);
  ok("切换按钮处于 list 选中态",
     /data-mode="list"[^>]*class="vt-btn active"|class="vt-btn active"[^>]*data-mode="list"/.test(list));

  // ---- 截图（人工核对视觉） ----
  const shot = path.join(ROOT, "grid-view-preview.png");
  await runEdge(toFileUrl(fixture) + "?view=grid", { dump: false, shot });
  ok("已生成截图 grid-view-preview.png", fs.existsSync(shot) && fs.statSync(shot).size > 5000);

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
