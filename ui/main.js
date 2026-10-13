(function () {
  "use strict";

  const COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444", "#3b82f6", "#a855f7"];
  let selectedColor = COLORS[4];

  // 构建版本号：与 manifest.json / backend 的 pluginVersion 保持一致。
  // 常驻显示在状态栏，用于确认宿主实际加载的是哪个版本（排查“改了却没生效”）。
  const BUILD = "0.4.2";

  const state = {
    connectionId: null,
    connected: false,
    provider: "aliyun", // aliyun | s3
    endpoint: "",    // 当前连接 Endpoint（用于「获得地址」）
    bucket: "",      // 当前存储桶；空 = 根目录（列出全部存储桶）
    prefix: "",
    search: "",      // 名称前缀过滤（服务端 Prefix）
    items: [],
    isTruncated: false,
    nextMarker: "",
    loading: false,
    hasMore: false,
    pageSize: 200,
    selectedIndex: -1,
    // F3 多选：Set<完整对象 key>。仅桶内浏览时可用（根目录是桶列表，不支持批量操作）。
    sel: new Set(),
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    browserView: $("browserView"),
    breadcrumb: $("breadcrumb"),
    list: $("list"),
    listContent: $("listContent"),
    status: $("status"),
    statusText: $("statusText"),
    uploadBtn: $("uploadBtn"),
    refreshBtn: $("refreshBtn"),
    connBtn: $("connBtn"),
    mkdirBtn: $("mkdirBtn"),
    upBtn: $("upBtn"),
    searchInput: $("searchInput"),
    countLabel: $("countLabel"),
    endpointLabel: $("endpointLabel"),
    fileInput: $("fileInput"),
    previewOverlay: $("previewOverlay"),
    pvIcon: $("pvIcon"),
    pvName: $("pvName"),
    pvMeta: $("pvMeta"),
    pvBody: $("pvBody"),
    pvCopy: $("pvCopy"),
    pvClose: $("pvClose"),

    batchBar: $("batchBar"),
    batchCount: $("batchCount"),
    selAll: $("selAll"),

    overlay: $("connectOverlay"),
    closeDialogBtn: $("closeDialogBtn"),
    swatches: $("swatches"),
    fName: $("fName"),
    fProvider: $("fProvider"),
    fRegion: $("fRegion"),
    fPathStyle: $("fPathStyle"),
    rowRegion: $("rowRegion"),
    rowPathStyle: $("rowPathStyle"),
    endpointHelp: $("endpointHelp"),
    fEndpoint: $("fEndpoint"),
    fBucket: $("fBucket"),
    fPageSize: $("fPageSize"),
    fAk: $("fAk"),
    fSk: $("fSk"),
    connMsg: $("connMsg"),
    testBtn: $("testBtn"),
    saveBtn: $("saveBtn"),
  };

  // ---------- 通用工具 ----------
  // 状态栏：常规状态 + 常驻版本号（便于确认宿主实际加载的版本）。
  function setStatus(t) {
    const el = els.statusText || els.status;
    el.textContent = (t ? t + "  " : "") + "· v" + BUILD;
  }
  function msg(t, isErr) {
    els.connMsg.textContent = t || "";
    els.connMsg.classList.toggle("err", !!isErr);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function formatSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(2) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function fmtTime(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d)) return s;
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function base64FromArrayBuffer(buf) {
    let s = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64toBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function invoke(method, params, opts) {
    return window.dbxPlugin.invoke(method, params, Object.assign({ timeoutMs: 30000 }, opts || {}));
  }
  function updateEndpointLabel() {
    if (!state.endpoint) { els.endpointLabel.textContent = ""; return; }
    const tag = state.provider === "s3" ? "S3" : "OSS";
    els.endpointLabel.textContent = tag + ": " + state.endpoint;
  }

  // ---------- 存储类型切换（aliyun / s3） ----------
  // s3 专属行（Region / PathStyle）显隐 + 接入点帮助文案/placeholder 联动。
  function updateProviderUI() {
    const isS3 = els.fProvider.value === "s3";
    els.rowRegion.classList.toggle("hidden", !isS3);
    els.rowPathStyle.classList.toggle("hidden", !isS3);
    const key = isS3 ? "endpoint.help.s3" : "endpoint.help.aliyun";
    if (els.endpointHelp) els.endpointHelp.textContent = I18N.t(key);
    els.fEndpoint.placeholder = isS3 ? "http://192.168.1.10:9000" : "oss-cn-hangzhou.aliyuncs.com";
  }
  function resetPaging() {
    state.items = [];
    state.nextMarker = "";
    state.isTruncated = false;
    state.hasMore = false;
    state.selectedIndex = -1;
    state.sel.clear();
    updateBatchUI();
  }

  // ---------- 连接配置持久化（含 Secret） ----------
  async function saveMeta(meta) {
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.set === "function") {
        await store.set("conn", meta);
      }
    } catch (e) { /* 降级：不持久化 */ }
  }
  async function loadMeta() {
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.get === "function") {
        return await store.get("conn");
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---------- 新建连接对话框 ----------
  function buildSwatches() {
    els.swatches.innerHTML = "";
    COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (c === selectedColor ? " active" : "");
      b.style.background = c;
      b.onclick = () => { selectedColor = c; buildSwatches(); };
      els.swatches.appendChild(b);
    });
  }

  function currentCfg() {
    return {
      provider: els.fProvider.value === "s3" ? "s3" : "aliyun",
      endpoint: els.fEndpoint.value.trim(),
      accessKeyId: els.fAk.value.trim(),
      accessKeySecret: els.fSk.value,
      bucket: els.fBucket.value.trim(),
      region: els.fRegion ? els.fRegion.value.trim() : "",
      pathStyle: !!(els.fPathStyle && els.fPathStyle.checked),
    };
  }

  async function doConnect() {
    const cfg = currentCfg();
    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.accessKeySecret) {
      msg(I18N.t("conn.fillRequired"), true);
      return;
    }
    msg(I18N.t("conn.connecting"));
    try {
      await invoke("connection/connect", cfg);
    } catch (e) {
      msg(I18N.t("conn.connectFail") + (e.message || e), true);
      return;
    }
    state.connected = true;
    state.provider = cfg.provider;
    state.endpoint = cfg.endpoint;
    state.bucket = cfg.bucket;
    state.prefix = "";
    state.search = "";
    els.searchInput.value = "";
    // 分页大小：以对话框输入为准（10–1000），空/非法值保持原设置
    if (els.fPageSize) {
      const ps = parseInt(els.fPageSize.value, 10);
      if (!isNaN(ps)) state.pageSize = Math.min(1000, Math.max(10, ps));
    }
    state.pageSize = Math.min(1000, Math.max(10, state.pageSize || 200));
    await saveMeta({
      name: els.fName.value.trim() || "Storage",
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      region: cfg.region,
      pathStyle: cfg.pathStyle,
      color: selectedColor,
      pageSize: state.pageSize,
    });
    updateEndpointLabel();
    enterBrowser();
  }

  function enterBrowser() {
    els.overlay.classList.add("hidden");
    els.browserView.classList.remove("hidden");
    renderBreadcrumb();
    loadPage("");
  }

  els.testBtn.onclick = async () => {
    const cfg = currentCfg();
    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.accessKeySecret) {
      msg(I18N.t("conn.testFill"), true);
      return;
    }
    msg(I18N.t("conn.testing"));
    try {
      await invoke("connection/test", cfg);
      msg(I18N.t("conn.testOk"));
    } catch (e) {
      msg(I18N.t("conn.testFail") + (e.message || e), true);
    }
  };
  els.saveBtn.onclick = doConnect;
  els.fProvider.addEventListener("change", updateProviderUI);

  function closeDialog() {
    els.overlay.classList.add("hidden");
    els.browserView.classList.remove("hidden");
    if (!state.connected) {
      els.breadcrumb.innerHTML = `<span class="crumb root">${I18N.t("breadcrumb.notConnected")}</span>`;
      setStatus(I18N.t("status.notConnected"));
    }
  }
  els.closeDialogBtn.onclick = closeDialog;
  // 点击遮罩空白处关闭；Esc 关闭
  els.overlay.addEventListener("mousedown", (e) => {
    if (e.target === els.overlay) closeDialog();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.overlay.classList.contains("hidden")) closeDialog();
  });
  function openConnDialog() {
    msg("");
    els.overlay.classList.remove("hidden");
  }

  // ---------- 通用内嵌模态框（替代原生 prompt/confirm） ----------
  const modal = $("modal");
  const modalTitle = modal.querySelector(".modal-title");
  const modalInput = $("modalInput");
  const modalMsg = modal.querySelector(".modal-msg");
  const modalOk = $("modalOk");
  const modalCancel = $("modalCancel");
  let modalResolve = null;

  function closeModal(val) {
    modal.classList.add("hidden");
    const r = modalResolve;
    modalResolve = null;
    if (r) r(val);
  }
  // 文本输入：返回键入字符串（取消/空返回 null）
  function openPrompt(title, placeholder, value, confirmText) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      modalTitle.textContent = title;
      modalInput.style.display = "";
      modalInput.value = value || "";
      modalInput.placeholder = placeholder || "";
      modalMsg.textContent = "";
      modalOk.textContent = confirmText || I18N.t("modal.ok");
      modal.classList.remove("hidden");
      setTimeout(() => modalInput.focus(), 30);
    });
  }
  // 二次确认：返回 true/false
  function openConfirm(title, message) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      modalTitle.textContent = title;
      modalInput.style.display = "none";
      modalMsg.textContent = message;
      modalOk.textContent = I18N.t("modal.ok");
      modal.classList.remove("hidden");
    });
  }
  modalOk.onclick = () => closeModal(modalInput.style.display !== "none" ? modalInput.value.trim() : true);
  modalCancel.onclick = () => closeModal(modalInput.style.display !== "none" ? null : false);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closeModal(modalInput.style.display !== "none" ? null : false);
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && modalInput.style.display !== "none") closeModal(modalInput.value.trim());
    else if (e.key === "Escape") closeModal(modalInput.style.display !== "none" ? null : false);
  });

  // ---------- 复制弹窗（展示下载路径 / 对象地址，一键复制） ----------
  const copyModal = $("copyModal");
  const copyTitle = $("copyTitle");
  const copyInput = $("copyInput");
  const copyHint = $("copyHint");
  let copyText = "";

  function showCopy(title, text) {
    copyTitle.textContent = title;
    copyInput.value = text;
    copyText = text;
    copyHint.textContent = "";
    copyModal.classList.remove("hidden");
    setTimeout(() => { copyInput.focus(); copyInput.select(); }, 30);
  }
  // 沙箱下优先走宿主桥接的剪贴板（navigator.clipboard 在 opaque origin 中通常被禁）
  async function writeClipboard(text) {
    if (window.dbxPlugin && typeof window.dbxPlugin.copy === "function") {
      await window.dbxPlugin.copy(text);
      return;
    }
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("clipboard unavailable");
  }

  async function copyNow() {
    try {
      await writeClipboard(copyText);
      copyHint.textContent = I18N.t("modal.copyHint");
    } catch (e) {
      copyInput.select();
      copyHint.textContent = I18N.t("modal.copyFail");
    }
  }
  $("copyBtn").onclick = copyNow;
  $("copyClose").onclick = () => copyModal.classList.add("hidden");
  copyModal.addEventListener("mousedown", (e) => {
    if (e.target === copyModal) copyModal.classList.add("hidden");
  });
  copyModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") copyModal.classList.add("hidden");
  });

  // ---------- 浏览（bucket 感知 + 分页 + 虚拟化 + 前缀过滤） ----------
  const ROW_H = 32;

  async function loadPage(marker) {
    if (state.loading) return;
    state.loading = true;
    setStatus(marker ? I18N.t("status.loadingMore") : I18N.t("status.loading"));
    try {
      let items;
      if (!state.bucket && state.prefix === "") {
        const res = await invoke("buckets/list", {});
        items = (res.items || []).map((it) => ({
          name: it.name,
          isDir: true,
          size: 0,
          mime: "application/x-bucket",
          modified: "",
        }));
        if (state.search) {
          const q = state.search.toLowerCase();
          items = items.filter((it) => it.name.toLowerCase().includes(q));
        }
        state.isTruncated = false;
        state.nextMarker = "";
        state.hasMore = false;
        if (!marker) state.items = [];
      } else {
        const res = await invoke("objects/list", {
          bucket: state.bucket,
          prefix: state.prefix + (state.search || ""),
          delimiter: "/",
          marker: marker || "",
          maxKeys: state.pageSize,
        });
        items = (res.items || []).map((it) => ({
          name: it.name,
          isDir: !!it.is_dir || /\/$/.test(it.name),
          size: it.size || 0,
          mime: it.mime || "",
          modified: it.modified || "",
        }));
        state.isTruncated = !!res.is_truncated;
        state.nextMarker = res.next_marker || "";
        state.hasMore = state.isTruncated && !!state.nextMarker;
        if (!marker) state.items = [];
      }
      state.items = state.items.concat(items);
      renderBreadcrumb();
      renderList();
      setStatus(state.hasMore
        ? I18N.t("status.loadedMore", { n: state.items.length })
        : I18N.t("status.loaded", { n: state.items.length }));
    } catch (e) {
      setStatus(I18N.t("status.loadFail") + (e && e.message ? e.message : e));
    } finally {
      state.loading = false;
    }
  }

  // 行内展示名：去掉当前前缀与末尾斜杠
  function displayName(it) {
    if (!state.bucket) return it.name.replace(/\/$/, "");
    const n = it.name.startsWith(state.prefix) ? it.name.slice(state.prefix.length) : it.name;
    return n.replace(/\/$/, "");
  }

  function renderBreadcrumb() {
    let html = "";
    if (!state.bucket) {
      html = `<span class="crumb root">${I18N.t("breadcrumb.allBuckets")}</span>`;
    } else {
      html = `<span class="crumb root" data-bucket="">oss://${esc(state.bucket)}/</span>`;
      const parts = state.prefix ? state.prefix.replace(/\/$/, "").split("/").filter(Boolean) : [];
      let acc = "";
      for (const p of parts) {
        acc += p + "/";
        html += `<span class="crumb" data-prefix="${esc(acc)}">${esc(p)}</span>/`;
      }
    }
    els.breadcrumb.innerHTML = html;
    els.breadcrumb.querySelectorAll(".crumb[data-bucket]").forEach((el) => {
      el.onclick = () => {
        state.bucket = el.getAttribute("data-bucket");
        state.prefix = "";
        state.search = "";
        els.searchInput.value = "";
        resetPaging();
        loadPage("");
      };
    });
    els.breadcrumb.querySelectorAll(".crumb[data-prefix]").forEach((el) => {
      el.onclick = () => navigate(el.getAttribute("data-prefix"));
    });
  }

  function navigate(prefix) {
    if (prefix === state.prefix) return;
    state.prefix = prefix;
    state.search = "";
    els.searchInput.value = "";
    resetPaging();
    loadPage("");
  }

  // 列表虚拟化：只渲染可视区行，避免上万条 DOM 卡死
  function renderList() {
    els.listContent.style.height = (state.items.length * ROW_H) + "px";
    els.countLabel.textContent = I18N.t("status.loadedMore", { n: state.items.length });
    updateBatchUI();
    renderVisible();
  }

  // ---------- F3 多选批量 ----------
  // 复选框是自绘 span（非原生 input）：虚拟化重绘时状态由 state.sel 驱动，
  // 且绕开宿主 webview 对原生控件 change 事件与文档级委托冲突的问题。
  // data-ck 存完整对象 key（比行下标稳：追加翻页/重绘后仍有效）。
  function ckboxHtml(it) {
    // 根目录是桶列表，不支持批量操作；但仍须渲染占位单元格，
    // 否则 5 列网格下该行子元素整体左移一格（名称挤进 34px 窄列被截断）。
    if (!state.bucket) return '<span class="cell-ck"></span>';
    const on = state.sel.has(it.name);
    return `<span class="cell-ck"><span class="ckbox${on ? " on" : ""}" data-ck="${esc(it.name)}" role="checkbox" aria-checked="${on}">${svg("check", 11)}</span></span>`;
  }

  function toggleSel(name) {
    if (!name || !state.bucket) return;
    if (state.sel.has(name)) state.sel.delete(name);
    else state.sel.add(name);
    renderVisible(); // 同步勾选态与行高亮
    updateBatchUI();
  }

  function toggleSelectAll() {
    if (!state.bucket) return;
    const allOn = state.items.length > 0 && state.items.every((it) => state.sel.has(it.name));
    if (allOn) state.sel.clear();
    else state.items.forEach((it) => state.sel.add(it.name));
    renderVisible();
    updateBatchUI();
  }

  // 同步批量条显隐 / 计数 / 表头全选框三态（on / half / 空）
  function updateBatchUI() {
    if (els.batchBar) {
      const n = state.sel.size;
      els.batchBar.classList.toggle("hidden", n === 0);
      if (els.batchCount) els.batchCount.textContent = I18N.t("batch.count", { n });
    }
    if (els.selAll) {
      els.selAll.classList.toggle("hidden", !state.bucket);
      const total = state.items.length;
      const picked = state.items.filter((it) => state.sel.has(it.name)).length;
      const allOn = total > 0 && picked === total;
      const half = picked > 0 && picked < total;
      els.selAll.classList.toggle("on", allOn);
      els.selAll.classList.toggle("half", half);
      els.selAll.innerHTML = allOn ? svg("check", 11) : (half ? svg("minus", 11) : "");
    }
  }

  async function doBatchDelete() {
    const paths = Array.from(state.sel);
    if (!paths.length || !state.bucket) return;
    const ok = await openConfirm(I18N.t("modal.confirmTitle"), I18N.t("batch.deleteTip", { n: paths.length }));
    if (!ok) return;
    setStatus(I18N.t("batch.deleting", { n: paths.length }));
    try {
      const res = await invoke("objects/delete_batch", { bucket: state.bucket, paths }, { timeoutMs: 600000 });
      const failed = (res && res.failed) || [];
      let text = I18N.t("batch.deleted", { n: (res && res.deleted) || 0 });
      if (failed.length) text += " · " + I18N.t("batch.failed", { n: failed.length });
      setStatus(text);
    } catch (e) {
      setStatus(I18N.t("delete.fail") + (e.message || e));
    }
    resetPaging();
    loadPage("");
  }

  async function doBatchDownload() {
    const items = state.items.filter((it) => !it.isDir && state.sel.has(it.name));
    if (!items.length) { setStatus(I18N.t("batch.noFiles")); return; }
    const dir = await openDirPicker();
    if (dir === null) return;
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.set === "function") await store.set("downloadDir", dir);
    } catch (e) { /* ignore */ }
    openDlCard(I18N.t("batch.downloadTitle", { n: items.length }));
    $("dlCancel").classList.add("hidden"); // 批量下载 v1 不支持中途取消
    let done = 0, fail = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      $("dlName").textContent = displayName(it);
      $("dlName").title = it.name;
      dlProgress(i, items.length);
      try {
        await invoke("objects/save", { bucket: state.bucket, path: it.name, downloadDir: dir }, { timeoutMs: 600000 });
        done++;
      } catch (e) { fail++; }
    }
    dlProgress(items.length, items.length);
    if (fail) {
      failDlCard(I18N.t("batch.downloadFail", { a: done, b: fail }));
    } else {
      finishDlCard(I18N.t("batch.downloadDone", { n: done }));
    }
    setStatus(I18N.t("batch.downloadDir") + dir);
  }

  // ---------- 内嵌 SVG 图标（lucide 风格，stroke 继承 currentColor） ----------
  const ICONS = {
    bucket: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    fileCode: '<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 9-2 2 2 2"/><path d="m14 13 2-2-2-2"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="3" y2="15"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    minus: '<line x1="5" x2="19" y1="12" y2="12"/>',
  };
  function svg(name, size) {
    return `<svg viewBox="0 0 24 24" width="${size || 14}" height="${size || 14}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
  }

  const IMG_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff"];
  const CODE_EXT = ["json", "xml", "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "go", "py", "java", "c", "h", "cpp", "hpp", "cs", "css", "scss", "yml", "yaml", "sh", "bat", "ps1", "sql", "toml", "ini", "proto"];
  const TEXT_EXT = ["txt", "md", "csv", "tsv", "log", "rst"];

  // itemIcon 返回 {cls, icon}：桶/目录/按扩展名分型的文件图标
  function itemIcon(it) {
    if (it.isDir) {
      if (!state.bucket) return { cls: "ico-bucket", icon: "bucket" }; // 根目录的"目录"是存储桶
      return { cls: "ico-folder", icon: "folder" };
    }
    const m = it.name.toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = m ? m[1] : "";
    if (ext === "pdf") return { cls: "ico-pdf", icon: "fileText" };
    if (IMG_EXT.indexOf(ext) >= 0) return { cls: "ico-image", icon: "image" };
    if (CODE_EXT.indexOf(ext) >= 0) return { cls: "ico-code", icon: "fileCode" };
    if (TEXT_EXT.indexOf(ext) >= 0) return { cls: "ico-text", icon: "fileText" };
    return { cls: "ico-file", icon: "file" };
  }

  // opBtn 行操作图标按钮：title/aria 保留 i18n 文案
  function opBtn(act, icon, textKey) {
    const t = I18N.t(textKey);
    return `<span class="op" data-act="${act}" title="${esc(t)}" aria-label="${esc(t)}">${svg(icon)}</span>`;
  }

  function rowOps(it) {
    if (it.isDir) {
      // 根目录下的项是存储桶，不允许删除，仅保留「打开」
      if (!state.bucket) return opBtn("open", "folderOpen", "op.open");
      return opBtn("open", "folderOpen", "op.open") + opBtn("delete", "trash", "op.delete");
    }
    let out = "";
    if (previewKind(it.name)) out += opBtn("preview", "eye", "op.preview");
    return out + opBtn("download", "download", "op.download") + opBtn("addr", "link", "op.addr") + opBtn("delete", "trash", "op.delete");
  }

  function renderVisible() {
    const scrollTop = els.list.scrollTop;
    const h = els.list.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
    const end = Math.min(state.items.length, Math.ceil((scrollTop + h) / ROW_H) + 5);
    let html = "";
    for (let i = start; i < end; i++) {
      const it = state.items[i];
      const selected = i === state.selectedIndex ? " selected" : "";
      const checked = state.sel.has(it.name) ? " checked" : "";
      const ic = itemIcon(it);
      html += `<div class="row${selected}${checked}" data-i="${i}" style="position:absolute;top:${i * ROW_H}px;height:${ROW_H}px;left:0;right:0;">` +
        ckboxHtml(it) +
        `<span class="cell-name"><span class="ico ${ic.cls}">${svg(ic.icon, 16)}</span><span class="nm ${it.isDir ? "is-dir" : ""}">${esc(displayName(it))}</span></span>` +
        `<span class="sz">${it.isDir ? I18N.t("row.dir") : formatSize(it.size)}</span>` +
        `<span class="tm">${esc(fmtTime(it.modified))}</span>` +
        `<span class="ops">${rowOps(it)}</span>` +
        `</div>`;
    }
    els.listContent.innerHTML = html;

    if (state.hasMore && !state.loading) {
      const bottom = scrollTop + h;
      const full = state.items.length * ROW_H;
      if (full - bottom < ROW_H * 20) loadPage(state.nextMarker);
    }
  }

  els.list.addEventListener("scroll", renderVisible);

  function openDir(it) {
    if (!state.bucket) {
      // 根目录下的"目录"是存储桶
      state.bucket = it.name.replace(/\/$/, "");
      state.prefix = "";
      state.search = "";
      els.searchInput.value = "";
      resetPaging();
      loadPage("");
    } else {
      navigate(it.name.endsWith("/") ? it.name : it.name + "/");
    }
  }

  // ---------- 下载（进度浮窗 + 可选保存位置） ----------
  // 主路径：宿主 fileTransfer.beginSave 弹原生保存对话框选位置，再用 objects/read
  // 分块读取、fileTransfer.write 分块落盘。进度完全可控，且每块 RPC 都很短，
  // 彻底规避原先「200M 下载超 30s 报失败、但文件其实已下完」的问题。
  // 兜底路径：fileTransfer 不可用时，用 objects/save（支持 downloadDir）+ 长超时，
  // 并由用户在前端填写保存目录（替代默认 Downloads）。
  const DL_CHUNK = 256 * 1024;

  function hasHostSave() {
    const ft = window.dbxPlugin && window.dbxPlugin.fileTransfer;
    return !!(ft && typeof ft.beginSave === "function" && typeof ft.write === "function" && typeof ft.finish === "function");
  }

  const dl = { cancelled: false, lastWritten: 0, lastT: 0, mode: "download" };

  function openDlCard(name, mode) {
    dl.cancelled = false; dl.lastWritten = 0; dl.lastT = 0;
    dl.mode = mode || "download";
    const titleEl = $("dlTitle");
    if (titleEl) titleEl.textContent = I18N.t(dl.mode === "upload" ? "upload.title" : "dl.title");
    $("dlName").textContent = name;
    $("dlName").title = name;
    $("dlFill").style.width = "0%";
    $("dlPct").textContent = "0%";
    $("dlBytes").textContent = "";
    $("dlSpeed").textContent = "";
    const msg = $("dlMsg");
    msg.textContent = ""; msg.className = "dl-msg";
    $("dlCancel").classList.remove("hidden");
    $("dlOk").classList.add("hidden");
    $("dlCard").classList.remove("hidden");
  }
  function dlProgress(written, total) {
    const pct = total > 0 ? Math.min(100, (written / total) * 100) : 0;
    $("dlFill").style.width = pct.toFixed(1) + "%";
    $("dlPct").textContent = pct.toFixed(0) + "%";
    $("dlBytes").textContent = formatSize(written) + " / " + formatSize(total);
    const now = performance.now();
    if (dl.lastT) {
      const dt = (now - dl.lastT) / 1000;
      const db = written - dl.lastWritten;
      if (dt > 0 && db > 0) $("dlSpeed").textContent = (db / dt / 1048576).toFixed(2) + " MB/s";
    }
    dl.lastWritten = written; dl.lastT = now;
  }
  function finishDlCard(text) {
    $("dlMsg").textContent = text || I18N.t("dl.saved");
    $("dlMsg").className = "dl-msg ok";
    $("dlFill").style.width = "100%";
    $("dlPct").textContent = "100%";
    $("dlSpeed").textContent = "";
    $("dlCancel").classList.add("hidden");
    $("dlOk").classList.remove("hidden");
  }
  function failDlCard(err) {
    $("dlMsg").textContent = err;
    $("dlMsg").className = "dl-msg err";
    $("dlCancel").classList.add("hidden");
    $("dlOk").classList.remove("hidden");
  }

  async function writeChunk(ft, handleId, offset, b64, total) {
    await ft.write(handleId, offset, b64);
    const n = atob(b64).length;
    dlProgress(offset + n, total);
    return offset + n;
  }

  async function downloadViaHost(it, name) {
    const ft = window.dbxPlugin.fileTransfer;
    openDlCard(name);
    let handleId = null;
    try {
      // 原生保存对话框：用户自选目录与文件名
      const target = await ft.beginSave({ name: name });
      if (!target) { // 用户在原生对话框中取消
        $("dlCard").classList.add("hidden");
        setStatus(I18N.t("download.cancelled") + name);
        return;
      }
      handleId = target.handleId;
      const CHUNK = Math.max(1024, Math.min(DL_CHUNK, target.chunkBytes || DL_CHUNK));

      let res = await invoke("objects/read", { bucket: state.bucket, path: it.name, offset: 0, limit: CHUNK }, { timeoutMs: 60000 });
      const total = Number(res.size) || 0;
      let offset = await writeChunk(ft, handleId, 0, res.content, total);
      while (offset < total && !dl.cancelled) {
        res = await invoke("objects/read", { bucket: state.bucket, path: it.name, offset: offset, limit: CHUNK }, { timeoutMs: 60000 });
        if (!res || !res.content) break;
        offset = await writeChunk(ft, handleId, offset, res.content, total);
      }
      if (dl.cancelled) {
        try { await ft.cancel(handleId); } catch (e) {}
        $("dlCard").classList.add("hidden");
        setStatus(I18N.t("download.cancelled") + name);
        return;
      }
      await ft.finish(handleId);
      finishDlCard();
      setStatus(I18N.t("download.doneName") + name + "（" + formatSize(total) + "）");
    } catch (e) {
      if (handleId != null) { try { await ft.cancel(handleId); } catch (_) {} }
      failDlCard(e.message || String(e));
      setStatus(I18N.t("download.fail") + (e.message || e));
    }
  }

  async function openDirPicker() {
    let def = "";
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.get === "function") {
        def = (await store.get("downloadDir")) || "";
      }
    } catch (e) {}
    const dir = await openPrompt(I18N.t("dl.dirTitle"), I18N.t("dl.dirPlaceholder"), def, I18N.t("dl.dirConfirm"));
    if (!dir) return null;
    return dir.trim();
  }

  async function downloadViaSidecar(it, name) {
    const dir = await openDirPicker();
    if (dir === null) { setStatus(I18N.t("download.cancelled") + name); return; }
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.set === "function") {
        await store.set("downloadDir", dir);
      }
    } catch (e) {}
    setStatus(I18N.t("download.status") + name + "（" + I18N.t("dl.dirTitle") + ": " + dir + "）");
    try {
      const res = await invoke("objects/save", { bucket: state.bucket, path: it.name, downloadDir: dir }, { timeoutMs: 600000 });
      setStatus(I18N.t("download.done") + res.path);
      showCopy(I18N.t("modal.copyTitle"), res.path);
    } catch (e) {
      setStatus(I18N.t("download.fail") + (e.message || e));
    }
  }

  async function doDownload(it) {
    const name = displayName(it);
    if (hasHostSave()) {
      await downloadViaHost(it, name);
    } else {
      await downloadViaSidecar(it, name);
    }
  }

  // 空值保护：避免元素缺失时对 null 赋 onclick 抛出 TypeError、进而中断整个脚本
  // （历史事故：index.html 缺 #dlCard 系列元素 → $("dlCancel") 为 null → 顶层抛错 → boot() 永不执行）
  const dlCardEl = $("dlCard");
  const dlCancelEl = $("dlCancel");
  const dlOkEl = $("dlOk");
  const dlCloseEl = $("dlClose");
  if (dlCancelEl) dlCancelEl.onclick = () => { dl.cancelled = true; };
  if (dlOkEl) dlOkEl.onclick = () => { if (dlCardEl) dlCardEl.classList.add("hidden"); };
  if (dlCloseEl) dlCloseEl.onclick = () => { if (dlCardEl) dlCardEl.classList.add("hidden"); };

  let presignExpiry = 86400; // 上次选择的有效期（秒），会话内记忆

  // ---------- 文件预览（图片/音视频/PDF 走 presign；文本/代码/MD 走分块读取） ----------
  const IMG_SET = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "avif"];
  const VID_SET = ["mp4", "webm", "m4v", "mov", "mkv"];
  const AUD_SET = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
  const TEXT_SET = ["txt", "md", "csv", "tsv", "log", "rst", "json", "xml", "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "go", "py", "java", "c", "h", "cpp", "hpp", "cs", "css", "scss", "yml", "yaml", "sh", "bat", "ps1", "sql", "toml", "ini", "proto", "dockerfile", "gitignore"];
  const PREVIEW_TEXT_CAP = 2 * 1024 * 1024;   // 文本预览上限 2MB
  const PREVIEW_BLOB_CAP = 20 * 1024 * 1024;  // 图片/PDF Blob 上限 20MB
  const PREVIEW_MEDIA_CAP = 64 * 1024 * 1024; // 音视频 Blob 上限 64MB
  const PREVIEW_CHUNK = 1024 * 1024;          // 预览分块 1MB（objects/read 单次上限 8MB 内）
  // 实测沙箱 CSP：img-src 'self' data: blob: → 远程 presign 直链被拦，媒体预览一律走 blob: URL。

  function previewKind(name) {
    const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = m ? m[1] : "";
    if (IMG_SET.indexOf(ext) >= 0) return "image";
    if (ext === "pdf") return "pdf";
    if (VID_SET.indexOf(ext) >= 0) return "video";
    if (AUD_SET.indexOf(ext) >= 0) return "audio";
    if (ext === "md" || ext === "markdown") return "markdown";
    if (TEXT_SET.indexOf(ext) >= 0) return "text";
    return null;
  }

  // CDN 懒加载（cdnjs 在宿主 CSP 白名单内）；失败降级纯文本，不阻塞预览
  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete scriptCache[src]; reject(new Error("load fail: " + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }
  function loadStyle(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.appendChild(l);
  }

  // 分块读取整对象为 Blob（沙箱 CSP 只放行 blob:，媒体预览统一走此路径）
  async function readObjectBlob(path, cap, onProgress) {
    const first = await invoke("objects/read", { bucket: state.bucket, path, offset: 0, limit: PREVIEW_CHUNK });
    const total = Number(first.size) || 0;
    if (cap && total > cap) throw new Error(I18N.t("preview.tooLarge"));
    const parts = [b64toBlob(first.content, "application/octet-stream")];
    let got = PREVIEW_CHUNK;
    if (onProgress) onProgress(Math.min(got, total), total);
    while (got < total) {
      const n = Math.min(PREVIEW_CHUNK, total - got);
      const r = await invoke("objects/read", { bucket: state.bucket, path, offset: got, limit: n });
      parts.push(b64toBlob(r.content, "application/octet-stream"));
      got += n;
      if (onProgress) onProgress(got, total);
    }
    return { blob: new Blob(parts), size: total };
  }

  // 分块读取文本（UTF-8），超出 cap 截断
  async function readObjectText(path, cap) {
    const first = await invoke("objects/read", { bucket: state.bucket, path, offset: 0, limit: PREVIEW_CHUNK });
    const total = Number(first.size) || 0;
    const limit = Math.min(total, cap);
    const parts = [b64toBlob(first.content, "application/octet-stream")];
    let got = PREVIEW_CHUNK;
    while (got < limit) {
      const n = Math.min(PREVIEW_CHUNK, limit - got);
      const r = await invoke("objects/read", { bucket: state.bucket, path, offset: got, limit: n });
      parts.push(b64toBlob(r.content, "application/octet-stream"));
      got += n;
    }
    const buf = await new Blob(parts).arrayBuffer();
    return { text: new TextDecoder("utf-8").decode(buf), truncated: total > limit, size: total };
  }

  function setPvMeta(text) { els.pvMeta.textContent = text || ""; }

  // 预览复制：仅文本类预览（text/code/markdown）可用，复制的是原始文本
  let pvCopyText = "";

  function setPvCopyAvailable(on) {
    if (els.pvCopy) els.pvCopy.classList.toggle("hidden", !on);
    if (!on) pvCopyText = "";
  }

  function bindPreviewButtons() {
    els.pvClose.onclick = closePreview;
    if (!els.pvCopy) return;
    els.pvCopy.onclick = async () => {
      if (!pvCopyText) return;
      const prev = els.pvMeta.textContent;
      try {
        await writeClipboard(pvCopyText);
        setPvMeta(I18N.t("preview.copied"));
      } catch (e) {
        setPvMeta(I18N.t("modal.copyFail"));
      }
      setTimeout(() => { setPvMeta(prev); }, 1500);
    };
  }

  function previewError(msg) {
    setPvCopyAvailable(false);
    els.pvBody.innerHTML = `<div class="pv-fail">${esc(msg)}</div>`;
  }

  function closePreview() {
    els.previewOverlay.classList.add("hidden");
    els.pvBody.innerHTML = ""; // 停掉 video/audio
  }

  async function openPreview(it) {
    const kind = previewKind(it.name);
    if (!kind) return;
    els.pvName.textContent = displayName(it);
    els.pvName.title = it.name;
    els.pvMeta.textContent = "";
    setPvCopyAvailable(false); // 加载中先隐藏复制按钮，文本类成功后再显示
    els.pvBody.innerHTML = `<div class="pv-loading">${I18N.t("status.loading")}</div>`;
    els.previewOverlay.classList.remove("hidden");
    const sizeText = it.size ? formatSize(it.size) : "";

    try {
      if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
        // 沙箱 CSP 只放行 blob: → 统一分块读取拼 Blob 后挂媒体元素
        const cap = (kind === "video" || kind === "audio") ? PREVIEW_MEDIA_CAP : PREVIEW_BLOB_CAP;
        try {
          const { blob } = await readObjectBlob(it.name, cap, (w, t) => {
            setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
          });
          const url = URL.createObjectURL(blob);
          let el;
          if (kind === "image") {
            el = document.createElement("img");
            el.className = "pv-img";
            el.alt = displayName(it);
            el.onload = () => setPvMeta(formatSize(blob.size));
          } else if (kind === "video") {
            el = document.createElement("video");
            el.className = "pv-media";
            el.controls = true;
            setPvMeta(formatSize(blob.size));
          } else if (kind === "audio") {
            el = document.createElement("audio");
            el.className = "pv-audio";
            el.controls = true;
            setPvMeta(formatSize(blob.size));
          } else {
            el = document.createElement("iframe");
            el.className = "pv-pdf";
            el.setAttribute("title", displayName(it));
            setPvMeta(formatSize(blob.size));
          }
          el.onerror = () => {
            el.onerror = null;
            previewError(I18N.t("preview.loadFail"));
          };
          el.src = url;
          els.pvBody.innerHTML = "";
          els.pvBody.appendChild(el);
          return;
        } catch (e) {
          previewError((e && e.message) ? e.message : String(e));
          return;
        }
      }

      if (kind === "markdown" || kind === "text") {
        const r = await readObjectText(it.name, PREVIEW_TEXT_CAP);
        setPvMeta(sizeText + (r.truncated ? " · " + I18N.t("preview.truncated") : ""));
        pvCopyText = r.text;
        setPvCopyAvailable(true);
        if (kind === "markdown") {
          try {
            await loadScript("https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js");
            const unsafe = window.marked.parse(r.text);
            // 自有文件渲染：剥离 script/事件属性后注入
            const safe = unsafe
              .replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/ on\w+="[^"]*"/gi, "");
            els.pvBody.innerHTML = `<div class="pv-md">${safe}</div>`;
          } catch (e) {
            renderCode(it.name, r.text);
          }
        } else {
          renderCode(it.name, r.text);
        }
        return;
      }
      previewError(I18N.t("preview.unsupported"));
    } catch (e) {
      previewError((e && e.message) ? e.message : String(e));
    }
  }

  function detectLang(name) {
    const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
    const map = { js: "javascript", mjs: "javascript", ts: "typescript", py: "python", yml: "yaml", md: "markdown", html: "xml", htm: "xml", sh: "bash", bat: "dos", ps1: "powershell" };
    return map[ext] || (ext || "plaintext");
  }

  function renderCode(name, text) {
    els.pvBody.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "pv-code";
    const code = document.createElement("code");
    code.textContent = text;
    pre.appendChild(code);
    els.pvBody.appendChild(pre);
    // 高亮为渐进增强：CDN 可用则高亮，失败保持纯文本
    loadStyle("https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css");
    loadScript("https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js")
      .then(() => {
        if (window.hljs) {
          code.className = "language-" + detectLang(name);
          try { window.hljs.highlightElement(code); } catch (e) { /* 降级纯文本 */ }
        }
      })
      .catch(() => {});
  }

  bindPreviewButtons();
  els.previewOverlay.addEventListener("mousedown", (e) => {
    if (e.target === els.previewOverlay) closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.previewOverlay.classList.contains("hidden")) closePreview();
  });

  function fallbackUrl(it) {
    const ep = state.endpoint || "";
    const scheme = ep.indexOf("http://") === 0 ? "http" : "https";
    const host = ep.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const key = it.name.split("/").map(encodeURIComponent).join("/");
    // S3 兼容端点（尤其 MinIO 自建）多为 path-style；阿里云为 virtual-host
    if (state.provider === "s3") return `${scheme}://${host}/${state.bucket}/${key}`;
    return `https://${state.bucket}.${host}/${key}`;
  }

  async function doCopyUrl(it) {
    if (!state.bucket) { setStatus(I18N.t("addr.missingEndpoint")); return; }
    // 询问有效期（秒）：60 ~ 7 天；取消则放弃
    const input = await openPrompt(
      I18N.t("presign.title"),
      I18N.t("presign.placeholder"),
      String(presignExpiry),
      I18N.t("modal.ok")
    );
    if (input == null || input === "") return;
    const expires = Math.min(604800, Math.max(60, parseInt(input, 10) || 86400));
    presignExpiry = expires;
    try {
      const r = await invoke("objects/presign", { bucket: state.bucket, path: it.name, expires });
      const exp = expires >= 3600 && expires % 3600 === 0 ? (expires / 3600) + "h" : expires + "s";
      setStatus(I18N.t("presign.ok") + " (" + exp + ")");
      showCopy(I18N.t("presign.title") + " · " + exp, r.url);
    } catch (e) {
      // 预签名失败（如 RAM 无 SignURL 权限）：回退拼接地址（仅公共读场景可用）
      setStatus(I18N.t("presign.fail") + (e.message || e));
      showCopy(I18N.t("copy.title") + " · " + I18N.t("presign.fallback"), fallbackUrl(it));
    }
  }

  async function doDelete(it) {
    const name = displayName(it);
    const tip = it.isDir
      ? I18N.t("delete.dirTip", { name })
      : I18N.t("delete.fileTip", { name });
    const ok = await openConfirm(I18N.t("modal.confirmTitle"), tip);
    if (!ok) return;
    try {
      await invoke("objects/delete", { bucket: state.bucket, path: it.name });
      setStatus(I18N.t("delete.status") + name);
      resetPaging();
      loadPage("");
    } catch (e) {
      setStatus(I18N.t("delete.fail") + (e.message || e));
    }
  }

  // 进入目录：单击行内任意位置（名称/空白）或行内「打开」均可触发。
  // 不再依赖原生 dblclick——宿主 webview 对其支持不稳定，且列表虚拟化重绘会销毁行节点，
  // 而原生 dblclick 要求两次 click 命中同一 DOM 节点，稍有重绘就永不触发（曾导致“双击/打开都进不去”）。
  // navCooldown 仅用于抑制“双击”时第二下 click 造成的重复进入。
  let navCooldownUntil = 0;
  function enterDir(it) {
    const now = Date.now();
    if (now < navCooldownUntil) return;
    navCooldownUntil = now + 300;
    openDir(it);
  }

  // ---- 指针/鼠标事件：文档级捕获委托（绕开行节点被虚拟化重绘销毁的问题） ----
  // 业务统一在「抬升型」事件上触发（click / pointerup / mouseup），同一手势 350ms 内只处理一次。
  let lastActAt = 0;
  let downX = 0, downY = 0;

  // 是否位于弹窗/浮层内（连接对话框、通用模态框、复制弹窗、下载浮窗）。
  // 这些层叠在列表之上，其中的输入框/按钮点击绝不能被当成“点了某一行”。
  function inFloatingLayer(el) {
    return !!(el && el.closest && el.closest("#connectOverlay, #modal, #copyModal, #dlCard, #previewOverlay"));
  }

  // 按坐标定位行：即使点击事件的目标不是 .row（被遮挡/落在容器上），也能根据 Y 坐标算出是哪一行。
  function rowIndexAt(clientX, clientY) {
    const r = els.list.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return -1;
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return -1;
    // 坐标兜底必须确认命中点最顶层的元素确实属于列表本身，
    // 否则弹窗/浮层覆盖在列表之上时，纯坐标算法会误命中下面的行。
    const top = document.elementFromPoint(clientX, clientY);
    if (!top || !els.list.contains(top)) return -1;
    const y = clientY - r.top + els.list.scrollTop;
    const i = Math.floor(y / ROW_H);
    return (i >= 0 && i < state.items.length) ? i : -1;
  }

  function actOnRow(idx, it, act) {
    // 选中高亮：仅切换 class，不整列重绘（避免销毁行元素）
    state.selectedIndex = idx;
    els.listContent.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
    const rowEl = els.listContent.querySelector('.row[data-i="' + idx + '"]');
    if (rowEl) rowEl.classList.add("selected");

    if (act === "preview") { openPreview(it); return; }
    if (act === "download") { doDownload(it); return; }
    if (act === "addr") { doCopyUrl(it); return; }
    if (act === "delete") { doDelete(it); return; }
    if (act === "open") { enterDir(it); return; }
    if (it.isDir) enterDir(it);
  }

  function onDocEvent(type, e) {
    // 1) 按下：只记坐标（用于判断是否拖拽/滚动）
    if (type === "pointerdown" || type === "mousedown") { downX = e.clientX; downY = e.clientY; return; }
    if (type !== "click" && type !== "pointerup" && type !== "mouseup") return;

    // 2) 业务：抬升型事件。先按行元素判定，失败则按坐标兜底（应对遮挡/目标非 .row）。
    if (type !== "click" && (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8)) return; // 拖拽/滚动

    // 弹窗/浮层内的点击（输入框、按钮、空白）一律不参与列表与工具栏委托
    if (inFloatingLayer(e.target)) return;

    if (Date.now() - lastActAt < 350) return;

    // 2a0) 复选框（含表头全选）：优先于行点击分派，避免勾选触发行导航
    const allEl = e.target.closest && e.target.closest("[data-selall]");
    if (allEl) { lastActAt = Date.now(); toggleSelectAll(); return; }
    const ckEl = e.target.closest && e.target.closest("[data-ck]");
    if (ckEl) { lastActAt = Date.now(); toggleSel(ckEl.getAttribute("data-ck")); return; }

    // 2a) 功能按钮：文档级委托分派（不依赖 els.* 属性绑定）
    const btn = e.target.closest && e.target.closest("button");
    if (btn && btn.id) {
      const id = btn.id;
      if (id === "refreshBtn") { lastActAt = Date.now(); doRefresh(); return; }
      if (id === "mkdirBtn") { lastActAt = Date.now(); doMkdir(); return; }
      if (id === "uploadBtn") { lastActAt = Date.now(); doUpload(); return; }
      if (id === "upBtn") { lastActAt = Date.now(); doUp(); return; }
      if (id === "connBtn") { lastActAt = Date.now(); openConnDialog(); return; }
      if (id === "batchDeleteBtn") { lastActAt = Date.now(); doBatchDelete(); return; }
      if (id === "batchDownloadBtn") { lastActAt = Date.now(); doBatchDownload(); return; }
      if (id === "batchClearBtn") { lastActAt = Date.now(); state.sel.clear(); renderVisible(); updateBatchUI(); return; }
    }

    // 2b) 行：优先取最近的 .row，取不到再用坐标兜底
    const rowEl = e.target.closest && e.target.closest(".row");
    let idx = rowEl ? +rowEl.getAttribute("data-i") : -1;
    // data-act 从最近的带属性祖先取：点击图标中心时 target 是内层 <svg>，自身没有 data-act
    const opEl = (e.target.closest && e.target.closest("[data-act]")) || null;
    let act = opEl ? (opEl.getAttribute("data-act") || "-") : "-";
    if (idx < 0) { idx = rowIndexAt(e.clientX, e.clientY); act = "-"; }
    if (idx < 0) return;

    const it = state.items[idx];
    if (!it) return;

    lastActAt = Date.now();
    actOnRow(idx, it, act);
  }

  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
    document.addEventListener(t, (e) => onDocEvent(t, e), true);
  });

  // ---------- 工具栏 ----------
  // 注意：这些动作不再用 els.*.onclick 属性绑定，而是由文档级事件委托按 id 调用
  // （见 onDocEvent 的“功能按钮”分派）。某些宿主会重建/包裹 DOM，属性绑定会失效，
  // 而委托挂在 document 上不受影响——这正是“内联 onclick 有效、JS 绑定无效”的解法。
  async function doMkdir() {
    if (!state.connected) { setStatus(I18N.t("common.notConnected")); return; }
    if (!state.bucket) { setStatus(I18N.t("mkdir.enterBucket")); return; }
    const name = await openPrompt(I18N.t("modal.mkdirTitle"), I18N.t("modal.mkdirPlaceholder"), "", I18N.t("modal.mkdirConfirm"));
    if (!name) return;
    const key = state.prefix + name.replace(/\/+$/, "") + "/";
    try {
      await invoke("objects/write", { bucket: state.bucket, path: key, content: "", mime: "" });
      setStatus(I18N.t("mkdir.done") + key);
      loadPage("");
    } catch (e) {
      setStatus(I18N.t("mkdir.fail") + (e.message || e));
    }
  }

  function doUpload() {
    if (!state.connected) { setStatus(I18N.t("common.notConnected")); return; }
    if (!state.bucket) { setStatus(I18N.t("upload.enterBucket")); return; }
    els.fileInput.click();
  }
  // 大文件分片上传：256KB/片 base64 直发 sidecar 顺序落临时文件，
  // complete 时由驱动流式上转（阿里云分片并发 / MinIO 自动 multipart）。
  // 单条 RPC 负载小不超时、内存恒定、可随时取消。
  const UP_CHUNK = 256 * 1024;
  els.fileInput.onchange = async () => {
    const f = els.fileInput.files[0];
    els.fileInput.value = "";
    if (!f || !state.connected) return;
    if (!state.bucket) { setStatus(I18N.t("upload.enterBucket")); return; }
    const key = state.prefix + f.name;
    openDlCard(f.name, "upload");
    let uploadId = null;
    try {
      const beg = await invoke("upload/begin", { bucket: state.bucket, path: key, size: f.size, mime: f.type || "" });
      uploadId = beg.uploadId;
      let offset = 0;
      while (offset < f.size) {
        if (dl.cancelled) {
          try { await invoke("upload/abort", { uploadId }); } catch (e) { /* 幂等 */ }
          throw new Error(I18N.t("upload.cancelled"));
        }
        const buf = await f.slice(offset, offset + UP_CHUNK).arrayBuffer();
        const r = await invoke("upload/chunk", { uploadId, offset, content: base64FromArrayBuffer(buf) });
        offset = (r && typeof r.written === "number") ? r.written : offset + buf.byteLength;
        dlProgress(offset, f.size);
      }
      await invoke("upload/complete", { uploadId }, { timeoutMs: 600000 });
      finishDlCard(I18N.t("upload.done") + key);
      setStatus(I18N.t("upload.done") + key);
      loadPage("");
    } catch (e) {
      if (uploadId) { try { await invoke("upload/abort", { uploadId }); } catch (e2) { /* 幂等 */ } }
      const msg = (e && e.message) ? e.message : String(e);
      failDlCard(msg);
      setStatus(I18N.t("upload.fail") + msg);
    }
  };

  function doRefresh() {
    resetPaging();
    loadPage("");
  }

  function doUp() {
    if (state.prefix) {
      const parts = state.prefix.replace(/\/$/, "").split("/").filter(Boolean);
      parts.pop();
      navigate(parts.length ? parts.join("/") + "/" : "");
    } else if (state.bucket) {
      state.bucket = "";
      state.search = "";
      els.searchInput.value = "";
      resetPaging();
      loadPage("");
    }
  }

  els.searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    state.search = els.searchInput.value.trim();
    resetPaging();
    loadPage("");
  });

  // 语言变化（宿主 init 完成 / 运行时切换语言）后重绘动态文案。
  // 静态 [data-i18n*] 由 I18N.apply() 自行处理；这里只管 JS 生成的：面包屑、列表行、状态栏。
  I18N.onChange(() => {
    updateProviderUI(); // 接入点帮助文案随语言刷新
    if (state.connected) {
      renderBreadcrumb();
      renderList();
      setStatus(state.hasMore
        ? I18N.t("status.loadedMore", { n: state.items.length })
        : I18N.t("status.loaded", { n: state.items.length }));
    } else {
      setStatus(I18N.t("status.notConnected"));
    }
  });

  // ---------- 启动 ----------
  async function boot() {
    await window.dbxPlugin.ready;
    // 宿主 init 后语言才准确：先按宿主注入的 locale 刷新一次，再渲染界面文案。
    I18N.refresh(true);
    buildSwatches();

    const meta = await loadMeta();
    if (meta) {
      els.fName.value = meta.name || "Storage";
      els.fProvider.value = meta.provider === "s3" ? "s3" : "aliyun";
      els.fEndpoint.value = meta.endpoint || "";
      els.fBucket.value = meta.bucket || "";
      els.fAk.value = meta.accessKeyId || "";
      els.fSk.value = meta.accessKeySecret || "";
      if (els.fRegion) els.fRegion.value = meta.region || "";
      if (els.fPathStyle) els.fPathStyle.checked = !!meta.pathStyle;
      if (meta.color) { selectedColor = meta.color; buildSwatches(); }
      if (meta.pageSize) state.pageSize = meta.pageSize;
      if (els.fPageSize) els.fPageSize.value = state.pageSize;
      updateProviderUI();
    }

    // 宿主托管的连接：凭据可能通过 context.connection 下发（标准生命周期形状）。
    // 优先用宿主下发的配置覆盖本地 storage 的回填值。
    let ctxConn = null;
    const ctx = (window.dbxPlugin && window.dbxPlugin.context) || {};
    if (ctx.connectionId) state.connectionId = ctx.connectionId;
    const c = ctx.connection;
    if (c) {
      const ec = c.external_config || {};
      const sec = c.connection_secrets || {};
      const endpoint = ec.endpoint || c.endpoint || "";
      const ak = ec.access_key_id || c.accessKeyId || "";
      const sk = sec.access_key_secret || c.accessKeySecret || "";
      const bucket = ec.bucket || c.bucket || "";
      const provider = ec.provider || c.provider || "aliyun";
      const region = ec.region || c.region || "";
      const pathStyle = String(ec.path_style || "").toLowerCase() === "true";
      if (endpoint || ak || sk) {
        ctxConn = { endpoint, accessKeyId: ak, accessKeySecret: sk, bucket, name: c.name || "" };
        if (ctxConn.name) els.fName.value = ctxConn.name;
        els.fProvider.value = provider === "s3" ? "s3" : "aliyun";
        els.fEndpoint.value = endpoint;
        els.fBucket.value = bucket;
        els.fAk.value = ak;
        els.fSk.value = sk;
        if (els.fRegion) els.fRegion.value = region;
        if (els.fPathStyle) els.fPathStyle.checked = pathStyle;
        updateProviderUI();
      }
    }

    if (meta && !ctxConn) msg(I18N.t("conn.loaded"));

    // 宿主已自动连接（凭据在 Sidecar 内存）：直接进入浏览器视图
    try {
      const st = await invoke("connection/status", {});
      if (st && st.connected) {
        state.connected = true;
        state.provider = st.provider === "s3" ? "s3" : "aliyun";
        state.endpoint = st.endpoint || "";
        state.bucket = st.bucket || "";
        state.prefix = "";
        updateEndpointLabel();
        state.pageSize = Math.min(1000, Math.max(10, state.pageSize || 200));
        enterBrowser();
        return;
      }
    } catch (e) { /* 后端未就绪则回退到连接表单 */ }

    // 宿主托管连接但还未自动连：用 context 下发的凭据自动连接，免去手填 AK/Secret
    if (ctxConn && ctxConn.accessKeyId && ctxConn.accessKeySecret) {
      await doConnect();
      return;
    }
  }

  boot();
})();
