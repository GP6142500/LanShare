// LanShare 控制面板逻辑（主机端，role=host）
(function () {
  let serverPort = window.__LAN_PORT || 18765;
  let hostPassword = "";
  let cfg = { port: serverPort, password: "", storage_dir: "", auto_start: true };
  let ws = null;
  let wantConnect = false;
  let retry = null;

  const $ = (id) => document.getElementById(id);

  async function invoke(name, args) {
    if (window.__TAURI__ && window.__TAURI__.core) {
      return await window.__TAURI__.core.invoke(name, args || {});
    }
    return null;
  }
  async function safe(name, args) {
    try {
      return await invoke(name, args);
    } catch (e) {
      console.error("[invoke]", name, e);
      return null;
    }
  }

  function base() {
    return `http://127.0.0.1:${serverPort}`;
  }

  // ----------------- 导航切换 -----------------
  function switchView(name) {
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const target = $("view-" + name);
    if (target) target.classList.add("active");
    // 传输页可见后才能测量左卡高度（隐藏时 offsetHeight 为 0）
    if (name === "devices") requestAnimationFrame(syncTxMinHeight);
  }
  function initNav() {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.onclick = () => switchView(btn.dataset.view);
    });
  }

  // ----------------- 传输页等高（右卡以左卡高度为最小高度，右侧扩展不拉动左侧） -----------------
  function syncTxMinHeight() {
    const split = $("tx-split");
    const left = $("text-card");
    if (!split || !left) return;
    // 左侧需可见时才有有效高度
    if (!left.offsetHeight) return;
    split.style.setProperty("--tx-min-h", left.offsetHeight + "px");
  }
  function watchTxMinHeight() {
    syncTxMinHeight();
    window.addEventListener("resize", syncTxMinHeight);
    // 文本卡片内容/字号变化时重新测量
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => syncTxMinHeight());
      const left = $("text-card");
      if (left) ro.observe(left);
    }
  }

  // ----------------- Toast -----------------
  let toastTimer = null;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  // ----------------- 服务状态 -----------------
  function setServiceUI(running) {
    $("svc-dot").className = "dot " + (running ? "on" : "off");
    $("side-dot").className = "dot " + (running ? "on" : "off");
    $("svc-text").textContent = running ? "服务运行中" : "服务已停止";
    $("side-text").textContent = running ? "服务运行中" : "服务已停止";
    $("svc-toggle").textContent = running ? "停止服务" : "启动服务";
  }

  async function refreshStatus() {
    const r = await safe("is_running");
    const running = !!r;
    setServiceUI(running);
    if (running && !ws) {
      wantConnect = true;
      connect();
    } else if (!running) {
      wantConnect = false;
      if (retry) {
        clearInterval(retry);
        retry = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    }
  }

  $("svc-toggle").onclick = async () => {
    const r = await safe("is_running");
    if (r) {
      await safe("stop_service");
      toast("服务已停止");
    } else {
      await safe("start_service");
      toast("服务已启动");
    }
    await refreshStatus();
  };

  // ----------------- 配置 / 二维码 -----------------
  async function loadConfig() {
    const c = await safe("get_config");
    if (c) {
      cfg = c;
      serverPort = c.port;
      hostPassword = c.password || "";
      $("storage-input").value = c.storage_dir || "";
      $("set-pwd").value = c.password || "";
      $("set-port").value = c.port;
      $("set-cleanup-enabled").checked = c.auto_cleanup !== false;
      $("set-cleanup-max").value = c.cleanup_max_mb || 2048;
      $("set-cleanup-days").value = c.cleanup_days || 10;
      syncCleanupFields();
    }
    try {
      const r = await fetch(base() + "/api/config");
      const d = await r.json();
      const list = $("ip-list");
      list.innerHTML = "";
      (d.lan_ips || []).forEach((ip) => {
        const el = document.createElement("span");
        el.className = "ip-chip";
        el.textContent = ip + ":" + d.port;
        list.appendChild(el);
      });
      $("client-url").textContent = d.client_url;
    } catch (e) {}
    try {
      const svg = await (await fetch(base() + "/api/qr")).text();
      $("qr-box").innerHTML = svg;
    } catch (e) {
      $("qr-box").innerHTML = '<span class="muted">二维码不可用</span>';
    }
  }

  // ----------------- 密码展示 -----------------
  const EYE =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 0 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
  let pwdShown = false;
  function renderPwd() {
    $("pwd-display").value = pwdShown ? hostPassword : "······";
    const btn = $("pwd-toggle");
    if (btn) {
      btn.innerHTML = pwdShown ? EYE_OFF : EYE;
      btn.title = pwdShown ? "隐藏密码" : "显示密码";
      btn.setAttribute("aria-label", btn.title);
    }
  }
  $("pwd-toggle").onclick = () => {
    pwdShown = !pwdShown;
    renderPwd();
  };
  $("set-pwd-reset").onclick = async () => {
    const p = await safe("regenerate_password");
    if (p) {
      hostPassword = p;
      $("set-pwd").value = p;
      renderPwd();
      toast("连接密码已重置");
      await loadConfig();
    }
  };

  // ----------------- 已连接设备 -----------------
  async function refreshDevices() {
    const ds = await safe("get_devices");
    if (ds) renderDevices(ds);
  }
  function renderDevices(list) {
    const box = $("device-list");
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无已连接设备</div>';
      renderHomeDevices([]);
      return;
    }
    list.forEach((d) => {
      const chip = makeChip(d, { closable: true });
      chip.title = d.name + "\n连接于 " + fmtTime(d.connected_at);
      box.appendChild(chip);
    });
    renderHomeDevices(list);
  }

  // 首页底部：已连接设备以小卡片展示（宽度自适应、可并排换行）
  function renderHomeDevices(list) {
    const box = $("home-devices");
    if (!box) return;
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无设备连接</div>';
      return;
    }
    list.forEach((d) => {
      const chip = makeChip(d);
      chip.title = d.name + "（连接于 " + fmtTime(d.connected_at) + "）点击前往传输页";
      chip.onclick = () => switchView("devices");
      box.appendChild(chip);
    });
  }

  // 生成一枚设备小卡片：dot + 名称，可选右上角红叉（断开）
  function makeChip(d, opts) {
    const closable = !!(opts && opts.closable);
    const chip = document.createElement("div");
    chip.className = "dev-chip" + (closable ? " closable" : "");

    const dot = document.createElement("span");
    dot.className = "dev-chip-dot";
    const name = document.createElement("span");
    name.className = "dev-chip-name";
    name.textContent = d.name;
    chip.appendChild(dot);
    chip.appendChild(name);

    if (closable) {
      const close = document.createElement("button");
      close.className = "chip-close";
      close.type = "button";
      close.title = "断开 " + d.name;
      close.setAttribute("aria-label", "断开 " + d.name);
      close.textContent = "×";
      close.onclick = async (e) => {
        e.stopPropagation();
        close.disabled = true;
        await safe("disconnect_device", { id: d.id });
        toast("已断开 " + d.name);
      };
      chip.appendChild(close);
    }
    return chip;
  }
  function fmtSize(bytes) {
    const b = bytes || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
    return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }
  function fmtTime(secs) {
    if (!secs) return "";
    const d = new Date(secs * 1000);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return (
      p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  // ----------------- 接收的文件（主机面板） -----------------
  // 主机：点击文件行=用默认程序打开；右侧图标=打开文件所在位置 / 删除
  // 传输页与历史页共用同一套渲染，只在「是否显示设备徽标」上略有差异
  function buildFileRow(f, opts) {
    const showUploader = !(opts && opts.showUploader === false);
    const item = document.createElement("div");
    item.className = "item clickable";
    item.title = f.path ? "点击打开：" + f.path : "";
    item.innerHTML =
      '<div class="meta"><div class="name"></div><div class="sub"></div></div>' +
      '<div class="acts"></div>';
    item.querySelector(".name").textContent = f.name;

    const sub = item.querySelector(".sub");
    const uploader = f.uploader || "未知";
    if (showUploader) {
      const badge = document.createElement("span");
      badge.className = "up-badge";
      badge.textContent = uploader;
      sub.appendChild(badge);
    }
    const info = document.createElement("span");
    const when = fmtTime(f.mtime || f.created);
    info.textContent = fmtSize(f.size) + (when ? " · " + when : "");
    sub.appendChild(info);

    // 点击整行：打开文件
    if (f.path) {
      item.onclick = () => safe("open_path", { path: f.path });
    }

    // 图标：打开所在位置
    const reveal = document.createElement("button");
    reveal.className = "icon-btn sm";
    reveal.title = "打开所在位置";
    reveal.setAttribute("aria-label", "打开所在位置");
    reveal.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    reveal.onclick = (e) => {
      e.stopPropagation();
      if (f.path) safe("reveal_path", { path: f.path });
    };
    item.querySelector(".acts").appendChild(reveal);

    // 图标：删除该文件
    const del = document.createElement("button");
    del.className = "icon-btn sm danger";
    del.title = "删除文件";
    del.setAttribute("aria-label", "删除文件");
    del.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!window.confirm('删除文件「' + f.name + '」？此操作不可恢复。')) return;
      del.disabled = true;
      const ok = await safe("delete_received_file", { id: f.id });
      if (ok === false) {
        del.disabled = false;
        toast("删除失败，文件可能已被移除");
        refreshFiles();
      } else {
        toast("已删除");
        refreshFiles();
      }
    };
    item.querySelector(".acts").appendChild(del);
    return item;
  }

  function renderFiles(files) {
    const box = $("file-list");
    if (!box) return;
    box.innerHTML = "";
    // 后端已按时间倒序返回；这里不再反向，保证「最新在最上」
    const fs = files || [];
    if (!fs.length) {
      box.innerHTML = '<div class="empty">当前会话暂无文件</div>';
      return;
    }
    fs.forEach((f) => box.appendChild(buildFileRow(f, { showUploader: false })));
  }
  async function refreshFiles() {
    if (!hostPassword) {
      const c = await safe("get_config");
      if (c) hostPassword = c.password || "";
    }
    if (!hostPassword) return;
    try {
      const r = await fetch(base() + "/api/files?pwd=" + encodeURIComponent(hostPassword));
      if (r.ok) {
        const d = await r.json();
        sessionFiles = d.files || [];
        historyFiles = d.history || d.files || [];
        renderFiles(sessionFiles);
        renderHistory();
      }
    } catch (e) {}
  }

  // ----------------- 历史页 -----------------
  // 传输页只显示「本次启动后上传」的文件（sessionFiles）；
  // 历史页显示接收目录中的全部文件（historyFiles，含往期）。
  let sessionFiles = [];
  let historyFiles = [];
  let histQuery = "";

  function renderHistory() {
    const box = $("history-list");
    if (!box) return;
    const q = histQuery.trim().toLowerCase();
    const fs = historyFiles.filter((f) => {
      if (!q) return true;
      const name = (f.name || "").toLowerCase();
      const up = (f.uploader || "").toLowerCase();
      return name.includes(q) || up.includes(q);
    });

    box.innerHTML = "";
    if (!fs.length) {
      box.innerHTML =
        '<div class="empty">' +
        (historyFiles.length ? "没有匹配的文件" : "接收目录中暂无文件") +
        "</div>";
    } else {
      fs.forEach((f) => box.appendChild(buildFileRow(f, { showUploader: true })));
    }

    // 汇总：文件数 + 总大小（按全部，不受搜索影响）
    const total = historyFiles.reduce((s, f) => s + (f.size || 0), 0);
    const sum = $("hist-summary");
    if (sum) {
      let text = "共 " + historyFiles.length + " 个文件 · " + fmtSize(total);
      if (q) text += "（筛选出 " + fs.length + " 个）";
      sum.textContent = text;
    }
  }

  const histSearch = $("hist-search");
  if (histSearch) {
    histSearch.addEventListener("input", () => {
      histQuery = histSearch.value || "";
      renderHistory();
    });
  }

  const histOpenDir = $("hist-open-dir");
  if (histOpenDir) {
    histOpenDir.onclick = () => safe("open_storage_dir");
  }

  const histClear = $("hist-clear");
  if (histClear) {
    histClear.onclick = async () => {
      if (!historyFiles.length) {
        toast("没有可清空的文件");
        return;
      }
      if (
        !window.confirm(
          "确定清空接收目录中的全部 " + historyFiles.length + " 个文件？此操作不可恢复。"
        )
      )
        return;
      histClear.disabled = true;
      const r = await safe("clear_history_files");
      histClear.disabled = false;
      if (Array.isArray(r)) {
        const [ok, fail] = r;
        toast(fail ? "已删除 " + ok + " 个，失败 " + fail + " 个" : "已清空 " + ok + " 个文件");
      } else {
        toast("已清空");
      }
      refreshFiles();
    };
  }

  // ----------------- 文本同步（共享文本框） -----------------
  // 所有端共用一个文本框：本端输入 → 广播；收到远端文本 → 覆盖本地。
  // 用 applyingRemote 标记避免「收到后 set value 又触发 input 再广播」的回环。
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  let applyingRemote = false;
  let textTimer = null;
  const sharedText = $("text-shared");

  sharedText.addEventListener("input", () => {
    if (applyingRemote) return;
    $("text-hint").textContent = "编辑中…";
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      send({ type: "text", value: sharedText.value });
      $("text-hint").textContent = "已同步";
    }, 120);
  });

  function applyRemoteText(value) {
    if (sharedText.value === value) return; // 内容一致，避免光标跳动
    applyingRemote = true;
    sharedText.value = value;
    applyingRemote = false;
    $("text-hint").textContent = "已同步";
  }

  $("text-copy").onclick = () => {
    const v = sharedText.value;
    if (v) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(v).catch(fallbackCopy);
      } else fallbackCopy();
      toast("已复制");
    }
  };
  function fallbackCopy() {
    sharedText.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
  }

  $("text-clear").onclick = () => {
    if (!sharedText.value) return;
    if (!window.confirm("确定清空共享文本框？所有设备的内容都会被清空。")) return;
    if (textTimer) clearTimeout(textTimer);
    sharedText.value = "";
    send({ type: "text", value: "" });
    $("text-hint").textContent = "已同步";
    sharedText.focus();
  };

  // ----------------- 分享文件 -----------------
  // 点击图标 → 打开系统文件选择器；选中后立即上传，无需二次点击
  $("share-pick").onclick = () => $("share-file").click();
  $("share-file").onchange = () => uploadFiles();

  async function uploadFiles() {
    const input = $("share-file");
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const status = $("share-status");
    const pick = $("share-pick");
    // 确保密码已就绪（服务刚启动时 welcome 可能未到）
    if (!hostPassword) {
      const c = await safe("get_config");
      if (c) hostPassword = c.password || "";
    }
    if (!hostPassword) {
      status.textContent = "连接密码未就绪，请稍后重试";
      input.value = "";
      return;
    }
    pick.disabled = true;
    let ok = 0,
      fail = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      status.textContent = "上传中（" + (i + 1) + "/" + files.length + "）：" + f.name;
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await fetch(
          base() +
            "/api/upload?pwd=" +
            encodeURIComponent(hostPassword) +
            "&name=" +
            encodeURIComponent("本机"),
          { method: "POST", body: fd }
        );
        if (r.ok) ok++;
        else fail++;
      } catch (e) {
        fail++;
      }
    }
    input.value = "";
    pick.disabled = false;
    if (ok && !fail) status.textContent = "已上传 " + ok + " 个文件";
    else if (ok && fail) status.textContent = "已上传 " + ok + " 个，失败 " + fail + " 个";
    else status.textContent = "上传失败，请确认服务已启动";
    refreshFiles();
  }

  // ----------------- 设置 -----------------
  $("storage-pick").onclick = async () => {
    const p = await safe("pick_dir");
    if (p) $("storage-input").value = p;
  };
  $("storage-open").onclick = () => {
    const p = $("storage-input").value;
    if (p) safe("open_dir", { path: p });
  };

  // 自动清理：勾选状态控制输入可用性，并实时预览策略文案
  function syncCleanupFields() {
    const on = $("set-cleanup-enabled").checked;
    const box = $("cleanup-fields");
    if (box) box.classList.toggle("disabled", !on);
    const mb = parseInt($("set-cleanup-max").value, 10) || 0;
    const days = parseInt($("set-cleanup-days").value, 10) || 0;
    const pv = $("cleanup-preview");
    if (!pv) return;
    if (!on) {
      pv.textContent = "已关闭：历史文件不会被自动删除，可手动删除。";
      return;
    }
    pv.textContent =
      "当前策略：接收目录超过 " +
      mb +
      " MB 时，启动时删除 " +
      days +
      " 天前的文件（按最旧优先），删到低于阈值即停止。";
  }
  ["set-cleanup-enabled", "set-cleanup-max", "set-cleanup-days"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("input", syncCleanupFields);
    if (el) el.addEventListener("change", syncCleanupFields);
  });

  $("settings-save").onclick = async () => {
    const port = parseInt($("set-port").value, 10);
    const password = $("set-pwd").value.trim();
    const storage_dir = $("storage-input").value.trim();
    const auto_cleanup = $("set-cleanup-enabled").checked;
    const cleanup_max_mb = parseInt($("set-cleanup-max").value, 10);
    const cleanup_days = parseInt($("set-cleanup-days").value, 10);
    const msg = $("settings-msg");
    if (!/^\d{6}$/.test(password)) {
      msg.textContent = "密码必须是 6 位数字";
      return;
    }
    if (auto_cleanup && (!(cleanup_max_mb > 0) || !(cleanup_days > 0))) {
      msg.textContent = "容量阈值与保留天数需为大于 0 的整数";
      return;
    }
    try {
      await invoke("save_settings", {
        port,
        password,
        storageDir: storage_dir,
        autoCleanup: auto_cleanup,
        cleanupMaxMb: cleanup_max_mb,
        cleanupDays: cleanup_days,
      });
      msg.textContent = "";
      toast("设置已保存");
      await loadConfig();
      await refreshStatus();
    } catch (e) {
      msg.textContent = typeof e === "string" ? e : "保存失败";
    }
  };

  // ----------------- WebSocket -----------------
  function connect() {
    const url = `ws://127.0.0.1:${serverPort}/ws?role=host`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      setServiceUI(true);
      if (retry) clearInterval(retry);
    };
    ws.onclose = () => {
      ws = null;
      if (wantConnect) {
        if (!retry)
          retry = setInterval(() => {
            if (wantConnect && !ws) connect();
          }, 2500);
      }
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      switch (m.type) {
        case "welcome":
          if (m.role === "host") {
            hostPassword = m.password || hostPassword;
            serverPort = m.port || serverPort;
            renderPwd();
            renderDevices(m.devices || []);
            sessionFiles = m.files || [];
            historyFiles = m.history || m.files || [];
            renderFiles(sessionFiles);
            renderHistory();
            if (typeof m.text === "string") applyRemoteText(m.text);
          }
          break;
        case "device_list":
          renderDevices(m.devices || []);
          break;
        case "file_list":
          sessionFiles = m.files || [];
          historyFiles = m.history || m.files || [];
          renderFiles(sessionFiles);
          renderHistory();
          break;
        case "toast":
          toast(m.text);
          break;
        case "text":
          applyRemoteText(m.value);
          break;
        case "password_updated":
          hostPassword = m.password || hostPassword;
          renderPwd();
          $("set-pwd").value = hostPassword;
          break;
      }
    };
  }

  // ----------------- 启动 -----------------
  function init() {
    initNav();
    renderPwd();
    loadConfig();
    refreshStatus();
    connect();
    refreshDevices();
    watchTxMinHeight();
    setTimeout(refreshFiles, 800);
    setInterval(refreshStatus, 3000);
    setInterval(refreshDevices, 3000);
    setInterval(refreshFiles, 4000);
  }

  if (window.__LAN_PORT) init();
  else window.addEventListener("lan-ready", init);
})();
