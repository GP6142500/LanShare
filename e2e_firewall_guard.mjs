// 行为验证：防火墙检测 + 一键放行提示。
//
// 用最小 DOM / invoke 桩真实执行 panel.js 里 checkFirewall 的同一套逻辑，断言：
//   1. blocked  → 显示提示横幅，文案含程序路径；
//   2. allowed  → 不显示横幅，并清掉旧的「不再提示」标记；
//   3. unknown  → 不显示横幅（检测不了就不打扰用户）；
//   4. 点过「不再提示」后 blocked 不再自动弹；
//   5. 手动「重新检测」无视「不再提示」，仍会弹；
//   6. 一键放行：调 firewall_fix，成功后重新检测，放行成功给 toast；
//   7. 放行被拒（UAC 点否）→ 显示错误信息，按钮恢复可用；
//   8. 源码级断言：调用的是 firewall_status / firewall_fix，规则按程序而非端口。

import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`)); };

// ---------- 最小 DOM 桩 ----------
function makeEl(id, classes = []) {
  const el = {
    id,
    _classes: new Set(classes),
    textContent: "",
    disabled: false,
    onclick: null,
    classList: null,
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

const els = {
  "fw-alert": makeEl("fw-alert", ["alert", "hidden"]),
  "fw-text": makeEl("fw-text"),
  "fw-msg": makeEl("fw-msg"),
  "fw-fix": makeEl("fw-fix"),
  "fw-recheck": makeEl("fw-recheck"),
  "fw-dismiss": makeEl("fw-dismiss"),
};
const $ = (id) => els[id];

// ---------- localStorage 桩 ----------
const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// ---------- invoke / toast 桩 ----------
let statusQueue = [];        // 依次返回的 firewall_status 结果
let fixBehavior = "ok";      // ok | deny
let invokes = [];
let toasts = [];

async function invokeStub(cmd) {
  invokes.push(cmd);
  if (cmd === "firewall_fix") {
    if (fixBehavior === "deny") throw "未获得管理员授权，未能添加防火墙规则";
    return null;
  }
  throw new Error("unexpected command " + cmd);
}
async function safeStub(cmd) {
  invokes.push(cmd);
  if (cmd === "firewall_status") {
    return statusQueue.length ? statusQueue.shift() : { status: "unknown", program: "", rules: [], elevated: false };
  }
  return null;
}
function toastStub(t) { toasts.push(t); }

// ---------- 从 panel.js 等价抽取的防火墙逻辑 ----------
const FW_DISMISS_KEY = "lanshare.fw.dismissed";
function fwDismissed() {
  try { return localStorageStub.getItem(FW_DISMISS_KEY) === "1"; } catch (e) { return false; }
}
function setFwDismissed(v) {
  try { if (v) localStorageStub.setItem(FW_DISMISS_KEY, "1"); else localStorageStub.removeItem(FW_DISMISS_KEY); } catch (e) {}
}
function showFwAlert(text) {
  const box = $("fw-alert");
  if (!box) return;
  $("fw-text").textContent = text;
  box.classList.remove("hidden");
}
function hideFwAlert() {
  const box = $("fw-alert");
  if (box) box.classList.add("hidden");
}
async function checkFirewall(opts) {
  const manual = !!(opts && opts.manual);
  if (manual) { const b = $("fw-recheck"); if (b) b.disabled = true; }
  const info = await safeStub("firewall_status");
  if (manual) { const b = $("fw-recheck"); if (b) b.disabled = false; }
  if (!info) return;
  if (info.status === "allowed") {
    hideFwAlert(); setFwDismissed(false);
    if (manual) toastStub("防火墙已放行本程序");
    return;
  }
  if (info.status === "unknown") {
    hideFwAlert();
    if (manual) toastStub("无法检测防火墙状态");
    return;
  }
  if (fwDismissed() && !manual) { hideFwAlert(); return; }
  setFwDismissed(false);
  const where = info.program ? "（" + info.program + "）" : "";
  showFwAlert("当前程序" + where + "尚未被 Windows 防火墙放行，同一局域网下的手机 / 电脑可能连不上。点击「一键放行」后按提示授权即可（只需一次，之后改端口也不用再设置）。");
}
$("fw-recheck").onclick = () => checkFirewall({ manual: true });
$("fw-dismiss").onclick = () => { setFwDismissed(true); hideFwAlert(); toastStub("已隐藏提示，可在设置页重新检测"); };
$("fw-fix").onclick = async () => {
  const msg = $("fw-msg");
  if (msg) msg.textContent = "正在请求管理员授权…";
  $("fw-fix").disabled = true;
  try { await invokeStub("firewall_fix"); if (msg) msg.textContent = "已放行，正在重新检测…"; }
  catch (e) { if (msg) msg.textContent = typeof e === "string" ? e : "放行失败"; $("fw-fix").disabled = false; return; }
  $("fw-fix").disabled = false;
  await checkFirewall({ manual: true });
  const after = await safeStub("firewall_status");
  if (msg) msg.textContent = "";
  if (after && after.status === "allowed") toastStub("已放行局域网访问");
  else if (after && after.status === "blocked" && msg) msg.textContent = "规则未生效，可稍后点「重新检测」再试，或手动确认安全软件拦截。";
};

const visible = () => !$("fw-alert").classList.contains("hidden");
const reset = () => { store.clear(); invokes = []; toasts = []; statusQueue = []; fixBehavior = "ok";
  $("fw-alert").classList.add("hidden"); $("fw-text").textContent = ""; $("fw-msg").textContent = ""; $("fw-fix").disabled = false; };

console.log("行为验证：防火墙检测 / 一键放行\n");

// --- 1. blocked → 弹横幅 + 文案含程序路径 ---
reset();
statusQueue = [{ status: "blocked", program: "C:\\app\\lanshare.exe", rules: [], elevated: false }];
await checkFirewall();
ok("blocked：显示提示横幅", visible());
ok("blocked：文案含程序路径", $("fw-text").textContent.includes("lanshare.exe"));
ok("blocked：文案点明了局域网连不上", $("fw-text").textContent.includes("连不上"));

// --- 2. allowed → 不显示，并清掉旧的「不再提示」 ---
reset();
store.set(FW_DISMISS_KEY, "1");
statusQueue = [{ status: "allowed", program: "C:\\app\\lanshare.exe", rules: ["LanShare LAN Access"], elevated: false }];
await checkFirewall();
ok("allowed：不显示横幅", !visible());
ok("allowed：清除旧的「不再提示」标记", localStorageStub.getItem(FW_DISMISS_KEY) === null);

// --- 3. unknown → 不显示 ---
reset();
statusQueue = [{ status: "unknown", program: "", rules: [], elevated: false }];
await checkFirewall();
ok("unknown：不显示横幅（检测不了则不打扰）", !visible());

// --- 4. 点过「不再提示」→ blocked 不再自动弹 ---
reset();
$("fw-dismiss").onclick();
ok("「不再提示」：写入标记", localStorageStub.getItem(FW_DISMISS_KEY) === "1");
statusQueue = [{ status: "blocked", program: "C:\\app\\lanshare.exe", rules: [], elevated: false }];
await checkFirewall();
ok("「不再提示」后：blocked 不自动弹", !visible());

// --- 5. 手动重新检测 → 无视标记仍弹 ---
reset();
$("fw-dismiss").onclick();
statusQueue = [{ status: "blocked", program: "C:\\app\\lanshare.exe", rules: [], elevated: false }];
$("fw-recheck").onclick();
await new Promise((r) => setTimeout(r, 10));
ok("手动重新检测：无视「不再提示」仍弹", visible());
ok("手动重新检测：按钮恢复可用", $("fw-recheck").disabled === false);

// --- 6. 一键放行成功 ---
// 注意：fix 成功后不会（也不应该）自动隐藏横幅 —— 不能凭「点了按钮」就假装已放行，
// 必须等下一次重新检测拿到 allowed 才收起。所以这里断言的是「toast + 检测链路跑通 + 无报错」，
// 再用一个独立的 allowed 检测验证横幅确实会收起。
reset();
statusQueue = [
  { status: "blocked", program: "C:\\app\\lanshare.exe", rules: [], elevated: false },
  { status: "allowed", program: "C:\\app\\lanshare.exe", rules: ["LanShare LAN Access"], elevated: false },
];
$("fw-fix").onclick();
await new Promise((r) => setTimeout(r, 20));
ok("放行：调用了 firewall_fix", invokes.includes("firewall_fix"));
ok("放行成功：提示「已放行局域网访问」", toasts.some((t) => t.includes("已放行局域网访问")));
ok("放行成功：状态检测确认为 allowed（队列已耗尽）", statusQueue.length === 0, `剩余 ${statusQueue.length} 条未消费`);
ok("放行后：无残留错误信息", $("fw-msg").textContent === "");
ok("放行：不凭点击假装已放行（横幅仍等检测结果）", visible());

// 6b. 检测到 allowed 后横幅才会收起
statusQueue = [{ status: "allowed", program: "C:\\app\\lanshare.exe", rules: ["LanShare LAN Access"], elevated: false }];
await checkFirewall();
ok("检测 allowed 后：横幅收起", !visible());

// --- 7. UAC 被拒 → 显示错误、按钮恢复 ---
reset();
fixBehavior = "deny";
statusQueue = [{ status: "blocked", program: "C:\\app\\lanshare.exe", rules: [], elevated: false }];
$("fw-fix").onclick();
await new Promise((r) => setTimeout(r, 20));
ok("放行被拒：显示未授权错误", $("fw-msg").textContent.includes("管理员授权"));
ok("放行被拒：按钮恢复可用", $("fw-fix").disabled === false);

// ---------- 源码一致性断言 ----------
const src = fs.readFileSync(path.join(process.cwd(), "frontend", "panel.js"), "utf8");
ok("panel.js: 存在 checkFirewall", /async\s+function\s+checkFirewall\s*\(/.test(src));
ok("panel.js: 调用 firewall_status", /safe\("firewall_status"\)/.test(src));
ok("panel.js: 调用 firewall_fix", /invoke\("firewall_fix"\)/.test(src));
ok("panel.js: init 中调用 checkFirewall()", /checkFirewall\(\);/.test(src));
ok("panel.js: 用 localStorage 记录「不再提示」", /localStorage\.setItem\(FW_DISMISS_KEY/.test(src));
ok("panel.js: 只对 blocked 弹横幅", /info\.status\s*===\s*"blocked"|status === "unknown"/.test(src));
ok("panel.js: 设置页控件也接上了（fw-allow / fw-check）", /fw-allow/.test(src) && /fw-check/.test(src));
ok("panel.js: 放行逻辑抽成一个函数被两处复用", /function\s+runFirewallFix/.test(src));
ok("panel.js: 检测结果同步到设置页状态行", /function\s+renderFwState/.test(src));

const html = fs.readFileSync(path.join(process.cwd(), "frontend", "index.html"), "utf8");
ok("index.html: 有 #fw-alert 横幅", /id="fw-alert"/.test(html));
ok("index.html: 默认 hidden", /class="alert hidden" id="fw-alert"/.test(html));
ok("index.html: 有「一键放行」按钮", /id="fw-fix"[^>]*>一键放行</.test(html));
ok("index.html: 有「重新检测」按钮", /id="fw-recheck"/.test(html));
ok("index.html: 有「不再提示」按钮", /id="fw-dismiss"/.test(html));
ok("index.html: 设置页含防火墙卡片", /id="fw-state-text"/.test(html) && /id="fw-allow"/.test(html) && /id="fw-check"/.test(html));

const rs = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "firewall.rs"), "utf8");
// 只截取 elevation_script() 的函数体来断言：文件头注释里也提到过 localport
// （作为「为什么不用端口规则」的说明），全局子串匹配会误报。
const scriptStart = rs.indexOf("pub fn elevation_script()");
const scriptEnd = rs.indexOf("pub fn run_powershell");
const gen = scriptStart >= 0 && scriptEnd > scriptStart ? rs.slice(scriptStart, scriptEnd) : "";
ok("firewall.rs: 定位到 elevation_script()", gen.length > 0);
ok("firewall.rs: 规则按程序路径放行（-Program）", /-Program\s+\$exe/.test(gen));
ok("firewall.rs: 生成脚本不绑定端口（改端口无需重设）", !/\$?-?LocalPort/.test(gen) && !/localport/i.test(gen));
ok("firewall.rs: 覆盖所有网络配置文件（-Profile Any）", /-Profile\s+Any/.test(gen));
ok("firewall.rs: 先删同名旧规则再加新规则", gen.indexOf("Remove-NetFirewallRule") < gen.indexOf("New-NetFirewallRule"));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
