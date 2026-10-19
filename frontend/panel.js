// LanShare 控制面板逻辑（主机端，role=host）
(function () {
  let serverPort = window.__LAN_PORT || 18765;
  let hostPassword = "";
  // 文件视图模式：list（列表，默认）/ grid（缩略图网格）。
  // 传输页与历史页共用同一份偏好 —— 用户切一次就该两页都变，
  // 否则「我明明切成缩略图了，换个页又变回去」很怪。
  const VIEW_MODE_KEY = "lanshare.viewmode";
  // ?view=grid|list 可覆盖本地偏好（截图 / 演示 / 自动化测试用），
  // 只影响本次加载，不写回 localStorage，不会污染用户选择。
  const urlView = new URLSearchParams(location.search).get("view");
  let viewMode = "list";
  if (urlView === "grid" || urlView === "list") {
    viewMode = urlView;
  } else {
    try {
      viewMode = localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list";
    } catch (e) {}
  }
  // cfg 在 get_config 返回前只是占位桩，不能拿它做「是否已修改」的比对，
  // 否则刚启动就会被判定成「端口/目录被改过」。cfgLoaded 标记真实配置是否已就位。
  let cfg = { port: serverPort, password: "", storage_dir: "", auto_start: true };
  let cfgLoaded = false;
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
    // 广播视图切换：拖拽遮罩等依赖「当前页」的逻辑据此收起状态
    window.dispatchEvent(new Event("lan-view-change"));
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

  // ----------------- 防火墙检测 / 一键放行 -----------------
  //
  // Windows 默认拦所有入站连接：装到新电脑后本机自己访问 127.0.0.1 没问题，
  // 但手机/另一台电脑走局域网 IP 连就被丢弃。放行规则绑定的是「程序路径」
  // 而不是端口，所以之后改端口 / 换网络都不用重新加规则。
  const FW_DISMISS_KEY = "lanshare.fw.dismissed";

  /// 读取「不再提示」的标记。用 try 包住：file:// 下 localStorage 可能被禁用。
  function fwDismissed() {
    try {
      return localStorage.getItem(FW_DISMISS_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setFwDismissed(v) {
    try {
      if (v) localStorage.setItem(FW_DISMISS_KEY, "1");
      else localStorage.removeItem(FW_DISMISS_KEY);
    } catch (e) {}
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

  /// 把检测结果同时反映到「设置页」的状态行（圆点 + 文案 + 详情）。
  function renderFwState(info) {
    const dot = $("fw-dot");
    const text = $("fw-state-text");
    const detail = $("fw-detail");
    if (!dot || !text) return;
    if (!info || info.status === "unknown") {
      dot.className = "dot off";
      text.textContent = "无法检测（非 Windows 或系统查询不可用）";
      if (detail) detail.textContent = "";
      return;
    }
    if (info.status === "allowed") {
      dot.className = "dot on";
      text.textContent = "已放行，局域网设备可正常连接";
      if (detail) detail.textContent = info.program ? "已放行程序：" + info.program : "";
    } else {
      dot.className = "dot off";
      text.textContent = "未放行，局域网设备可能连不上";
      if (detail) {
        detail.textContent = info.program
          ? "待放行程序：" + info.program + "　（提示：系统弹窗可能只给「一种网络类型」加了规则，换到别的网络仍会被拦；点「一键放行」会补齐全部网络类型。）"
          : "";
      }
    }
  }

  /// 检测防火墙放行状态，决定是否显示提示条。
  /// 只有在「明确没放行」（blocked）且用户没点过「不再提示」时才弹。
  async function checkFirewall(opts) {
    const manual = !!(opts && opts.manual);
    // 两个入口（首页横幅 / 设置页）共用同一套按钮禁用逻辑
    const btns = ["fw-recheck", "fw-check"].map($).filter(Boolean);
    if (manual) btns.forEach((b) => (b.disabled = true));
    const info = await safe("firewall_status");
    if (manual) btns.forEach((b) => (b.disabled = false));
    if (!info) return;
    renderFwState(info);
    if (info.status === "allowed") {
      // 已放行：收起横幅，并清掉旧的「不再提示」（下次换环境重新检测才有意义）
      hideFwAlert();
      setFwDismissed(false);
      if (manual) toast("防火墙已放行本程序");
      return;
    }
    if (info.status === "unknown") {
      // 检测不了（非 Windows / PowerShell 不可用）就不下结论、不打扰用户
      hideFwAlert();
      if (manual) toast("无法检测防火墙状态");
      return;
    }
    // blocked
    if (fwDismissed() && !manual) {
      hideFwAlert();
      return;
    }
    setFwDismissed(false);
    const where = info.program ? "（" + info.program + "）" : "";
    showFwAlert(
      "当前程序" + where + "尚未被 Windows 防火墙放行，同一局域网下的手机 / 电脑可能连不上。点击「一键放行」后按提示授权即可（只需一次，之后改端口也不用再设置）。"
    );
  }

  /// 一键放行：UAC 提权加规则，然后重新检测确认（不凭「点了按钮」就假装成功）。
  async function runFirewallFix(btn, msgEl) {
    if (msgEl) msgEl.textContent = "正在请求管理员授权…";
    if (btn) btn.disabled = true;
    try {
      await invoke("firewall_fix");
    } catch (e) {
      if (msgEl) msgEl.textContent = typeof e === "string" ? e : "放行失败";
      if (btn) btn.disabled = false;
      return;
    }
    if (btn) btn.disabled = false;
    await checkFirewall({ manual: true });
    const after = await safe("firewall_status");
    if (msgEl) msgEl.textContent = "";
    if (after && after.status === "allowed") {
      toast("已放行局域网访问");
    } else if (after && after.status === "blocked") {
      if (msgEl) msgEl.textContent = "规则未生效，可稍后点「重新检测」再试，或手动确认安全软件拦截。";
    }
  }

  const fwFixBtn = $("fw-fix");
  if (fwFixBtn) fwFixBtn.onclick = () => runFirewallFix(fwFixBtn, $("fw-msg"));

  const fwRecheckBtn = $("fw-recheck");
  if (fwRecheckBtn) fwRecheckBtn.onclick = () => checkFirewall({ manual: true });

  // 设置页那组控件
  const fwAllowBtn = $("fw-allow");
  if (fwAllowBtn) fwAllowBtn.onclick = () => runFirewallFix(fwAllowBtn, $("fw-detail"));
  const fwCheckBtn = $("fw-check");
  if (fwCheckBtn) fwCheckBtn.onclick = () => checkFirewall({ manual: true });

  const fwDismissBtn = $("fw-dismiss");
  if (fwDismissBtn) {
    fwDismissBtn.onclick = () => {
      setFwDismissed(true);
      hideFwAlert();
      toast("已隐藏提示，可在设置页重新检测");
    };
  }

  // ----------------- 配置 / 二维码 -----------------

  async function loadConfig() {
    const c = await safe("get_config");
    if (c) {
      cfg = c;
      cfgLoaded = true;
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
      (d.lan_ips || []).forEach((ip, idx) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "ip-chip" + (idx === 0 ? " active" : "");
        el.textContent = ip + ":" + d.port;
        el.title = "点击将二维码切换到该地址";
        el.onclick = () => {
          list.querySelectorAll(".ip-chip").forEach((x) => x.classList.remove("active"));
          el.classList.add("active");
          $("client-url").textContent = "http://" + ip + ":" + d.port;
          loadQr(ip);
        };
        list.appendChild(el);
      });
      $("client-url").textContent = d.client_url;
    } catch (e) {}
    loadQr();
  }

  async function loadQr(ip) {
    try {
      const url = ip ? base() + "/api/qr?ip=" + encodeURIComponent(ip) : base() + "/api/qr";
      const svg = await (await fetch(url)).text();
      $("qr-box").innerHTML = svg;
    } catch (e) {
      $("qr-box").innerHTML = '<span class="muted">二维码不可用</span>';
    }
  }

  /// 重新生成扫码免密令牌（换密码 / 手动刷新时调用），并刷新二维码。
  /// 令牌本身不展示在界面上（避免被截图/投屏泄露），仅由二维码承载。
  async function rotateScanToken() {
    await safe("rotate_scan_token");
    const active = document.querySelector("#ip-list .ip-chip.active");
    await loadQr(active ? active.textContent.split(":")[0] : null);
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
      await rotateScanToken();
    }
  };

  /// 手动刷新二维码：换一个免密令牌（旧扫码链接立即失效）
  $("qr-refresh").onclick = async () => {
    await rotateScanToken();
    toast("二维码已刷新");
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
  // 列表视图：点击整行=用默认程序打开；右侧图标=打开文件所在位置 / 删除
  // 缩略图视图：同样的动作，按钮放在卡片右上角（hover 时浮现）
  const SVG_REVEAL =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const SVG_DEL =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  // 能出缩略图的扩展名，必须与后端 thumbs::IMAGE_EXTS 保持一致。
  // 不一致的后果是「请求打过去得到 404、白跑一趟」，图还没显示出来。
  const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);

  function makeRevealBtn(f) {
    const b = document.createElement("button");
    b.className = "icon-btn sm";
    b.title = "打开所在位置";
    b.setAttribute("aria-label", "打开所在位置");
    b.innerHTML = SVG_REVEAL;
    b.onclick = (e) => {
      e.stopPropagation();
      if (f.path) safe("reveal_path", { path: f.path });
    };
    return b;
  }

  function makeDelBtn(f) {
    const b = document.createElement("button");
    b.className = "icon-btn sm danger";
    b.title = "删除文件";
    b.setAttribute("aria-label", "删除文件");
    b.innerHTML = SVG_DEL;
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!window.confirm('删除文件「' + f.name + '」？此操作不可恢复。')) return;
      b.disabled = true;
      const ok = await safe("delete_received_file", { id: f.id });
      if (ok === false) {
        b.disabled = false;
        toast("删除失败，文件可能已被移除");
        refreshFiles();
      } else {
        toast("已删除");
        refreshFiles();
      }
    };
    return b;
  }

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

    item.querySelector(".acts").appendChild(makeRevealBtn(f));
    item.querySelector(".acts").appendChild(makeDelBtn(f));
    return item;
  }

  // ----------------- 缩略图视图 -----------------
  // 缩略图由后端 /api/thumb/:id 生成并缓存（见 src-tauri/src/thumbs.rs）。
  // 非图片、或生成失败（损坏 / 超大 / 解码器不支持），一律退化为扩展名徽章，
  // 不弹错误 —— 缩略图出不来不该是个故障。

  /// 扩展名 → 徽章配色（纯展示，按大类分组）
  function extClass(ext) {
    const e = (ext || "").toLowerCase();
    if (e === "pdf") return "xt-pdf";
    if (["doc", "docx", "rtf", "odt", "wps"].includes(e)) return "xt-doc";
    if (["xls", "xlsx", "csv", "ods", "et"].includes(e)) return "xt-xls";
    if (["ppt", "pptx", "odp", "dps"].includes(e)) return "xt-ppt";
    if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(e)) return "xt-zip";
    if (["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v"].includes(e)) return "xt-video";
    if (["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"].includes(e)) return "xt-audio";
    if (
      ["txt", "md", "log", "json", "xml", "yaml", "yml", "html", "css", "js", "ts", "py", "rs"].includes(e)
    )
      return "xt-text";
    return "xt-other";
  }

  /// 徽章文字：最多 4 个字符，避免 DOCX/APK 这类撑破方块
  function extLabel(ext) {
    const e = (ext || "").toLowerCase();
    if (!e) return "FILE";
    return (e.length <= 4 ? e : e.slice(0, 4)).toUpperCase();
  }

  function makeExtBadge(ext) {
    const b = document.createElement("span");
    b.className = "ext-badge " + extClass(ext);
    b.textContent = extLabel(ext);
    return b;
  }

  /// 缩略图 URL。v=mtime 既让「同名文件被覆盖」后拿到新图，
  /// 也配合后端的 immutable 缓存头做去重。
  function thumbUrl(f) {
    return (
      base() +
      "/api/thumb/" +
      encodeURIComponent(f.id) +
      "?pwd=" +
      encodeURIComponent(hostPassword) +
      "&v=" +
      (f.mtime || 0)
    );
  }

  function buildFileCard(f, opts) {
    const showUploader = !(opts && opts.showUploader === false);
    const ext = (f.ext || "").toLowerCase();
    const card = document.createElement("div");
    card.className = "card-item";
    card.title = f.path ? f.name + "\n" + f.path : f.name;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (IMAGE_EXTS.has(ext)) {
      const img = document.createElement("img");
      // 历史页可能有几百个文件，懒加载避免一次性发起全部缩略图请求
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = thumbUrl(f);
      img.onerror = () => img.replaceWith(makeExtBadge(ext));
      thumb.appendChild(img);
    } else {
      thumb.appendChild(makeExtBadge(ext));
    }
    if (showUploader && f.uploader) {
      const up = document.createElement("span");
      up.className = "ci-up";
      up.textContent = f.uploader;
      thumb.appendChild(up);
    }
    card.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "ci-body";
    const name = document.createElement("div");
    name.className = "ci-name";
    name.textContent = f.name;
    const sub = document.createElement("div");
    sub.className = "ci-sub";
    const when = fmtTime(f.mtime || f.created);
    sub.textContent = fmtSize(f.size) + (when ? " · " + when : "");
    body.appendChild(name);
    body.appendChild(sub);
    card.appendChild(body);

    if (f.path) card.onclick = () => safe("open_path", { path: f.path });

    const acts = document.createElement("div");
    acts.className = "ci-acts";
    acts.appendChild(makeRevealBtn(f));
    acts.appendChild(makeDelBtn(f));
    card.appendChild(acts);
    return card;
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
    const build = viewMode === "grid" ? buildFileCard : buildFileRow;
    fs.forEach((f) => box.appendChild(build(f, { showUploader: false })));
  }
  // 文件列表签名：内容没变就不重建 DOM。
  // 4 秒轮询若无条件重建，网格视图里所有 <img> 会被销毁再创建 ——
  // 缩略图反复闪烁、滚动时出现白块，明明数据一点没变。
  let lastFilesSig = "";
  function filesSig(a, b) {
    const one = (list) =>
      list.map((f) => f.id + ":" + (f.mtime || 0) + ":" + f.size).join(",");
    return one(a || []) + "#" + one(b || []);
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
        const sig = filesSig(sessionFiles, historyFiles);
        if (sig === lastFilesSig) return;
        lastFilesSig = sig;
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
      const build = viewMode === "grid" ? buildFileCard : buildFileRow;
      fs.forEach((f) => box.appendChild(build(f, { showUploader: true })));
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

  // ----------------- 视图切换（列表 / 缩略图） -----------------
  // 只切渲染方式，不动数据：切换时直接用内存里的 sessionFiles / historyFiles
  // 重建，不重新请求接口。
  function applyViewMode() {
    ["file-list", "history-list"].forEach((id) => {
      const box = $(id);
      if (box) box.classList.toggle("grid", viewMode === "grid");
    });
    document.querySelectorAll(".vt-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === viewMode);
    });
  }

  function setViewMode(mode) {
    viewMode = mode === "grid" ? "grid" : "list";
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch (e) {}
    applyViewMode();
    renderFiles(sessionFiles);
    renderHistory();
  }

  function initViewToggle() {
    document.querySelectorAll(".vt-btn").forEach((b) => {
      b.onclick = () => setViewMode(b.dataset.mode);
    });
    applyViewMode();
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
  $("share-file").onchange = () => {
    uploadFiles(Array.from($("share-file").files || []));
    $("share-file").value = "";
  };

  /// 上传一批文件到本机接收目录。
  /// files 由「选择文件」或「拖拽到传输页」两条路径传入，逻辑共用。
  async function uploadFiles(files) {
    files = (files || []).filter(Boolean);
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
    pick.disabled = false;
    if (ok && !fail) status.textContent = "已上传 " + ok + " 个文件";
    else if (ok && fail) status.textContent = "已上传 " + ok + " 个，失败 " + fail + " 个";
    else status.textContent = "上传失败，请确认服务已启动";
    refreshFiles();
  }

  // ----------------- 拖拽上传（传输页遮罩） -----------------
  // 把文件从资源管理器拖到「传输」页即可上传。
  //   - 监听挂在 window 上（而非某个视图元素）：Tauri v2 需要窗口配置
  //     dragDropEnabled:false 才会把拖放事件交给 HTML 层，此时事件在 window 上最可靠
  //   - 进入时显示全页遮罩提示，离开/放下后隐藏
  //   - 用 dragenter/dragleave 计数抵消子元素冒泡造成的闪烁
  (function initDropZone() {
    const view = $("view-devices");
    const mask = $("drop-mask");
    if (!view || !mask) return;
    let depth = 0; // 进入子元素会产生嵌套 enter/leave，用计数判断是否真正离开

    // 只有在「传输」页可见时才接管拖拽，避免影响其它页面
    const isActive = () => view.classList.contains("active");

    /// 拖拽内容里是否含文件（拖拽文本/链接时不弹遮罩）
    function hasFiles(e) {
      const dt = e.dataTransfer;
      if (!dt) return false;
      // types 是 DOMStringList / 数组，统一用 Array.from 兼容
      const types = Array.from(dt.types || []);
      return types.indexOf("Files") >= 0;
    }

    function show() {
      mask.classList.remove("hidden");
    }
    function hide() {
      depth = 0;
      mask.classList.add("hidden");
    }

    window.addEventListener("dragenter", (e) => {
      if (!isActive() || !hasFiles(e)) return;
      e.preventDefault();
      depth++;
      show();
    });

    // dragover 必须 preventDefault，否则 drop 事件不会触发
    window.addEventListener("dragover", (e) => {
      if (!isActive() || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });

    window.addEventListener("dragleave", (e) => {
      if (!isActive()) return;
      // 拖到窗口之外才算真正离开（relatedTarget 为空表示离开文档）
      if (!e.relatedTarget) {
        hide();
        return;
      }
      depth--;
      if (depth <= 0) hide();
    });

    window.addEventListener("drop", (e) => {
      // 无论是否在传输页，都要阻止浏览器默认的「打开文件」行为
      e.preventDefault();
      hide();
      if (!isActive()) return;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) uploadFiles(files);
    });

    // 视图切走时收起遮罩，避免残留
    window.addEventListener("lan-view-change", hide);
  })();

  // ----------------- 设置 -----------------
  /// 「设置已保存」等反馈统一走顶部轻提示，避免用户误以为需要点按钮才生效
  let savedTimer = null;
  function flashSaved() {
    const t = $("settings-save-toast");
    if (!t) return;
    t.classList.remove("hidden");
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => t.classList.add("hidden"), 1600);
  }

  $("storage-pick").onclick = async () => {
    const p = await safe("pick_dir");
    if (p) {
      $("storage-input").value = p;
      saveSettings();
    }
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

  let saveTimer = null;
  /// 防抖保存：连续输入时不反复落盘，停止输入 500ms 后再写
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 500);
  }

  async function saveSettings() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const port = parseInt($("set-port").value, 10);
    const password = $("set-pwd").value.trim();
    const storage_dir = $("storage-input").value.trim();
    const auto_cleanup = $("set-cleanup-enabled").checked;
    const cleanup_max_mb = parseInt($("set-cleanup-max").value, 10);
    const cleanup_days = parseInt($("set-cleanup-days").value, 10);
    const msg = $("settings-msg");

    // 校验不过时不落盘，只在卡片下方说明原因
    if (!/^\d{6}$/.test(password)) {
      msg.textContent = "密码必须是 6 位数字，尚未保存";
      return;
    }
    if (!(port >= 1024 && port <= 65535)) {
      msg.textContent = "端口需在 1024 - 65535 之间，尚未保存";
      return;
    }
    if (auto_cleanup && (!(cleanup_max_mb > 0) || !(cleanup_days > 0))) {
      msg.textContent = "容量阈值与保留天数需为大于 0 的整数，尚未保存";
      return;
    }

    // 比对基准必须是「刚从后端读回的配置」：启动早期 cfg 还是占位桩，
    // 直接比对会把「端口注入值 ≠ 真实配置端口」误判成用户修改。
    if (!cfgLoaded) await loadConfig();
    const portChanged = cfgLoaded && port !== cfg.port;

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
      flashSaved();
      await loadConfig();
      if (portChanged) {
        // 后端已热重启到新端口；这里紧跟着把连接切过去，避免面板显示「已停止」
        toast("端口已生效：" + port);
        reconnectTo(port);
      } else {
        // 端口没变 → 连接不受影响，刷新二维码令牌即可
        await rotateScanToken();
      }
      await refreshStatus();
    } catch (e) {
      // 端口被占用等情况下后端会返回错误，此时连接仍在旧端口上，需回滚输入框
      msg.textContent = typeof e === "string" ? e : "保存失败";
      if (portChanged) await loadConfig();
    }
  }

  /// 端口热切换后重连控制面板 WebSocket。
  /// 旧连接会因服务重启而断开，这里主动切到新端口并重建连接，
  /// 否则 ws.onclose 的重试定时器仍会一直连旧端口。
  function reconnectTo(port) {
    serverPort = port;
    wantConnect = true;
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
    if (ws) {
      try { ws.onclose = null; } catch (e) {}
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    connect();
  }

  // 输入即保存（防抖）；
  $("set-port").addEventListener("input", scheduleSave);
  $("storage-input").addEventListener("input", scheduleSave);
  // 密码：只在失焦（change）时保存 —— 边输边存会在只输到 3 位时报「必须是 6 位数字」，
  // 也会让每次按键都触发一次校验失败提示。
  $("set-pwd").addEventListener("change", scheduleSave);
  // 勾选 / 数字框：change 时立即保存（含清理字段的启用状态）
  ["set-cleanup-enabled", "set-cleanup-max", "set-cleanup-days"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", scheduleSave);
  });

  // ----------------- 关于 / 版本 -----------------
  /// 把 Unix 秒格式化为本地时区的可读时间。
  function fmtBuildTime(epoch) {
    if (!epoch) return "未知";
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return "未知";
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  /// 读取并展示版本信息（版本号 / 构建时间 / 配置文件与程序路径）。
  async function loadAppInfo() {
    const info = await safe("app_info");
    if (!info) return;
    if ($("about-version")) $("about-version").textContent = info.version || "—";
    if ($("about-built")) $("about-built").textContent = fmtBuildTime(info.built_epoch);
    if ($("about-config")) $("about-config").textContent = info.config_dir || "—";
    if ($("about-program")) $("about-program").textContent = info.program || "—";
  }

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
        case "port_changed":
          // 服务已热重启到新端口：把面板连接切过去，并刷新二维码/地址
          if (m.port && m.port !== serverPort) reconnectTo(m.port);
          loadConfig();
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
  async function init() {
    initNav();
    // 视图偏好要在首屏渲染前应用，否则会先闪一下列表再变成网格
    initViewToggle();
    renderPwd();
    // 先把真实配置读回来（拿到 cfgLoaded 基准 + 真实端口），再连 WebSocket、
    // 起定时器。否则这一小段窗口期内：定时器/事件可能拿占位 cfg 判定「已修改」，
    // WebSocket 也可能连到注入的旧端口上。
    await loadConfig();
    await rotateScanToken();
    refreshStatus();
    connect();
    // 防火墙检测开销较大（要拉 PowerShell），放到最后且不 await，
    // 免得拖慢首屏；检测结果只影响首页那条提示横幅。
    checkFirewall();
    // 版本信息（设置页「关于」卡片）：纯本地读取，同样不阻塞首屏
    loadAppInfo();
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
