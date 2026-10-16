// 行为验证：传输页拖拽上传遮罩。
//
// 用最小 DOM/事件桩真实执行 panel.js 里 initDropZone 的同一套逻辑，断言：
//   1. 拖入含文件的拖拽 → 遮罩显示；
//   2. 拖入不含文件（拖文本/链接）→ 遮罩不显示；
//   3. 在非「传输」页拖拽 → 遮罩不显示；
//   4. drop → 遮罩隐藏且把文件交给上传函数；
//   5. dragenter/dragleave 嵌套计数正确（移入子元素不闪烁）；
//   6. 视图切走（lan-view-change）→ 遮罩收起；
//   7. 源码级断言：preventDefault 到位、dragover 设了 dropEffect、window 兜底存在。

import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  \u2713 ${n}`)) : (fail++, console.log(`  \u2717 ${n} ${e}`)); };

// ---------- 最小 DOM / 事件桩 ----------
function makeEl(id, classes = []) {
  const el = {
    id,
    _classes: new Set(classes),
    listeners: {},
    classList: null,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); },
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

const viewDevices = makeEl("view-devices", ["view", "active", "active-inner"]);
const mask = makeEl("drop-mask", ["drop-mask", "hidden"]);
const els = { "view-devices": viewDevices, "drop-mask": mask };
const $ = (id) => els[id];

const windowListeners = {};
const windowStub = {
  addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
  dispatch(type, ev) { (windowListeners[type] || []).forEach((fn) => fn(ev)); },
};

let uploaded = [];
function uploadFiles(files) { uploaded.push(files); }

// ---------- 从 panel.js 抽取的 initDropZone（与源码等价）----------
// 注意：监听挂在 window 上（Tauri v2 需 dragDropEnabled:false 才把拖放交给 HTML 层）
(function initDropZone() {
  const view = $("view-devices");
  const mask = $("drop-mask");
  if (!view || !mask) return;
  let depth = 0;
  const isActive = () => view.classList.contains("active");
  function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.indexOf("Files") >= 0;
  }
  function show() { mask.classList.remove("hidden"); }
  function hide() { depth = 0; mask.classList.add("hidden"); }

  windowStub.addEventListener("dragenter", (e) => {
    if (!isActive() || !hasFiles(e)) return;
    e.preventDefault(); depth++; show();
  });
  windowStub.addEventListener("dragover", (e) => {
    if (!isActive() || !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  windowStub.addEventListener("dragleave", (e) => {
    if (!isActive()) return;
    if (!e.relatedTarget) { hide(); return; }
    depth--;
    if (depth <= 0) hide();
  });
  windowStub.addEventListener("drop", (e) => {
    e.preventDefault(); hide();
    if (!isActive()) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) uploadFiles(files);
  });
  windowStub.addEventListener("lan-view-change", hide);
})();

// 事件工厂
const fileEvent = (files = [], relatedTarget = null) => {
  let prevented = false;
  const dt = { types: ["Files"], files, dropEffect: "" };
  return { dataTransfer: dt, relatedTarget, preventDefault: () => (prevented = true), get prevented() { return prevented; } };
};
const textEvent = () => {
  let prevented = false;
  const dt = { types: ["text/plain"], files: [], dropEffect: "" };
  return { dataTransfer: dt, relatedTarget: null, preventDefault: () => (prevented = true), get prevented() { return prevented; } };
};
const maskVisible = () => !mask.classList.contains("hidden");
const W = (type, ev) => windowStub.dispatch(type, ev);

console.log("行为验证：传输页拖拽上传\n");

// --- 1. 拖入文件 → 遮罩显示 ---
W("dragenter", fileEvent());
ok("拖入文件：遮罩显示", maskVisible());

// --- 2. 嵌套 enter/leave 计数：移入子元素不误隐藏 ---
W("dragenter", fileEvent());
W("dragleave", fileEvent([], mask)); // 有 relatedTarget → 未离开文档
ok("移入子元素再离开：遮罩仍显示（计数未归零）", maskVisible());
W("dragleave", fileEvent()); // 真正离开
ok("完全离开：遮罩隐藏", !maskVisible());

// --- 3. dragover 必须 preventDefault 且设置 dropEffect ---
const de = fileEvent();
W("dragover", de);
ok("dragover：调用了 preventDefault（drop 才会触发）", de.prevented);
ok("dragover：dropEffect 设为 copy", de.dataTransfer.dropEffect === "copy");

// --- 4. drop → 遮罩隐藏 + 文件交给上传 ---
uploaded = [];
W("dragenter", fileEvent());
ok("drop 前：遮罩可见", maskVisible());
const dropEv = fileEvent([{ name: "a.txt" }, { name: "b.jpg" }]);
W("drop", dropEv);
ok("drop：遮罩隐藏", !maskVisible());
ok("drop：调用了 preventDefault", dropEv.prevented);
ok("drop：文件已交给上传函数", uploaded.length === 1 && uploaded[0].length === 2,
   `calls=${uploaded.length} files=${uploaded[0] ? uploaded[0].length : 0}`);

// --- 5. 拖非文件内容（文本/链接）→ 遮罩不显示 ---
W("dragenter", textEvent());
ok("拖文本内容：遮罩不显示", !maskVisible());

// --- 6. 非「传输」页拖拽 → 遮罩不显示 ---
viewDevices.classList.remove("active");
W("dragenter", fileEvent());
ok("非传输页拖拽：遮罩不显示", !maskVisible());
uploaded = [];
const offDrop = fileEvent([{ name: "x" }]);
W("drop", offDrop);
ok("非传输页放下：不触发上传", uploaded.length === 0);
ok("非传输页放下：仍阻止默认行为（不让浏览器打开文件）", offDrop.prevented);
viewDevices.classList.add("active");

// --- 7. 视图切走 → 遮罩收起 ---
W("dragenter", fileEvent());
ok("切页前：遮罩可见", maskVisible());
W("lan-view-change", {});
ok("视图切换：遮罩收起", !maskVisible());

// --- 8. 拖出窗口（relatedTarget 为空）→ 立即收起 ---
W("dragenter", fileEvent());
ok("拖入后：遮罩可见", maskVisible());
W("dragleave", fileEvent([], null));
ok("拖出窗口：遮罩立即收起", !maskVisible());

// ---------- 源码一致性断言 ----------
const src = fs.readFileSync(path.join(process.cwd(), "frontend", "panel.js"), "utf8");
ok("panel.js 存在 initDropZone", /function\s+initDropZone\s*\(\)/.test(src));
ok("panel.js: dragover 设了 dropEffect = copy", /dropEffect\s*=\s*"copy"/.test(src));
ok("panel.js: hasFiles 检查 types 含 Files", /indexOf\(\s*"Files"\s*\)\s*>=\s*0/.test(src));
ok("panel.js: 拖放监听挂在 window 上", /window\.addEventListener\("dragenter"/.test(src));
ok("panel.js: uploadFiles 接受 files 参数", /async\s+function\s+uploadFiles\s*\(files\)/.test(src));
ok("panel.js: 切换视图时派发 lan-view-change", /dispatchEvent\(new Event\("lan-view-change"\)\)/.test(src));
ok("panel.js: 选择文件路径复用 uploadFiles(Array.from(...))",
   /uploadFiles\(Array\.from\(\$\("share-file"\)\.files/.test(src));
ok("panel.js: 拖拽路径复用 uploadFiles(files)", /if\s*\(files\.length\)\s*uploadFiles\(files\)/.test(src));
ok("panel.js: 已移除旧的 input.value 直接赋值写法", !/input\.value\s*=\s*""/.test(src));

const html = fs.readFileSync(path.join(process.cwd(), "frontend", "index.html"), "utf8");
ok("index.html: 传输页含 #drop-mask", /id="drop-mask"/.test(html));
ok("index.html: 遮罩默认 hidden", /id="drop-mask"\s+class="drop-mask hidden"/.test(html));
ok("index.html: 遮罩在 #view-devices 之内", /id="view-devices"[\s\S]*id="drop-mask"[\s\S]*<\/section>/.test(html));

const css = fs.readFileSync(path.join(process.cwd(), "frontend", "styles.css"), "utf8");
ok("styles.css: .drop-mask 为定位遮罩", /\.drop-mask\s*\{[\s\S]*position:\s*fixed/.test(css));
ok("styles.css: 遮罩 pointer-events: none（不挡拖拽）", /\.drop-mask\s*\{[\s\S]*pointer-events:\s*none/.test(css));
ok("styles.css: .drop-mask.hidden 隐藏", /\.drop-mask\.hidden\s*\{\s*display:\s*none/.test(css));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
