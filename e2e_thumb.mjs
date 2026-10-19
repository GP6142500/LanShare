// 端到端：缩略图接口 /api/thumb/:id
//
// 覆盖点：
//   - 真实上传一张 800x600 的 PNG，服务端能生成 320px 内的 JPEG 缩略图
//   - /api/files 带 ext 字段（前端靠它决定「放缩略图」还是「画类型徽章」）
//   - 缓存落盘到 <配置目录>/thumbs/，二次请求命中缓存且内容一致
//   - 小图不被放大（thumbnail 只缩不放）
//   - 非图片 / 错密码 / 不存在的 id 分别返回 404 / 403 / 404
//
// 图片由本脚本用 zlib 直接拼 PNG（无第三方依赖）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法：node e2e_thumb.mjs <lanshare.exe>");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanshare-thumb-"));
const CFG = path.join(TMP, "lanshare");
const STORE = path.join(TMP, "store");
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });

const PORT = 18952;
const PWD = "135790";
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

// ---------- 生成一张真 PNG ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/// 生成 w×h 的彩色渐变 RGB PNG（体积小、内容可辨）
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[p++] = Math.floor((x / w) * 255);
      raw[p++] = Math.floor((y / h) * 255);
      raw[p++] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// 从 JPEG 字节里读出宽高（遍历 marker 找 SOF0/SOF2）
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof =
      (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf);
    if (isSof) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
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
  console.log("端到端：缩略图接口\n");
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
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
    process.exit(1);
  }

  // ---- 准备文件 ----
  ok("上传 800x600 PNG 成功", await upload("大图.png", makePng(800, 600)));
  ok("上传 32x32 PNG 成功", await upload("小图.png", makePng(32, 32)));
  ok("上传 txt（非图片）成功", await upload("说明.txt", Buffer.from("hello")));

  const list = await (await fetch(`${BASE}/api/files?pwd=${encodeURIComponent(PWD)}`)).json();
  const files = list.files || list.history || [];
  ok("文件列表返回 3 个条目", files.length === 3, `count=${files.length}`);

  const big = files.find((f) => f.name === "大图.png");
  const small = files.find((f) => f.name === "小图.png");
  const txt = files.find((f) => f.name === "说明.txt");
  ok("条目带 ext 字段（png）", big && big.ext === "png", JSON.stringify(big));
  ok("条目带 ext 字段（txt）", txt && txt.ext === "txt", JSON.stringify(txt));

  const thumbUrl = (f) => `${BASE}/api/thumb/${encodeURIComponent(f.id)}?pwd=${encodeURIComponent(PWD)}&v=${f.mtime}`;

  // ---- 大图：生成缩略图 ----
  const r1 = await fetch(thumbUrl(big));
  ok("缩略图请求返回 200", r1.status === 200, `status=${r1.status}`);
  ok("Content-Type 为 image/jpeg", (r1.headers.get("content-type") || "").includes("image/jpeg"),
     r1.headers.get("content-type"));
  const jpg1 = Buffer.from(await r1.arrayBuffer());
  ok("返回的是 JPEG（FF D8 FF）", jpg1.length > 3 && jpg1[0] === 0xff && jpg1[1] === 0xd8 && jpg1[2] === 0xff);
  const dim = jpegSize(jpg1);
  ok("缩略图尺寸 = 320x240（按最长边等比缩到 320）",
     dim && dim.w === 320 && dim.h === 240, JSON.stringify(dim));
  ok("体积明显小于原图（约几十 KB）", jpg1.length > 500 && jpg1.length < 80 * 1024, `${jpg1.length} B`);

  // ---- 缓存 ----
  const thumbDir = path.join(CFG, "thumbs");
  const cached = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir) : [];
  ok("缓存目录已写入该文件的缩略图",
     cached.some((n) => n.startsWith(big.id + "-")), cached.join(", "));

  const r2 = await fetch(thumbUrl(big));
  const jpg2 = Buffer.from(await r2.arrayBuffer());
  ok("二次请求命中缓存且内容一致", r2.status === 200 && jpg2.equals(jpg1));
  ok("缓存命中响应带长缓存头",
     (r2.headers.get("cache-control") || "").includes("immutable"), r2.headers.get("cache-control"));

  // ---- 小图不放大 ----
  const rs = await fetch(thumbUrl(small));
  const js = Buffer.from(await rs.arrayBuffer());
  const dimSmall = jpegSize(js);
  ok("32x32 小图不被放大", dimSmall && dimSmall.w <= 32 && dimSmall.h <= 32, JSON.stringify(dimSmall));

  // ---- 负例 ----
  const rTxt = await fetch(thumbUrl(txt));
  ok("非图片返回 404（前端据此画类型徽章）", rTxt.status === 404, `status=${rTxt.status}`);

  const rBadPwd = await fetch(`${BASE}/api/thumb/${encodeURIComponent(big.id)}?pwd=000000`);
  ok("密码错误返回 403", rBadPwd.status === 403, `status=${rBadPwd.status}`);

  const rMissing = await fetch(`${BASE}/api/thumb/not-a-real-id?pwd=${encodeURIComponent(PWD)}`);
  ok("不存在的 id 返回 404", rMissing.status === 404, `status=${rMissing.status}`);

  // ---- 删除文件后缓存应被清掉 ----
  const del = await fetch(`${BASE}/api/file/${encodeURIComponent(big.id)}?pwd=${encodeURIComponent(PWD)}`, {
    method: "DELETE",
  });
  ok("删除文件成功", del.ok, `status=${del.status}`);
  await sleep(200);
  const after = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir) : [];
  ok("删除文件后对应缩略图缓存被清理",
     !after.some((n) => n.startsWith(big.id + "-")), after.join(", "));

  child.kill();
  await sleep(600);
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // exe 刚退出时 Windows 可能还占着句柄；清理失败不影响测试结论
    console.log(`  （临时目录未能删除，可手动清理：${TMP}）`);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常：", e);
  process.exit(1);
});
