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
  function initNav() {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        btn.classList.add("active");
        $("view-" + btn.dataset.view).classList.add("active");
      };
    });
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
      return;
    }
    list.forEach((d) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML =
        '<div class="meta"><div class="name"></div><div class="sub"></div></div>' +
        '<div class="acts"></div>';
      item.querySelector(".name").textContent = d.name;
      item.querySelector(".sub").textContent = "连接于 " + fmtTime(d.connected_at);
      const btn = document.createElement("button");
      btn.className = "danger";
      btn.textContent = "断开";
      btn.onclick = async () => {
        await safe("disconnect_device", { id: d.id });
        toast("已断开 " + d.name);
      };
      item.querySelector(".acts").appendChild(btn);
      box.appendChild(item);
    });
  }
  function fmtTime(secs) {
    if (!secs) return "";
    const d = new Date(secs * 1000);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return (
      p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  // ----------------- 接收历史 -----------------
  function renderHistory(items) {
    const box = $("history-list");
    if (!box) return;
    box.innerHTML = "";
    const list = (items || []).slice().reverse();
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无接收记录</div>';
      return;
    }
    list.forEach((h) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML =
        '<div class="meta"><div class="name"></div><div class="sub"></div></div>' +
        '<div class="acts"></div>';
      item.querySelector(".name").textContent = h.name || (h.kind === "text" ? "文本" : "文件");
      const sizeTxt =
        h.kind === "file" && h.size ? " · " + (h.size / 1024).toFixed(1) + " KB" : "";
      item.querySelector(".sub").textContent =
        (h.kind === "file" ? "文件" : "文本") +
        " · 来自 " +
        (h.source || "未知") +
        sizeTxt +
        " · " +
        fmtTime(h.created);
      const acts = item.querySelector(".acts");
      if (h.kind === "file") {
        const dl = document.createElement("button");
        dl.className = "ghost";
        dl.textContent = "下载";
        dl.onclick = () => {
          const a = document.createElement("a");
          a.href = base() + "/api/download/" + h.id + "?pwd=" + encodeURIComponent(hostPassword);
          a.download = h.name;
          a.click();
        };
        acts.appendChild(dl);
      } else {
        const cp = document.createElement("button");
        cp.className = "ghost";
        cp.textContent = "复制";
        cp.onclick = () => {
          const v = h.value || "";
          if (navigator.clipboard) navigator.clipboard.writeText(v).catch(fallbackCopyText(v));
          else fallbackCopyText(v);
        };
        acts.appendChild(cp);
      }
      box.appendChild(item);
    });
  }

  function fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(ta);
  }

  // ----------------- 文本同步 -----------------
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  $("text-send").onclick = () => {
    const v = $("text-out").value;
    if (v) send({ type: "text", value: v });
  };
  $("text-copy").onclick = () => {
    const v = $("text-in").value;
    if (v) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(v).catch(fallbackCopy);
      } else fallbackCopy();
    }
  };
  function fallbackCopy() {
    $("text-in").select();
    try {
      document.execCommand("copy");
    } catch (e) {}
  }

  // ----------------- 分享文件 -----------------
  $("share-btn").onclick = async () => {
    const input = $("share-file");
    const files = input.files;
    if (!files.length) {
      toast("请先选择文件");
      return;
    }
    // 确保密码已就绪（服务刚启动时 welcome 可能未到）
    if (!hostPassword) {
      const c = await safe("get_config");
      if (c) hostPassword = c.password || "";
    }
    if (!hostPassword) {
      toast("连接密码未就绪，请稍后重试");
      return;
    }
    let ok = 0,
      fail = 0;
    for (const f of files) {
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
    if (ok && !fail) toast("已上传 " + ok + " 个文件");
    else if (ok && fail) toast("已上传 " + ok + " 个，失败 " + fail + " 个");
    else toast("上传失败，请确认服务已启动");
  };

  // ----------------- 设置 -----------------
  $("storage-pick").onclick = async () => {
    const p = await safe("pick_dir");
    if (p) $("storage-input").value = p;
  };
  $("storage-open").onclick = () => {
    const p = $("storage-input").value;
    if (p) safe("open_dir", { path: p });
  };
  $("settings-save").onclick = async () => {
    const port = parseInt($("set-port").value, 10);
    const password = $("set-pwd").value.trim();
    const storage_dir = $("storage-input").value.trim();
    const msg = $("settings-msg");
    if (!/^\d{6}$/.test(password)) {
      msg.textContent = "密码必须是 6 位数字";
      return;
    }
    try {
      await invoke("save_settings", { port, password, storageDir: storage_dir });
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
            renderHistory(m.history || []);
          }
          break;
        case "device_list":
          renderDevices(m.devices || []);
          break;
        case "toast":
          toast(m.text);
          break;
        case "history":
          renderHistory(m.items || []);
          break;
        case "text":
          $("text-in").value = m.value;
          $("text-hint").textContent = "来自 " + (m.from || "设备");
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
    setInterval(refreshStatus, 3000);
    setInterval(refreshDevices, 3000);
  }

  if (window.__LAN_PORT) init();
  else window.addEventListener("lan-ready", init);
})();
