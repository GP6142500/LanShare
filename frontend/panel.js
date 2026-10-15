// LanShare 控制面板逻辑（主机端，role=host）
(function () {
  let port = window.__LAN_PORT || 18765;
  let hostToken = "";
  let ws = null;
  let retry = null;

  const $ = (id) => document.getElementById(id);

  function base() {
    return `http://127.0.0.1:${port}`;
  }

  function setStatus(on) {
    $("status-dot").className = "dot " + (on ? "on" : "off");
    $("status-text").textContent = on ? "服务在线" : "连接断开，重试中…";
  }

  // ----------------- 配置 / 二维码 -----------------
  async function loadConfig() {
    try {
      const r = await fetch(base() + "/api/config");
      const c = await r.json();
      const list = $("ip-list");
      list.innerHTML = "";
      (c.lan_ips || []).forEach((ip) => {
        const el = document.createElement("span");
        el.className = "ip-chip";
        el.textContent = ip + ":" + c.port;
        list.appendChild(el);
      });
      $("client-url").textContent = c.client_url;
      $("storage-input").value = c.storage_dir || "";
    } catch (e) {
      /* ignore */
    }
    try {
      const svg = await (await fetch(base() + "/api/qr")).text();
      $("qr-box").innerHTML = svg;
    } catch (e) {
      $("qr-box").innerHTML = '<span class="muted">二维码不可用</span>';
    }
  }

  // ----------------- 文件列表 -----------------
  async function refreshFiles() {
    try {
      const r = await fetch(base() + "/api/files");
      const d = await r.json();
      const box = $("file-list");
      box.innerHTML = "";
      const files = d.files || [];
      if (!files.length) {
        box.innerHTML = '<div class="empty">暂无文件</div>';
        return;
      }
      files
        .slice()
        .reverse()
        .forEach((f) => {
          const item = document.createElement("div");
          item.className = "item";
          item.innerHTML =
            '<div class="meta"><div class="name"></div><div class="sub"></div></div>' +
            '<div class="acts"></div>';
          item.querySelector(".name").textContent = f.name;
          item.querySelector(".sub").textContent =
            f.uploader + " · " + (f.size / 1024).toFixed(1) + " KB";
          const dl = document.createElement("button");
          dl.className = "ghost";
          dl.textContent = "下载";
          dl.onclick = () => {
            const a = document.createElement("a");
            a.href = base() + "/api/download/" + f.id + "?token=" + encodeURIComponent(hostToken);
            a.download = f.name;
            a.click();
          };
          item.querySelector(".acts").appendChild(dl);
          box.appendChild(item);
        });
    } catch (e) {}
  }

  // ----------------- 配对 -----------------
  function renderPending() {
    $("pending-list").innerHTML = "";
  }
  function showPending(id, name) {
    const box = $("pending-list");
    let item = document.getElementById("pend-" + id);
    if (!item) {
      item = document.createElement("div");
      item.className = "item";
      item.id = "pend-" + id;
      item.innerHTML =
        '<div class="meta"><div class="name"></div><div class="sub">请求配对</div></div>' +
        '<div class="acts"></div>';
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "批准";
      ok.onclick = () => send({ type: "pair_approve", id });
      item.querySelector(".acts").appendChild(ok);
      box.appendChild(item);
    }
    item.querySelector(".name").textContent = name;
  }
  function clearPending(id) {
    const el = document.getElementById("pend-" + id);
    if (el) el.remove();
  }
  function renderPaired(devices) {
    const box = $("paired-list");
    box.innerHTML = "";
    (devices || []).forEach((d) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML =
        '<div class="meta"><div class="name"></div><div class="sub">已配对</div></div>' +
        '<div class="acts"></div>';
      item.querySelector(".name").textContent = d.name;
      const rv = document.createElement("button");
      rv.className = "danger";
      rv.textContent = "撤销";
      rv.onclick = () => send({ type: "revoke", id: d.id });
      item.querySelector(".acts").appendChild(rv);
      box.appendChild(item);
    });
  }

  // ----------------- WebSocket -----------------
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    const url = `ws://127.0.0.1:${port}/ws?role=host`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      setStatus(true);
      if (retry) clearInterval(retry);
      refreshFiles();
    };
    ws.onclose = () => {
      setStatus(false);
      if (!retry) retry = setInterval(connect, 2500);
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
            hostToken = m.token || "";
            renderFilesInit(m.files);
          }
          break;
        case "paired_list":
          renderPaired(m.devices);
          break;
        case "pairing_request":
          showPending(m.id, m.name);
          break;
        case "device_paired":
          clearPending(m.id);
          break;
        case "device_revoked":
        case "device_left":
          clearPending(m.id);
          break;
        case "text":
          $("text-in").value = m.value;
          $("text-hint").textContent = "来自 " + (m.from || "设备");
          break;
        case "storage_updated":
          $("storage-input").value = m.dir;
          break;
      }
    };
  }

  function renderFilesInit(files) {
    // 首次以 welcome 的数据填充
    const box = $("file-list");
    if (files && files.length) refreshFiles();
  }

  // ----------------- 交互 -----------------
  $("storage-save").onclick = () => {
    const dir = $("storage-input").value.trim();
    if (dir) send({ type: "set_storage", dir });
  };
  $("storage-open").onclick = () => {
    // 控制面板无法直接打开文件夹（无 Tauri 插件），给出路径提示
    const p = $("storage-input").value;
    if (p) alert("请在资源管理器中打开：\n" + p);
  };
  $("share-btn").onclick = async () => {
    const input = $("share-file");
    const files = input.files;
    if (!files.length) return;
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        await fetch(base() + "/api/upload?token=" + encodeURIComponent(hostToken), {
          method: "POST",
          body: fd,
        });
      } catch (e) {}
    }
    input.value = "";
    refreshFiles();
  };
  $("text-send").onclick = () => {
    const v = $("text-out").value;
    if (v) send({ type: "text", value: v });
  };
  $("text-copy").onclick = () => {
    const v = $("text-in").value;
    if (v) {
      navigator.clipboard?.writeText(v).catch(() => {
        $("text-in").select();
        document.execCommand("copy");
      });
    }
  };

  // ----------------- 启动 -----------------
  function init() {
    port = window.__LAN_PORT || 18765;
    loadConfig();
    connect();
    setInterval(refreshFiles, 4000);
  }

  if (window.__LAN_PORT) init();
  else window.addEventListener("lan-ready", init);
})();
