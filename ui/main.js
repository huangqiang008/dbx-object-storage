(function () {
  "use strict";

  const COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444", "#3b82f6", "#a855f7"];
  let selectedColor = COLORS[4];

  // 构建版本号：必须与 manifest.json 的 version 及 backend 的 pluginVersion 一致。
  // 常驻显示在状态栏，用于确认宿主实际加载的是哪个版本（排查"改了却没生效"）。
  // 发版时三处（manifest.json / backend/oss.go / 此处）需一并修改。
  const BUILD = "1.1.2";

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
    // 排序：key ∈ name|size|modified，desc 为是否倒序。
    // dirsFirst 恒为 true——目录永远排在文件前面，这是文件管理器的通用预期，
    // 两个驱动返回时也已做分组，这里保持一致。
    sortKey: "name",
    sortDesc: false,
    // rememberSk: 用户勾选后允许把 Secret 存进本机 storage。
    // 默认 false —— 高敏凭据不落盘；勾选是显式取舍，由用户自己决定。
    rememberSk: false,
    // readOnly: 只读连接。为 true 时隐藏所有写入口（上传/新建/改名/删除）。
    // 这是体验层的第一道防线；真正的边界在后端 handler 的 requireWritable 守卫，
    // 前端隐藏只是避免用户点了才报错。
    readOnly: false,
    // showPublicAcl: 是否在列表里扫描并标出「公共读」对象。默认关闭——
    // 逐对象读取 ACL 是一次额外服务端 API 调用（见 objects/get_acl_batch），
    // 打开后会在每次进入目录时扫描当前页，故默认不自动跑，避免无谓的额度消耗。
    // 用户手动切换对象公开/私有时，行内徽标仍会立即反映（走本地状态，与开关无关）。
    showPublicAcl: false,
    // aclKnown: 已查询过 ACL 的对象 key 集合，避免重复扫描同一对象。
    aclKnown: new Set(),
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
    uploadDirBtn: $("uploadDirBtn"),
    refreshBtn: $("refreshBtn"),
    connBtn: $("connBtn"),
    mkdirBtn: $("mkdirBtn"),
    upBtn: $("upBtn"),
    searchInput: $("searchInput"),
    countLabel: $("countLabel"),
    colName: $("colName"),
    colSize: $("colSize"),
    colTime: $("colTime"),
    endpointLabel: $("endpointLabel"),
    fileInput: $("fileInput"),
    previewOverlay: $("previewOverlay"),
    pvIcon: $("pvIcon"),
    pvName: $("pvName"),
    pvMeta: $("pvMeta"),
    pvBody: $("pvBody"),
    pvCopy: $("pvCopy"),
    pvEdit: $("pvEdit"),
    pvSave: $("pvSave"),
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
    fRememberCk: $("fRememberCk"),
    fReadOnly: $("fReadOnlyCk"),
    connMsg: $("connMsg"),
    testBtn: $("testBtn"),
    saveBtn: $("saveBtn"),
  };

  // ---------- 通用工具 ----------
  // esc / formatSize / fmtTime / base64FromArrayBuffer / b64ToBuffer 已抽到 utils.js，
  // svg() 与图标表已抽到 icons.js。此处只留与业务状态相关的部分。
  const { esc, formatSize, fmtTime, base64FromArrayBuffer, b64ToBuffer } = window.Utils;
  const svg = window.ICONS.svg;

  // 状态栏：常规状态 + 常驻版本号（便于确认宿主实际加载的版本）。
  // 错误消息红色常驻（需下一条消息覆盖），普通消息 6s 后自动淡出为版本号，
  // 避免“提示已删除、日志早已滚走”或“一个旧提示挂了一整天”。
  let statusFadeTimer = 0;
  function setStatus(t, isErr) {
    const el = els.statusText || els.status;
    el.textContent = (t ? t + "  " : "") + "· v" + BUILD;
    el.classList.toggle("err", !!isErr);
    if (statusFadeTimer) { clearTimeout(statusFadeTimer); statusFadeTimer = 0; }
    if (t && !isErr) {
      statusFadeTimer = setTimeout(() => {
        statusFadeTimer = 0;
        el.textContent = "· v" + BUILD;
        el.classList.remove("err");
      }, 6000);
    }
  }
  function msg(t, isErr) {
    els.connMsg.textContent = t || "";
    els.connMsg.classList.toggle("err", !!isErr);
  }
  function invoke(method, params, opts) {
    return window.dbxPlugin.invoke(method, params, Object.assign({ timeoutMs: 30000 }, opts || {}));
  }
  // updateEndpointLabel 渲染端点标签。
  // 只读标记也在这里拼（而不是分散到别处）：标签内容由「端点 + 只读态」共同决定，
  // 任何一处单独更新都可能把另一个信息覆盖掉。
  function updateEndpointLabel() {
    if (!els.endpointLabel) return;
    if (!state.endpoint) { els.endpointLabel.textContent = ""; els.endpointLabel.classList.remove("ro"); return; }
    const tag = state.provider === "s3" ? "S3" : "OSS";
    const base = tag + ": " + state.endpoint;
    if (state.readOnly) {
      els.endpointLabel.textContent = base + "  ·  " + I18N.t("conn.readOnlyBadge");
      els.endpointLabel.classList.add("ro");
    } else {
      els.endpointLabel.textContent = base;
      els.endpointLabel.classList.remove("ro");
    }
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
    // 进入新目录/新搜索：此前已扫描的 ACL 属于别的目录，作废以便重新扫描
    state.aclKnown.clear();
    // 作废在途请求：调用方紧接着会 loadPage，不作废的话旧响应会写进新列表
    invalidateList();
    updateBatchUI();
  }

    // ---------- 「在本机记住 Secret」勾选 ----------
  // 复用列表用的 .ckbox 自绘样式（沙箱 webview 对原生 checkbox 的 change 事件
  // 与文档级委托存在冲突，历史代码已统一避开原生控件）。
  function renderRememberCk() {
    const el = els.fRememberCk;
    if (!el) return;
    el.classList.toggle("on", state.rememberSk);
    el.setAttribute("aria-checked", state.rememberSk ? "true" : "false");
    // 图标仅在选中时可见（与列表勾选框行为一致）
    el.innerHTML = svg("check", 11);
  }

  function toggleRememberSk() {
    state.rememberSk = !state.rememberSk;
    renderRememberCk();
  }

  // ---------- 只读守卫 ----------
  // 所有写操作的统一入口检查。UI 上写按钮已隐藏，但键盘快捷键（Delete / F2）、
  // 右键菜单等路径仍可能触发，不能只靠「藏按钮」当权限控制。
  // 后端 requireWritable 是最终边界，这里只负责给出可理解的提示。
  function guardWritable() {
    if (!state.readOnly) return true;
    setStatus(I18N.t("ro.blocked"), true);
    return false;
  }

  // ---------- 「只读模式」勾选 ----------
  // 与「记住 Secret」同样复用自绘 .ckbox（沙箱 webview 避开原生 checkbox）。
  function renderReadOnlyCk() {
    const el = els.fReadOnly;
    if (!el) return;
    el.classList.toggle("on", state.readOnly);
    el.setAttribute("aria-checked", state.readOnly ? "true" : "false");
    el.innerHTML = svg("check", 11);
  }

  function toggleReadOnly() {
    state.readOnly = !state.readOnly;
    renderReadOnlyCk();
  }

  // ---------- 连接配置持久化（Secret 依 rememberSk 决定是否落盘） ----------
    // 安全：Secret 属高敏凭据，绝不写入插件 storage（明文可读）。
    // 需要免重填的推荐用法是由宿主托管连接（manifest 的 connection-provider
    // 声明 binding:"secret"，凭据经 context.connection.connection_secrets 下发，
    // 见 boot()）。插件自建表单只持久化非敏感项，重连时需重新输入 Secret。
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
      // 只读模式：勾选后本连接的所有写操作（上传/新建/改名/删除）被拒绝。
      // 宿主托管的连接由宿主侧 connection.read_only 决定，此处仅对
      // 插件自带表单有效；后端 requireWritable 是最终边界。
      readOnly: !!(els.fReadOnly && els.fReadOnly.checked),
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
    state.readOnly = !!cfg.readOnly;
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
      // Secret 仅在用户显式勾选「在本机记住」时才落盘（明文，仅本插件可读）。
      // 未勾选时写入空串而非省略字段：省得下次读到残留的旧 secret 造成误判。
      accessKeySecret: state.rememberSk ? cfg.accessKeySecret : "",
      region: cfg.region,
      pathStyle: cfg.pathStyle,
      color: selectedColor,
      pageSize: state.pageSize,
      rememberSk: state.rememberSk,
    });
    updateEndpointLabel();
    enterBrowser();
  }

  function enterBrowser() {
    els.overlay.classList.add("hidden");
    els.browserView.classList.remove("hidden");
    applyReadOnlyUI();
    applyColWidths(); // 显示后才能拿到真实表头宽度，据此放置拖拽手柄
    // 同步「公开状态」开关的视觉态（跨连接保持会话内的开关状态）
    const pb = $("pubAclBtn");
    if (pb) pb.classList.toggle("on", !!state.showPublicAcl);
    // 首次进入或从连接对话框返回：作废可能在途的旧请求
    invalidateList();
    renderBreadcrumb();
    loadPage("");
  }

  // applyReadOnlyUI 按只读状态显隐全部写入口。
  //
  // 这是体验层的第一道防线：只读连接下用户不该看到上传/新建/改名/删除。
  // 真正的边界在后端 handler 的 requireWritable（任何绕过 UI 的调用都会被拒）。
  // 两层都要有——只有 UI 限制等于没有限制，只有后端限制则体验割裂。
  function applyReadOnlyUI() {
    const ro = !!state.readOnly;
    // 工具栏写按钮
    if (els.mkdirBtn) els.mkdirBtn.classList.toggle("hidden", ro);
    if (els.uploadBtn) els.uploadBtn.classList.toggle("hidden", ro);
    if (els.uploadDirBtn) els.uploadDirBtn.classList.toggle("hidden", ro);
    // 端点标签（含只读标记）由 updateEndpointLabel 统一渲染
    updateEndpointLabel();
    // 批量条：只读时只剩「取消选择」，删除按钮需隐藏
    const delBtn = $("batchDeleteBtn");
    if (delBtn) delBtn.classList.toggle("hidden", ro);
    // 已选中的项在只读模式下无意义（没有可执行的批量写操作），清空避免困惑
    if (ro && state.sel.size > 0) {
      state.sel.clear();
      updateBatchUI();
    }
    // 列表右键菜单需要重绘才能反映动作表变化
    renderVisible();
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
  // 「公开状态」开关：开启后扫描当前目录并标出公共读对象（见 refreshAcl）。
  // 关闭则停止扫描；用户手动切换的公开/私有徽标仍会保留。
  const pubAclBtn = $("pubAclBtn");
  if (pubAclBtn) {
    pubAclBtn.onclick = () => {
      state.showPublicAcl = !state.showPublicAcl;
      pubAclBtn.classList.toggle("on", state.showPublicAcl);
      if (state.showPublicAcl) {
        // 重新扫描：清空已知集合以便把已加载对象重新纳入扫描
        state.aclKnown.clear();
        refreshAcl();
        setStatus(I18N.t("public.scanOn"));
      } else {
        setStatus(I18N.t("public.scanOff"));
      }
    };
  }
  els.saveBtn.onclick = doConnect;
  els.fProvider.addEventListener("change", updateProviderUI);

  // 「记住 Secret」勾选：点击整行（含文字）都生效，键盘 Space/Enter 亦可。
  // 绑定在 label 上，整行可点；ckbox 自身是 span，事件冒泡到 label 统一处理。
  if (els.fRememberCk) {
    const rememberLabel = els.fRememberCk.closest(".remember-line");
    if (rememberLabel) {
      rememberLabel.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // 避免冒泡到 overlay 的 mousedown 触发关闭对话框
        toggleRememberSk();
      });
      rememberLabel.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggleRememberSk();
        }
      });
    }
  }

  // 「只读模式」勾选：交互与「记住 Secret」一致。
  if (els.fReadOnly) {
    const roLabel = els.fReadOnly.closest(".remember-line");
    if (roLabel) {
      roLabel.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleReadOnly();
      });
      roLabel.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggleReadOnly();
        }
      });
    }
  }

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
  // Secret 明文切换：默认 password，点击 eye 在明/暗之间互换
  $("skEye").onclick = () => {
    const show = els.fSk.type === "password";
    els.fSk.type = show ? "text" : "password";
    $("skEye").innerHTML = svg(show ? "eyeOff" : "eye", 15);
    $("skEye").title = I18N.t("sk.eye");
  };
  function openConnDialog() {
    msg("");
    els.overlay.classList.remove("hidden");
    // 打开即聚焦名称并全选：中途改参/新建都是最高频的下一步
    setTimeout(() => { try { els.fName.focus(); els.fName.select(); } catch (e) { /* 忽略 */ } }, 30);
  }

  // ---------- 通用内嵌模态框（替代原生 prompt/confirm） ----------
  const modal = $("modal");
  const modalTitle = modal.querySelector(".modal-title");
  const modalInput = $("modalInput");
  const modalMsg = modal.querySelector(".modal-msg");
  const modalDetail = modal.querySelector(".modal-detail");
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
      setModalDetail("");
      modalOk.textContent = confirmText || I18N.t("modal.ok");
      modal.classList.remove("hidden");
      setTimeout(() => modalInput.focus(), 30);
    });
  }
  // detail：长标识（对象 key / 路径）单独一行展示。塞进正文会把句子劈成两段，
  // 且无空格长串的断行位置不可控——所以正文保持完整成句，标识放到这里。
  function setModalDetail(text) {
    if (!modalDetail) return;
    modalDetail.textContent = text || "";
    modalDetail.classList.toggle("hidden", !text);
  }
  // 二次确认：返回 true/false
  function openConfirm(title, message, detail) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      modalTitle.textContent = title;
      modalInput.style.display = "none";
      modalMsg.textContent = message;
      setModalDetail(detail);
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
  const copyArea = $("copyArea");
  const copyHint = $("copyHint");
  let copyText = "";

  // multiline=true 时显示多行 textarea（批量复制地址等长文本场景）
  function showCopy(title, text, multiline, hint) {
    copyTitle.textContent = title;
    copyText = text;
    const boxEl = copyModal.querySelector(".modal-box");
    if (boxEl) boxEl.classList.toggle("modal-box-bulky", !!multiline);
    const box = multiline ? copyArea : copyInput;
    if (copyInput) copyInput.classList.toggle("hidden", !!multiline);
    if (copyArea) copyArea.classList.toggle("hidden", !multiline);
    if (box) box.value = text;
    copyHint.textContent = hint || "";
    copyModal.classList.remove("hidden");
    setTimeout(() => { if (box) { box.focus(); box.select(); } }, 30);
  }

  // 批量操作上限：下载 / 复制地址都受其约束。选择集会跨页累积（F3+翻页），
  // 上万项会让串行下载或逐条签名跑数小时甚至崩溃，超出时提示并按列表顺序截断。
  const BATCH_CAP = 1000;

  // batchPick：取选中文件（非目录，保持列表顺序）；超过上限时弹确认框，
  // 用户确认则截断到前 CAP 项，取消则放弃本次操作。
  async function batchPick(cap, scope) {
    const items = state.items.filter(scope);
    if (!items.length) return null;
    if (items.length > cap) {
      const ok = await openConfirm(
        I18N.t("batch.capTitle"),
        I18N.t("batch.overCap", { n: items.length, cap })
      );
      if (!ok) return null;
      return items.slice(0, cap);
    }
    return items;
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

  // ---------- 对象详情面板 ----------
  // 展示单个对象的完整元数据。列表里的「类型/大小」列只给出 MIME 与大小，
  // 这里补齐 ETag、精确时间戳、完整存储键等排障时真正需要的信息。
  const detailModal = $("detailModal");
  const detailGrid = $("detailGrid");
  const detailTitle = $("detailTitle");
  let detailKey = "";

  function detailRow(label, value, mono) {
    return `<div class="detail-row">`
      + `<span class="detail-label">${esc(label)}</span>`
      + `<span class="detail-value${mono ? " mono" : ""}">${esc(value == null ? "" : String(value))}</span>`
      + `</div>`;
  }

  async function openDetail(it) {
    if (!state.bucket) return;
    detailKey = it.name;
    detailTitle.textContent = displayName(it);
    detailGrid.innerHTML = detailRow(I18N.t("detail.loading"), "…");
    detailModal.classList.remove("hidden");
    try {
      const st = await invoke("objects/stat", { bucket: state.bucket, path: it.name }, { timeoutMs: 30000 });
      // 目录没有 stat 元数据（对象存储里目录只是逻辑前缀），直接用列表项信息
      if (it.isDir) {
        detailGrid.innerHTML =
          detailRow(I18N.t("detail.type"), I18N.t("detail.typeDir")) +
          detailRow(I18N.t("detail.bucket"), state.bucket) +
          detailRow(I18N.t("detail.key"), it.name, true);
        return;
      }
      const size = st && st.size != null ? Number(st.size) : it.size;
      detailGrid.innerHTML =
        detailRow(I18N.t("detail.type"), (st && st.mime) || it.mime || "") +
        detailRow(I18N.t("detail.size"), formatSize(size)) +
        detailRow(I18N.t("detail.sizeBytes"), String(size) + " B") +
        detailRow(I18N.t("detail.modified"), (st && st.modified) ? fmtTime(st.modified) : (it.modified ? fmtTime(it.modified) : "")) +
        detailRow(I18N.t("detail.etag"), (st && st.etag) || "") +
        detailRow(I18N.t("detail.bucket"), state.bucket) +
        detailRow(I18N.t("detail.key"), it.name, true);
    } catch (e) {
      // stat 失败不阻塞查看：退化为展示列表项已有信息
      detailGrid.innerHTML =
        detailRow(I18N.t("detail.type"), it.mime || "") +
        detailRow(I18N.t("detail.size"), formatSize(it.size)) +
        detailRow(I18N.t("detail.key"), it.name, true) +
        detailRow(I18N.t("detail.statFailed"), (e && e.message) || String(e));
    }
  }

  $("detailClose").onclick = () => detailModal.classList.add("hidden");
  $("detailCopyKey").onclick = async () => {
    if (!detailKey) return;
    try {
      await writeClipboard(detailKey);
      setStatus(I18N.t("detail.copied"));
    } catch (e) {
      setStatus(I18N.t("modal.copyFail"), true);
    }
  };
  detailModal.addEventListener("mousedown", (e) => {
    if (e.target === detailModal) detailModal.classList.add("hidden");
  });
  detailModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") detailModal.classList.add("hidden");
  });

  // ---------- 浏览（bucket 感知 + 分页 + 虚拟化 + 前缀过滤） ----------
  const ROW_H = 32;

  // 请求代次（generation）：每次「重置列表」自增。
  // loadPage 捕获进入时的代次，await 之后先比对是否已过期——过期就直接丢弃结果，
  // 不再写入 state.items、不再渲染。
  //
  // 为什么不用 state.loading 布尔：它在 await 期间为 true，会挡住并发请求，
  // 但切目录时导航并不经过 loadPage 的入口判断，旧请求照样能在新目录里落地，
  // 把上一个目录的数据渲染出来（搜索 + 快速切换目录即可复现）。
  let listGen = 0;

  // invalidateList 作废当前所有在途列表请求（切目录/改搜索/刷新时调用）
  function invalidateList() {
    listGen++;
    state.loading = false;
  }

  async function loadPage(marker) {
    if (state.loading) return;
    const gen = listGen;
    state.loading = true;
    state.loadError = "";
    if (!marker && !state.items.length) { ensureListExtras(); if (skelNode) skelNode.classList.remove("hidden"); }
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
        // 过期响应：目录/搜索条件已变，丢弃整份结果，避免污染新目录
        if (gen !== listGen) return;
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
      // buckets/list 分支同样需要这道校验（其 await 之后才有 items）
      if (gen !== listGen) return;
      state.items = state.items.concat(items);
      // 排序必须在每次加载后执行：翻页追加的对象也要纳入当前排序
      applySort();
      renderBreadcrumb();
      renderList();
      updateSortIndicators();
      // 扫描「公共读」徽标（若用户开启了该开关）：仅拉取尚未查过的对象，
      // 异步进行、不阻塞浏览；出错仅影响徽标，不中断列表。
      refreshAcl();
      setStatus(state.hasMore
        ? I18N.t("status.loadedMore", { n: state.items.length })
        : I18N.t("status.loaded", { n: state.items.length }));
    } catch (e) {
      if (gen !== listGen) return; // 过期请求的失败不打扰当前视图
      state.loadError = (e && e.message) ? e.message : String(e);
      setStatus(I18N.t("status.loadFail") + (e && e.message ? e.message : e), true);
    } finally {
      // 只清理自己这一代的状态：避免旧请求的 finally 把新请求的 loading 提前置否
      if (gen === listGen) {
        state.loading = false;
        if (skelNode) skelNode.classList.add("hidden");
        renderEmptyState();
      }
    }
  }

  // ---------- 空状态 / 加载骨架 ----------
  // 列表为空时给出可行动的引导（上传/新目录/清除过滤/重试），
  // 首屏加载时展示 shimmer 骨架，避免“白屏像挂了一样”。
  let emptyNode = null;
  let skelNode = null;

  function ensureListExtras() {
    if (!emptyNode) {
      emptyNode = document.createElement("div");
      emptyNode.id = "listEmpty";
      emptyNode.className = "list-empty hidden";
      els.list.appendChild(emptyNode);
      emptyNode.addEventListener("click", (e) => {
        const b = e.target.closest && e.target.closest("[data-eact]");
        if (!b) return;
        const act = b.getAttribute("data-eact");
        if (act === "retry") { lastActAt = Date.now(); doRefresh(); return; }
        if (act === "clear") { lastActAt = Date.now(); clearSearch(); return; }
        if (act === "connect") { lastActAt = Date.now(); openConnDialog(); return; }
        if (act === "upload") { lastActAt = Date.now(); doUpload(); return; }
        if (act === "mkdir") { lastActAt = Date.now(); doMkdir(); return; }
      });
    }
    if (!skelNode) {
      skelNode = document.createElement("div");
      skelNode.id = "listSkel";
      skelNode.className = "list-skel hidden";
      for (let i = 0; i < 6; i++) {
        const bar = document.createElement("div");
        bar.className = "bar";
        skelNode.appendChild(bar);
      }
      els.list.appendChild(skelNode);
    }
  }

  function clearSearch() {
    state.search = "";
    els.searchInput.value = "";
    resetPaging();
    loadPage("");
  }

  function renderEmptyState() {
    ensureListExtras();
    if (state.items.length > 0 || !state.connected) { emptyNode.classList.add("hidden"); return; }
    emptyNode.classList.remove("hidden");
    let icon = "cloudUp";
    let title = "";
    let desc = "";
    let actions = "";
    if (state.loadError) {
      icon = "alert";
      title = esc(I18N.t("empty.loadFailTitle"));
      desc = esc(state.loadError);
      actions = `<div class="empty-actions"><button type="button" class="empty-ghost" data-eact="retry">${svg("rotateCcw", 14)}<span>${I18N.t("empty.retry")}</span></button></div>`;
    } else if (state.search) {
      icon = "file";
      title = esc(I18N.t("empty.noMatchTitle"));
      desc = esc(I18N.t("empty.noMatchDesc", { q: state.search }));
      actions = `<div class="empty-actions"><button type="button" class="empty-ghost" data-eact="clear"><span>${I18N.t("empty.clear")}</span></button></div>`;
    } else if (!state.bucket) {
      icon = "bucket";
      title = esc(I18N.t("empty.noBucketTitle"));
      desc = esc(I18N.t("empty.noBucketDesc"));
      actions = `<div class="empty-actions"><button type="button" class="empty-ghost" data-eact="retry">${svg("rotateCcw", 14)}<span>${I18N.t("empty.retry")}</span></button><button type="button" class="empty-cta" data-eact="connect">${svg("link", 14)}<span>${I18N.t("toolbar.connect")}</span></button></div>`;
    } else {
      title = esc(I18N.t("empty.bucketEmptyTitle"));
      desc = esc(I18N.t("empty.bucketEmptyDesc"));
      actions = `<div class="empty-actions"><button type="button" class="empty-cta" data-eact="upload">${svg("upload", 14)}<span>${I18N.t("empty.uploadCta")}</span></button><button type="button" class="empty-ghost" data-eact="mkdir">${svg("folder", 14)}<span>${I18N.t("empty.mkdirCta")}</span></button></div>`;
    }
    emptyNode.innerHTML =
      `<div class="empty-ico">${svg(icon, 36)}</div>` +
      `<div class="empty-title">${title}</div>` +
      `<div class="empty-desc">${desc}</div>` + actions;
  }

  // 行内展示名：去掉当前前缀与末尾斜杠
  function displayName(it) {
    if (!state.bucket) return it.name.replace(/\/$/, "");
    const n = it.name.startsWith(state.prefix) ? it.name.slice(state.prefix.length) : it.name;
    return n.replace(/\/$/, "");
  }

  function renderBreadcrumb() {
    let html = "";
    let moreParts = null;
    if (!state.bucket) {
      html = `<span class="crumb root">${I18N.t("breadcrumb.allBuckets")}</span>`;
    } else {
      html = `<span class="crumb root" data-bucket="">oss://${esc(state.bucket)}/</span>`;
      const parts = state.prefix ? state.prefix.replace(/\/$/, "").split("/").filter(Boolean) : [];
      let acc = "";
      const crumbs = parts.map((p) => { acc += p + "/"; return { label: p, prefix: acc }; });
      // 层级过深时保留首层与末两层，中间折叠成「…」，点击弹出层列表导航，
      // 避免 overflow:hidden 静默截断后深层路径（与中间层级）不可达。
      const KEEP_HEAD = 1, KEEP_TAIL = 2;
      let shown = crumbs;
      if (crumbs.length > KEEP_HEAD + KEEP_TAIL + 2) {
        moreParts = crumbs.slice(KEEP_HEAD, crumbs.length - KEEP_TAIL);
        shown = crumbs.slice(0, KEEP_HEAD).concat(null, crumbs.slice(crumbs.length - KEEP_TAIL));
      }
      for (const c of shown) {
        if (!c) { html += `<span class="crumb bc-more">…</span>/`; continue; }
        html += `<span class="crumb" data-prefix="${esc(c.prefix)}">${esc(c.label)}</span>/`;
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
    const moreEl = els.breadcrumb.querySelector(".crumb.bc-more");
    if (moreEl && moreParts) moreEl.onclick = () => openCrumbMenu(moreEl, moreParts);
  }

  // 「…」展开层：列出被折叠的中间层级，点击导航到对应前缀
  function openCrumbMenu(anchor, parts) {
    closeCtxMenu();
    const m = document.createElement("div");
    m.id = "ctxMenu";
    m.className = "ctx-menu";
    m.innerHTML = parts.map((c) =>
      `<div class="ctx-item" data-bc="${esc(c.prefix)}" title="${esc(c.prefix)}">${esc(c.label.replace(/\/$/, ""))}</div>`
    ).join("");
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mr = m.getBoundingClientRect();
    const px = Math.min(r.left, window.innerWidth - mr.width - 8);
    const py = Math.min(r.bottom + 4, window.innerHeight - mr.height - 8);
    m.style.left = Math.max(4, px) + "px";
    m.style.top = Math.max(4, py) + "px";
    ctxMenuEl = m;
    m.addEventListener("click", (e) => {
      const item = e.target.closest && e.target.closest("[data-bc]");
      if (!item) return;
      closeCtxMenu();
      navigate(item.getAttribute("data-bc"));
    });
    m.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function navigate(prefix) {
    if (prefix === state.prefix) return;
    state.prefix = prefix;
    state.search = "";
    els.searchInput.value = "";
    resetPaging();
    loadPage("");
  }

  // ---------- 列表排序 ----------
  // 排序作用于「已加载的 items」，不依赖服务端：LoadObjects 只能拿到分页的一页，
  // 服务端排序对分页外的对象无效。因此排序必须在客户端做——
  // 代价是尚未加载的下一页不会被纳入本次排序，但它们加载后会被重排，
  // 语义仍是「当前视图内按此键排序」。
  function sortItems(items) {
    const key = state.sortKey;
    const dir = state.sortDesc ? -1 : 1;
    // 目录优先：先按 isDir 分组，再按排序键
    return items.slice().sort((a, b) => {
      const da = a.isDir ? 0 : 1;
      const db = b.isDir ? 0 : 1;
      if (da !== db) return da - db; // 目录恒在前，不受正倒序影响
      let r = 0;
      if (key === "size") {
        // 目录 size 恒为 0，排在同组文件之后（无论升降序）
        if (a.isDir || b.isDir) return a.isDir === b.isDir ? 0 : (a.isDir ? -1 : 1);
        r = a.size - b.size;
      } else if (key === "modified") {
        // modified 为 RFC3339 字符串，字典序即时序，可直接比较
        r = String(a.modified || "").localeCompare(String(b.modified || ""));
      } else {
        // 名称按展示名（去掉前缀）排序更符合直觉
        r = displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: "base" });
      }
      return r * dir;
    });
  }

  // applySort 排序并重绘。排序发生在分页加载之间，故每次加载后都需调用。
  function applySort() {
    state.items = sortItems(state.items);
  }

  // cycleSort 点击表头：先切正倒序，同一列再切回升序
  function toggleSort(key) {
    if (state.sortKey === key) {
      state.sortDesc = !state.sortDesc;
    } else {
      state.sortKey = key;
      // 按时间/大小首次点击时直接给倒序（更有用），名称则给升序
      state.sortDesc = key !== "name";
    }
    applySort();
    updateSortIndicators();
    renderList();
  }

  function updateSortIndicators() {
    const map = { name: "colName", size: "colSize", modified: "colTime" };
    for (const key of ["name", "size", "modified"]) {
      const el = els[map[key]];
      if (!el) continue;
      const active = state.sortKey === key;
      el.classList.toggle("sorted", active);
      // 用伪元素显示箭头，避免在 HTML 里塞两个 span
      el.dataset.arrow = active ? (state.sortDesc ? "desc" : "asc") : "";
    }
  }

  // 列表虚拟化：只渲染可视区行，避免上万条 DOM 卡死
  function renderList() {
    els.listContent.style.height = (state.items.length * ROW_H) + "px";
    // 路径栏计数只表示当前已加载条数；「还有更多」仅由状态栏在真正存在下一页时提示
    els.countLabel.textContent = I18N.t("status.loaded", { n: state.items.length });
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
    if (!guardWritable()) return;
    const sel = Array.from(state.sel);
    if (!sel.length || !state.bucket) return;
    // 目录与文件分开下发：目录项由后端递归删除其下全部对象，
    // 混在一起会让后端无法区分「删一个文件」与「删整个目录」。
    const dirs = [];
    const paths = [];
    for (const name of sel) {
      const it = state.items.find((x) => x.name === name);
      if (it && it.isDir) dirs.push(name);
      else paths.push(name);
    }
    const ok = await openConfirm(
      I18N.t("modal.confirmTitle"),
      I18N.t("batch.deleteTip", { n: sel.length, d: dirs.length })
    );
    if (!ok) return;
    setStatus(I18N.t("batch.deleting", { n: sel.length }));
    try {
      const res = await invoke(
        "objects/delete_batch",
        { bucket: state.bucket, paths, dirs },
        { timeoutMs: 600000 }
      );
      const failed = (res && res.failed) || [];
      let text = I18N.t("batch.deleted", { n: (res && res.deleted) || 0 });
      const objs = (res && res.objectsDeleted) || 0;
      if (objs) text += " · " + I18N.t("batch.deletedObjects", { n: objs });
      if (failed.length) text += " · " + I18N.t("batch.failed", { n: failed.length });
      setStatus(text, !!failed.length);
    } catch (e) {
      setStatus(I18N.t("delete.fail") + (e.message || e), true);
    }
    resetPaging();
    loadPage("");
  }

  async function doBatchDownload() {
    const items = await batchPick(BATCH_CAP, (it) => !it.isDir && state.sel.has(it.name));
    if (!items) return;
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

  // ---------- 文件类型图标 ----------
  // svg() 与图标表见 icons.js。
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
    let out = "";
    if (!it.isDir && previewKind(it.name)) out += opBtn("preview", "eye", "op.preview");
    return out + opBtn("ctxmenu", "ellipsis", "op.more");
  }

  // 动作表：右键菜单与行内「更多」按钮共用；诸 act 走 actOnRow 现有分派。
  //
  // 只读连接（state.readOnly）下剔除全部写动作（改名/删除/新建），
  // 只保留浏览类（打开/预览/下载/复制地址）。真正的边界在后端
  // requireWritable 守卫，这里只是不把用户引到注定失败的路径上。
  function ctxActions(it) {
    const acts = [];
    const canWrite = !state.readOnly;
    if (it.isDir) {
      acts.push(["open", "folderOpen", "op.open"]);
      acts.push(["detail", "info", "op.detail"]);
      if (state.bucket) { // 根目录下的项是存储桶，不允许删除/重命名
        if (canWrite) {
          acts.push(["rename", "pencil", "op.rename"]);
          acts.push(["-", "", ""]);
          acts.push(["delete", "trash", "op.delete", true]);
        }
      }
    } else {
      if (previewKind(it.name)) acts.push(["preview", "eye", "op.preview"]);
      acts.push(["download", "download", "op.download"]);
      acts.push(["addr", "link", "op.addr"]);
      // 公开动作标题随状态变化：已知公开 → 「取消公开」；否则「公开链接」。
      acts.push(["public", "globe", it.public ? "op.cancelPublic" : "op.public"]);
      acts.push(["name", "copy", "op.name"]);
      acts.push(["detail", "info", "op.detail"]);
      if (canWrite) {
        acts.push(["rename", "pencil", "op.rename"]);
        acts.push(["-", "", ""]);
        acts.push(["delete", "trash", "op.delete", true]);
      }
    }
    return acts;
  }

  let ctxMenuEl = null;
  function closeCtxMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  async function copyName(it) {
    try {
      await writeClipboard(displayName(it));
      setStatus(I18N.t("preview.copied"));
    } catch (e) {
      setStatus(I18N.t("modal.copyFail"));
    }
  }

  function openCtxMenu(x, y, it) {
    closeCtxMenu();
    const m = document.createElement("div");
    m.id = "ctxMenu";
    m.className = "ctx-menu";
    let html = "";
    for (const [act, icon, key, danger] of ctxActions(it)) {
      if (act === "-") { html += '<div class="ctx-sep"></div>'; continue; }
      const t = esc(I18N.t(key));
      html += `<div class="ctx-item${danger ? " danger" : ""}" data-cact="${act}" title="${t}">${ICONS.svg(icon, 14)}<span>${t}</span></div>`;
    }
    m.innerHTML = html;
    document.body.appendChild(m);
    // 弹出后按实际尺寸钳位到视口内，避免屏幕边缘被截断
    const r = m.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    m.style.left = Math.max(4, px) + "px";
    m.style.top = Math.max(4, py) + "px";
    ctxMenuEl = m;
    m.addEventListener("click", (e) => {
      const item = e.target.closest && e.target.closest("[data-cact]");
      if (!item) return;
      const act = item.getAttribute("data-cact");
      closeCtxMenu();
      if (act === "name") { lastActAt = Date.now(); copyName(it); return; }
      const idx = state.items.indexOf(it);
      actOnRow(idx < 0 ? state.selectedIndex : idx, it, act);
    });
    m.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // 右键：列表区域内拦截浏览器默认菜单，弹出动作菜单（宿主 webview 下尤其需要）；
  // 其余空白处也一并拦截（默认的「刷新/另存为/打印」菜单在 webview 插件里只会造成困惑，
  // 刷新/重连等功能工具栏都有），仅输入框/可编辑区放行，保留原生复制粘贴菜单。
  document.addEventListener("contextmenu", (e) => {
    if (inFloatingLayer(e.target)) return;
    const el = e.target;
    const editable = el && el.closest && el.closest("input, textarea, select, [contenteditable]");
    if (editable) return; // 输入区保留浏览器原生的复制/粘贴菜单
    const idx = rowIndexAt(e.clientX, e.clientY);
    e.preventDefault(); // 未命中行（列表空白/工具栏/状态栏）只拦截默认菜单
    if (idx < 0) return;
    const it = state.items[idx];
    if (!it) return;
    lastActAt = Date.now();
    actOnRow(idx, it, "ctxmenu", e);
  }, true);

  // 点击菜单外任意处 / Escape 关闭
  document.addEventListener("pointerdown", (e) => {
    if (ctxMenuEl && !(e.target.closest && e.target.closest("#ctxMenu"))) closeCtxMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCtxMenu();
  });

  // ---------- 键盘快捷键（文件管理器惯例） ----------
  // 输入框 / 弹窗 / 未连接时不响应，避免抢输入与破坏原生编辑行为。
  function shortcutGuard() {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return false;
    if (inFloatingLayer(el)) return false;
    for (const id of ["connectOverlay", "modal", "copyModal", "previewOverlay"]) {
      const n = $(id);
      if (n && !n.classList.contains("hidden")) return false;
    }
    const bv = $("browserView");
    return !!(bv && !bv.classList.contains("hidden"));
  }
  document.addEventListener("keydown", (e) => {
    if (!shortcutGuard()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      toggleSelectAll();
      return;
    }
    // 搜索聚焦：Ctrl+F 或 `/`（文件管理器惯例），聚焦并全选便于覆盖输入
    if ((ctrl && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) || e.key === "/") {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (ctrl || e.altKey || e.metaKey) return;
    const it = state.items[state.selectedIndex];
    switch (e.key) {
      case "Enter":
        if (!it) return;
        e.preventDefault();
        if (it.isDir) enterDir(it);
        else if (previewKind(it.name)) openPreview(it);
        else doDownload(it);
        return;
      case "Backspace":
        e.preventDefault();
        doUp();
        return;
      case "Delete":
        if (!state.bucket) return; // 根目录的项是存储桶，不允许删除
        e.preventDefault();
        if (state.sel.size) doBatchDelete(); // 多选批量删除
        else if (it) doDelete(it);
        return;
      case "F2":
        if (!it || !state.bucket) return;
        e.preventDefault();
        doRename(it);
        return;
    }
  });

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
      // 公共读徽标：仅对已确认为公共读的对象（it.public 为 true）显示。
      // it.public 既来自用户本地的开关操作（即时），也来自「公开状态」扫描
      // （objects/get_acl_batch）。目录无 ACL，不显示。
      const pubBadge = (!it.isDir && it.public) ? `<span class="pub-badge" title="${esc(I18N.t("op.publicBadge"))}">${svg("globe", 12)}<span>${esc(I18N.t("op.publicBadge"))}</span></span>` : "";
      html += `<div class="row${selected}${checked}" data-i="${i}" style="position:absolute;top:${i * ROW_H}px;height:${ROW_H}px;left:0;right:0;">` +
        ckboxHtml(it) +
        `<span class="cell-name"><span class="ico ${ic.cls}">${svg(ic.icon, 16)}</span><span class="nm ${it.isDir ? "is-dir" : ""}">${esc(displayName(it))}</span>${pubBadge}</span>` +
        `<span class="sz">${it.isDir ? I18N.t("row.dir") : formatSize(it.size)}</span>` +
        `<span class="tm">${esc(fmtTime(it.modified))}</span>` +
        `<span class="fast">${rowOps(it)}</span>` +
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
  // 上传失败待重试的 File 列表（复用断点续传；重试前必须置空，防误触发）
  let uploadRetryFiles = null;

  function openDlCard(name, mode) {
    dl.cancelled = false; dl.lastWritten = 0; dl.lastT = 0;
    dl.mode = mode || "download";
    const retryEl = $("dlRetry");
    if (retryEl) retryEl.classList.add("hidden"); // 新一轮开始前先收起重试按钮
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
    const retryEl = $("dlRetry");
    if (retryEl) retryEl.classList.add("hidden");
    uploadRetryFiles = null;
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
      setStatus(I18N.t("download.fail") + (e.message || e), true);
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
      setStatus(I18N.t("download.fail") + (e.message || e), true);
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
// 重试失败项：重新走 runUpload（同一批 File，断点续传只补未完成的分片）
const dlRetryEl = $("dlRetry");
if (dlRetryEl) dlRetryEl.onclick = () => {
  const files = uploadRetryFiles;
  uploadRetryFiles = null;
  dlRetryEl.classList.add("hidden");
  if (files && files.length) runUpload(files);
};
  if (dlCloseEl) dlCloseEl.onclick = () => { if (dlCardEl) dlCardEl.classList.add("hidden"); };

  let presignExpiry = 86400; // 上次选择的有效期（秒），会话内记忆

  // ---------- 文件预览（图片/音视频/PDF 走 presign；文本/代码/MD 走分块读取） ----------
  const IMG_SET = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "avif"];
  const VID_SET = ["mp4", "webm", "m4v", "mov", "mkv"];
  const AUD_SET = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
  const TEXT_SET = ["txt", "md", "csv", "tsv", "log", "rst", "json", "xml", "js", "mjs", "ts", "tsx", "jsx", "go", "py", "java", "c", "h", "cpp", "hpp", "cs", "css", "scss", "yml", "yaml", "sh", "bat", "ps1", "sql", "toml", "ini", "proto", "dockerfile", "gitignore"];
  // file-viewer 安全子集覆盖的格式（本地 IIFE 渲染；授权见 ui/THIRD-PARTY-NOTICES.md）。
  // 与 bundle 内 5 个渲染器的扩展名一一对应；刻意不含 .ppt（ legacy 二进制 PPT 走专有
  // 水印引擎 renderer-ppt，已在授权审查中排除），csv/tsv 保留纯文本预览（在 TEXT_SET 中先行命中）。
  const OFFICE_SET = ["doc", "docx", "docm", "dot", "dotx", "dotm", "rtf", "odt", "odp", "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "xla", "xlam", "ods", "fods", "dbf", "pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "ofd"];
  // Online3DViewer 安全子集覆盖的 3D 格式（本地 IIFE 渲染；授权见 ui/THIRD-PARTY-NOTICES.md）。
  // 全链 MIT/Apache-2.0、零 wasm、零外部请求；3dm/ifc/step/iges/brep/fcstd（MPL/LGPL
  // 解码器，见补丁说明）与 draco 压缩 glTF 刻意不支持，扩展名不匹配会优雅报"不支持"。
  // 注意：gltf/obj/dae 若引用外部 .bin/mtl/贴图，单文件预览会缺资源——.glb/.stl/.ply 最稳。
  const MODEL3D_SET = ["obj", "stl", "ply", "off", "3ds", "glb", "gltf", "bim", "fbx", "dae", "wrl", "3mf", "amf"];
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
    // HTML 单独走 iframe 渲染预览（浏览器式展示，看源码用「编辑」），不进 text 分支
    if (ext === "html" || ext === "htm") return "html";
    if (TEXT_SET.indexOf(ext) >= 0) return "text";
    if (OFFICE_SET.indexOf(ext) >= 0) return "office";
    if (MODEL3D_SET.indexOf(ext) >= 0) return "model3d";
    return null;
  }

  // Markdown / 代码高亮用的两个库：随包本地资产优先（零外联、离线可用），
  // 本地资产缺失时才回退 cdnjs（旧包或资产被剪枝的场景）。失败一律降级纯文本，不阻塞预览。
  const MD_ASSETS = {
    marked: ["vendor/marked.min.js", "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"],
    hljs: ["vendor/highlight.min.js", "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"],
    hljsCss: ["vendor/highlight-github.min.css", "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css"],
  };

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
  // 按候选顺序依次尝试，全部失败才 reject（本地 → CDN）
  function loadScriptAny(sources) {
    const list = Array.isArray(sources) ? sources.slice() : [sources];
    return list.reduce((p, src) => p.catch(() => loadScript(src)), Promise.reject(new Error("no source")));
  }
  function loadStyle(href) {
    if (document.querySelector('link[href="' + href + '"]')) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = resolve;
      l.onerror = () => reject(new Error("load fail: " + href));
      document.head.appendChild(l);
    });
  }
  function loadStyleAny(sources) {
    const list = Array.isArray(sources) ? sources.slice() : [sources];
    return list.reduce((p, href) => p.catch(() => loadStyle(href)), Promise.reject(new Error("no source")));
  }

  // 分块读取整对象为 Blob（沙箱 CSP 只放行 blob:，媒体预览统一走此路径）
  //
  // 内存策略：逐块读入并追加进单个 ArrayBuffer，最后一次 slice 成 Blob 视图。
  // 不用 `parts.push(Blob)` + `new Blob(parts)`——后者会让所有分块同时驻留，
  // 再整体拷一份，峰值约为文件大小的 2 倍。媒体上限 64MB，这个差值不可忽略。
  async function readObjectBlob(path, cap, onProgress) {
    const first = await invoke("objects/read", { bucket: state.bucket, path, offset: 0, limit: PREVIEW_CHUNK });
    const total = Number(first.size) || 0;
    if (cap && total > cap) throw new Error(I18N.t("preview.tooLarge"));
    // 总长已知，一次性分配；写满后正好是完整内容
    const buf = new Uint8Array(total);
    buf.set(b64ToBuffer(first.content), 0);
    let got = PREVIEW_CHUNK;
    if (onProgress) onProgress(Math.min(got, total), total);
    while (got < total) {
      const n = Math.min(PREVIEW_CHUNK, total - got);
      const r = await invoke("objects/read", { bucket: state.bucket, path, offset: got, limit: n });
      buf.set(b64ToBuffer(r.content), got);
      got += n;
      if (onProgress) onProgress(got, total);
    }
    return { blob: new Blob([buf], { type: guessMimeFromPath(path) }), size: total };
  }

  // 按扩展名推断 MIME，决定 Blob 的 type——type 错误会导致图片/音视频无法解码。
  function guessMimeFromPath(path) {
    const m = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = m ? m[1] : "";
    const map = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
      avif: "image/avif",
      mp4: "video/mp4", webm: "video/webm", m4v: "video/x-m4v", mov: "video/quicktime", mkv: "video/x-matroska",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
      flac: "audio/flac", aac: "audio/aac",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ofd: "application/ofd",
      glb: "model/gltf-binary",
      gltf: "model/gltf+json",
      rtf: "application/rtf",
      odt: "application/vnd.oasis.opendocument.text",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      odp: "application/vnd.oasis.opendocument.presentation",
    };
    return map[ext] || "application/octet-stream";
  }

  // 分块读取文本（UTF-8），超出 cap 截断。
  // 同样用预分配 ArrayBuffer 而非 parts 数组：截断时按 limit 分配，只读需要的长度。
  async function readObjectText(path, cap) {
    const first = await invoke("objects/read", { bucket: state.bucket, path, offset: 0, limit: PREVIEW_CHUNK });
    const total = Number(first.size) || 0;
    const limit = Math.min(total, cap);
    const buf = new Uint8Array(limit);
    buf.set(b64ToBuffer(first.content).subarray(0, limit), 0);
    let got = PREVIEW_CHUNK;
    while (got < limit) {
      const n = Math.min(PREVIEW_CHUNK, limit - got);
      const r = await invoke("objects/read", { bucket: state.bucket, path, offset: got, limit: n });
      buf.set(b64ToBuffer(r.content).subarray(0, n), got);
      got += n;
    }
    return { text: new TextDecoder("utf-8").decode(buf), truncated: total > limit, size: total };
  }

  function setPvMeta(text) { els.pvMeta.textContent = text || ""; }

  // 预览复制：仅文本类预览（text/code/markdown）可用，复制的是原始文本
  let pvCopyText = "";

  // pvCurrentItem 当前预览的对象项。在线编辑需要知道「正在编辑哪个对象」，
  // 以及判断它是否可编辑（文本类 / 非只读 / 未超大小上限）。
  let pvCurrentItem = null;

  function setPvCopyAvailable(on) {
    if (els.pvCopy) els.pvCopy.classList.toggle("hidden", !on);
    if (!on) pvCopyText = "";
  }

  // ---------- 图片缩放/旋转/平移（pvToolbar；仅图片预览启用） ----------
  // 当前预览对象用上方 pvCurrentItem，此处只维护缩放状态
  let pvZoom = { s: 1, r: 0, x: 0, y: 0 };

  function pvZoomClamp(s) { return Math.min(8, Math.max(0.1, s)); }

  function applyPvZoom() {
    const img = els.pvBody && els.pvBody.querySelector("img.pv-img");
    if (!img) return;
    img.style.transform = "translate(" + pvZoom.x + "px, " + pvZoom.y + "px) scale(" + pvZoom.s + ") rotate(" + pvZoom.r + "deg)";
    const lbl = $("pvZoomLabel");
    if (lbl) lbl.textContent = Math.round(pvZoom.s * 100) + "%";
  }

  function resetPvZoom() {
    pvZoom = { s: 1, r: 0, x: 0, y: 0 };
    applyPvZoom();
  }

  function setPvToolbar(on) {
    const tb = $("pvToolbar");
    if (tb) tb.classList.toggle("hidden", !on);
    if (on) resetPvZoom(); // 每次新图片恢复初始比例
  }

  // 滚轮缩放 + 拖拽平移（仅在图片预览时生效，不影响文本/代码的文本选择）
  function bindPreviewZoom() {
    const body = els.pvBody;
    if (!body) return;
    body.addEventListener("wheel", (e) => {
      if (!body.querySelector("img.pv-img")) return;
      e.preventDefault();
      pvZoom.s = pvZoomClamp(pvZoom.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
      applyPvZoom();
    }, { passive: false });
    body.addEventListener("pointerdown", (e) => {
      const img = body.querySelector("img.pv-img");
      if (!img || e.button !== 0) return;
      const sx = e.clientX - pvZoom.x, sy = e.clientY - pvZoom.y;
      img.classList.add("dragging");
      const move = (ev) => {
        pvZoom.x = ev.clientX - sx;
        pvZoom.y = ev.clientY - sy;
        applyPvZoom();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        img.classList.remove("dragging");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      e.preventDefault();
    });
  }

  function bindPreviewButtons() {
    els.pvClose.onclick = closePreview;
    // 全屏切换：Office/表格类内容小窗口里挤成一团，全屏后可读性大幅提升
    const fullBtn = $("pvFull");
    if (fullBtn) {
      fullBtn.onclick = () => {
        const box = els.previewOverlay.querySelector(".preview-box");
        if (box) box.classList.toggle("fs");
        // 全屏只改弹窗 CSS（.preview-box.fs → 100vw/100vh），不触发 window resize，
        // O3DV 引擎的自适应监听收不到通知；双 rAF 等 flex 布局生效后手动同步画布
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (pvO3dv && pvO3dv.viewer) pvO3dv.viewer.Resize();
          });
        });
      };
    }
    // 图片缩放工具条（仅图片预览显示；按钮常驻绑定，显隐由 setPvToolbar 控制）
    const zIn = $("pvZoomIn"), zOut = $("pvZoomOut"), zRot = $("pvRotate"), zFit = $("pvFit");
    if (zIn) zIn.onclick = () => { pvZoom.s = pvZoomClamp(pvZoom.s * 1.25); applyPvZoom(); };
    if (zOut) zOut.onclick = () => { pvZoom.s = pvZoomClamp(pvZoom.s / 1.25); applyPvZoom(); };
    if (zRot) zRot.onclick = () => { pvZoom.r = (pvZoom.r + 90) % 360; applyPvZoom(); };
    if (zFit) zFit.onclick = resetPvZoom;
    // 3D 工具条（仅 3D 预览显示；按钮常驻绑定，显隐由 setPv3dToolbar 控制）
    const d3Fit = $("pv3dFit"), d3Edges = $("pv3dEdges"), d3Proj = $("pv3dProj"),
      d3Bg = $("pv3dBg"), d3Nav = $("pv3dNav"), d3Shot = $("pv3dShot");
    if (d3Fit) d3Fit.onclick = pv3dFit;
    if (d3Edges) d3Edges.onclick = () => pv3dSetEdges(!pvO3dv.edgesOn);
    if (d3Proj) d3Proj.onclick = pv3dToggleProjection;
    if (d3Bg) d3Bg.onclick = pv3dToggleBg;
    if (d3Nav) d3Nav.onclick = pv3dToggleNav;
    if (d3Shot) d3Shot.onclick = pv3dSnapshot;
    // 六向标准视图：前(+Z)/后(-Z)/左(-X)/右(+X)/顶(+Y)/底(-Y)，Y 轴向上
    const views = {
      pv3dVf: [0, 0, 1], pv3dVb: [0, 0, -1],
      pv3dVl: [-1, 0, 0], pv3dVr: [1, 0, 0],
      pv3dVt: [0, 1, 0], pv3dVbottom: [0, -1, 0],
    };
    for (const id in views) {
      const btn = $(id);
      if (btn) btn.onclick = () => pv3dView(views[id][0], views[id][1], views[id][2]);
    }
    // 打开原文件：预签名后交给系统浏览器；window.open 被拦截时回退到复制弹窗
    const pvOpenBtn = $("pvOpen");
    if (pvOpenBtn) {
      pvOpenBtn.onclick = async () => {
        if (!pvCurrentItem || !state.bucket) return;
        try {
          const r = await invoke("objects/presign", { bucket: state.bucket, path: pvCurrentItem.name, expires: presignExpiry });
          let w = null;
          try { w = window.open(r.url, "_blank"); } catch (e2) { w = null; }
          if (!w) { showCopy(I18N.t("presign.title"), r.url, false, I18N.t("presign.publicHint")); setStatus(I18N.t("pv.openBlocked")); }
          else setStatus(I18N.t("presign.ok"));
        } catch (e) {
          showCopy(I18N.t("copy.title") + " · " + I18N.t("presign.fallback"), fallbackUrl(pvCurrentItem));
        }
      };
    }
    if (els.pvCopy) {
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
    if (els.pvEdit) els.pvEdit.onclick = enterEditMode;
    if (els.pvSave) els.pvSave.onclick = saveEditedText;
  }

  // ---------- 在线编辑（文本 / 代码 / Markdown） ----------
  //
  // 能力边界：只对「纯文本类」开放。objects/write 走 base64 整体上传，
  // 没有条件写入与 ETag 乐观锁——并发写同一对象会后写覆盖先写。
  // 因此这里明确限定在「用户主动编辑单个文件」的场景，并在 UI 上给出提示，
  // 不做「批量改写」「模板渲染」这类批量写场景。
  //
  // 大小限制：编辑内容受 EDIT_MAX_BYTES 约束。超过上限时保存被拒绝，
  // 避免把一个几百 MB 的文件读进 webview 内存（预览本身已有 2MB 截断保护）。
  const EDIT_MAX_BYTES = 2 * 1024 * 1024; // 2MB，与文本预览上限一致

  // pvEditState 记录当前编辑会话
  const pvEditState = {
    active: false,
    path: "",       // 正在编辑的对象 key
    original: "",   // 打开编辑器时的原始内容（用于判断有无改动）
    dirty: false,
  };

  function setEditButtons(showEdit, showSave) {
    if (els.pvEdit) els.pvEdit.classList.toggle("hidden", !showEdit);
    if (els.pvSave) els.pvSave.classList.toggle("hidden", !showSave);
  }

  // canEditCurrent 判断当前预览对象是否可编辑：
  // 必须是文本类（含 HTML，以源码形式编辑）、不是只读连接、且未超大小上限。
  function canEditCurrent(it) {
    if (!it) return false;
    if (state.readOnly) return false; // 只读连接禁止写
    const kind = previewKind(it.name);
    if (kind !== "text" && kind !== "markdown" && kind !== "html") return false;
    if (it.size > EDIT_MAX_BYTES) return false;
    return true;
  }

  async function enterEditMode() {
    const it = pvCurrentItem;
    if (!it || !canEditCurrent(it)) return;
    // 已在编辑态则不重复进入
    if (pvEditState.active) return;

    let text = "";
    try {
      const r = await readObjectText(it.name, EDIT_MAX_BYTES);
      if (r.truncated) {
        // 截断意味着读回的不是完整内容，保存会毁掉文件——必须拒绝
        setPvMeta(I18N.t("preview.editTooLarge"));
        return;
      }
      text = r.text;
    } catch (e) {
      previewError((e && e.message) ? e.message : String(e));
      return;
    }

    pvEditState.active = true;
    pvEditState.path = it.name;
    pvEditState.original = text;
    pvEditState.dirty = false;

    els.pvBody.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "pv-editor";
    ta.value = text;
    ta.spellcheck = false;
    ta.setAttribute("aria-label", displayName(it));
    ta.addEventListener("input", () => {
      pvEditState.dirty = ta.value !== pvEditState.original;
    });
    els.pvBody.appendChild(ta);
    ta.focus();
    setPvMeta(I18N.t("preview.editing"));
    setEditButtons(false, true);
    setPvCopyAvailable(false);
  }

  async function saveEditedText() {
    if (!pvEditState.active) return;
    const ta = els.pvBody.querySelector("textarea.pv-editor");
    if (!ta) return;
    const content = ta.value;
    // 编码后大小才是实际写入量（base64 前的原始字节数）
    const bytes = new Blob([content]).size;
    if (bytes > EDIT_MAX_BYTES) {
      setPvMeta(I18N.t("preview.editTooLarge"));
      return;
    }
    if (!guardWritable()) return;

    setPvMeta(I18N.t("preview.saving"));
    setEditButtons(false, false);
    try {
      await invoke("objects/write", {
        bucket: state.bucket,
        path: pvEditState.path,
        content: utf8ToBase64(content),
        mime: guessMimeFromPath(pvEditState.path),
      }, { timeoutMs: 120000 });
      pvEditState.original = content;
      pvEditState.dirty = false;
      setPvMeta(I18N.t("preview.saved"));
      // 保存后回到只读展示，避免「保存完还停在编辑态」的歧义
      exitEditMode();
    } catch (e) {
      setPvMeta(I18N.t("preview.saveFail") + ((e && e.message) ? e.message : e));
      setEditButtons(false, true); // 失败后允许重试
    }
  }

  // exitEditMode 退出编辑态，恢复只读展示。
  function exitEditMode() {
    pvEditState.active = false;
    pvEditState.path = "";
    pvEditState.original = "";
    pvEditState.dirty = false;
    setEditButtons(false, false);
  }

  // utf8ToBase64 文本 → base64（UTF-8 编码）。
  // 不能用 btoa(text) 直接转：btoa 只接受 Latin-1 字符，
  // 中文/emoji 会抛 InvalidCharacterError。必须先经 TextEncoder 转字节。
  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // ---------- Blob URL 生命周期 ----------
  // 媒体预览走 blob: URL（CSP 只放行 blob:）。createObjectURL 会让 Blob 一直驻留
  // 内存，直到 revokeObjectURL 或文档销毁——媒体上限 64MB，反复预览几个大文件
  // 就能把 webview 内存撑爆。innerHTML="" 只移除元素，不会释放 Blob，必须显式 revoke。
  let pvObjectUrl = "";

  function releasePvObjectUrl() {
    if (!pvObjectUrl) return;
    try { URL.revokeObjectURL(pvObjectUrl); } catch (e) { /* ignore */ }
    pvObjectUrl = "";
  }

  function previewError(msg) {
    setPvCopyAvailable(false);
    setPvToolbar(false);
    setPv3dToolbar(false);
    // 预览失败意味着 Viewer 已无用处（挂载失败会残留 Worker），立即销毁
    destroyPvViewer();
    // 预览失败意味着 Blob URL 已无用处（元素也不会成功挂载），立即释放
    releasePvObjectUrl();
    // 失败后不应残留编辑/保存按钮
    exitEditMode();
    els.pvBody.innerHTML = `<div class="pv-fail">${esc(msg)}</div>`;
  }

  function closePreview() {
    els.previewOverlay.classList.add("hidden");
    els.pvBody.innerHTML = ""; // 停掉 video/audio
    destroyPvViewer();
    releasePvObjectUrl();
    exitEditMode();
    setPvToolbar(false);
    setPv3dToolbar(false);
    pvCurrentItem = null;
  }

  // ---------- Office/OFD 预览（file-viewer 安全子集） ----------
  // 本地 IIFE（ui/fileviewer/viewer.iife.js）+ 本地资产（ui/fileviewer/assets/），
  // 渲染全程无外部网络请求（Worker/WASM/字体均从包内相对路径加载）。
  // 仅在首次预览 Office 文件时懒加载，避免拖慢插件启动。
  // 授权边界：仅含 Apache-2.0/MIT 组件，已排除 AGPL CAD 与专有水印 ppt，
  // 详见 ui/THIRD-PARTY-NOTICES.md。
  let pvViewer = null;        // 当前 file-viewer 控制器；关闭/切换/失败时必须 destroy（释放 Worker）
  let fileViewerLoading = null;

  function destroyPvViewer() {
    if (!pvViewer) return;
    try { pvViewer.destroy(); } catch (e) { /* ignore */ }
    pvViewer = null;
  }

  async function ensureFileViewer() {
    if (window.FileViewerSDK) return window.FileViewerSDK;
    if (!fileViewerLoading) {
      fileViewerLoading = loadScript("fileviewer/viewer.iife.js").then(() => {
        const sdk = window.FileViewerSDK;
        if (!sdk || typeof sdk.mountViewer !== "function") {
          throw new Error(I18N.t("preview.loadFail"));
        }
        // 资产基址取绝对 URL：Worker/WASM/CMap/字体一律走包内目录，不依赖 CDN
        sdk.setDefaultFileViewerAssetBaseUrl(new URL("fileviewer/assets/", document.baseURI).href);
        return sdk;
      }).catch((e) => { fileViewerLoading = null; throw e; });
    }
    return fileViewerLoading;
  }

  // 沙箱 Worker 启动：插件 UI 运行在宿主的沙箱 iframe 中（origin 为 null），
  // 浏览器禁止从 null origin 直接 new Worker("http://dbx-plugin.localhost/...")。
  // 解法是把 worker 脚本转成 blob URL（blob 继承当前文档 origin，可合法建 Worker）：
  //   1) 优先走宿主桥 readAssetUrl(path)——宿主在沙箱文档内创建的 blob URL，官方许可用法；
  //   2) 回退 fetch 本地资源 → text → blob URL；
  //   3) 都失败返回 null，调用方省略该字段走引擎默认行为（正常 origin 环境仍可用）。
  // 成功结果按路径缓存复用（共 4 个文件约 2.4MB，会话内常驻内存，避免每次预览重建）。
  const pvWorkerBlobUrls = new Map();
  function resolvePvWorkerUrl(relPath) {
    let p = pvWorkerBlobUrls.get(relPath);
    if (p) return p;
    p = (async () => {
      try {
        if (window.dbxPlugin && typeof window.dbxPlugin.readAssetUrl === "function") {
          const u = await window.dbxPlugin.readAssetUrl(relPath);
          // 仅接受 blob: URL（自定义 scheme 无法用于 new Worker）
          if (u && /^blob:/i.test(u)) return u;
        }
      } catch (e) { /* 继续尝试 fetch */ }
      try {
        const abs = new URL(relPath, document.baseURI).href;
        const res = await fetch(abs);
        if (res.ok) {
          const src = await res.text();
          return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        }
      } catch (e) { /* null origin 下 fetch 可能被 CORS 拦截，放弃 */ }
      return null;
    })();
    pvWorkerBlobUrls.set(relPath, p);
    return p;
  }

  // ---------- 3D 模型预览（Online3DViewer 安全子集） ----------
  // 本地 IIFE（ui/o3dv/o3dv.iife.js）：仅含 MIT/Apache-2.0 导入器（引擎源码已打补丁，
  // 摘除 rhino3dm/web-ifc/occt 依赖并断掉全部 CDN 路径），零 wasm、零外部请求。
  // 单实例复用：EmbeddedViewer 构造时注册的 window resize 监听器是匿名的、无法移除，
  // 重复创建实例会累积泄漏——因此整个会话只建一次，切换文件走 LoadModelFromFileList
  // （内部先 Clear 旧模型），关闭预览仅摘除 DOM、实例保留待复用。
  let pvO3dv = null; // { host, viewer }
  let o3dvLoading = null;

  async function ensureO3dv() {
    if (window.OV) return window.OV;
    if (!o3dvLoading) {
      o3dvLoading = loadScript("o3dv/o3dv.iife.js").then(() => {
        const ov = window.OV;
        if (!ov || typeof ov.EmbeddedViewer !== "function") {
          throw new Error(I18N.t("preview.loadFail"));
        }
        return ov;
      }).catch((e) => { o3dvLoading = null; throw e; });
    }
    return o3dvLoading;
  }

  function ensurePvO3dvHost() {
    if (!pvO3dv) {
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      pvO3dv = { host: null, viewer: null, edgesOn: false, orthoOn: false, bgDark: dark, navFree: false };
    }
    if (!pvO3dv.host) {
      const host = document.createElement("div");
      host.className = "pv-model3d";
      pvO3dv.host = host;
    }
    return pvO3dv.host;
  }

  // ---------- 3D 工具条（适应视图/边线/投影/背景/导航/六向视图/截图） ----------
  // 引擎层 EmbeddedViewer 只提供画布与鼠标交互，工具栏属上游 website 层未集成；
  // 这里基于引擎公开 API 自建轻量工具条。每次加载模型后需重放用户设置
  //（Viewer.Clear 只移除 three 对象，边线等渲染态不跟随新模型）。
  function pv3dEngine() {
    return pvO3dv && pvO3dv.viewer ? pvO3dv.viewer.GetViewer() : null;
  }

  function pv3dSyncButtons() {
    if (!pvO3dv) return;
    const edgesBtn = $("pv3dEdges");
    if (edgesBtn) edgesBtn.classList.toggle("active", !!pvO3dv.edgesOn);
    const projBtn = $("pv3dProj");
    if (projBtn) projBtn.textContent = I18N.t(pvO3dv.orthoOn ? "pv3d.projOrtho" : "pv3d.projPersp");
    const bgBtn = $("pv3dBg");
    if (bgBtn) bgBtn.textContent = I18N.t(pvO3dv.bgDark ? "pv3d.bgDark" : "pv3d.bgLight");
    const navBtn = $("pv3dNav");
    if (navBtn) navBtn.textContent = I18N.t(pvO3dv.navFree ? "pv3d.navFree" : "pv3d.navTurntable");
  }

  function setPv3dToolbar(on) {
    const tb = $("pv3dToolbar");
    if (tb) tb.classList.toggle("hidden", !on);
    if (on) pv3dSyncButtons();
  }

  function pv3dFit() {
    const v = pv3dEngine();
    if (!v) return;
    const sphere = v.GetBoundingSphere(() => true);
    v.AdjustClippingPlanesToSphere(sphere);
    v.FitSphereToWindow(sphere, false);
  }

  function pv3dSetEdges(on) {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    // 边线颜色随背景：深色背景用浅灰，浅色背景用黑
    const c = pvO3dv && pvO3dv.bgDark ? 160 : 0;
    v.SetEdgeSettings(new ov.EdgeSettings(on, new ov.RGBColor(c, c, c), 1));
    if (pvO3dv) pvO3dv.edgesOn = on;
    const btn = $("pv3dEdges");
    if (btn) btn.classList.toggle("active", on);
  }

  function pv3dToggleProjection() {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    const next = v.GetProjectionMode() === ov.ProjectionMode.Orthographic
      ? ov.ProjectionMode.Perspective
      : ov.ProjectionMode.Orthographic;
    // SetProjectionMode 内部完成相机重建/裁剪面/重渲染，视角保持不变
    v.SetProjectionMode(next);
    if (pvO3dv) pvO3dv.orthoOn = next === ov.ProjectionMode.Orthographic;
    const btn = $("pv3dProj");
    if (btn) btn.textContent = I18N.t(pvO3dv.orthoOn ? "pv3d.projOrtho" : "pv3d.projPersp");
  }

  function pv3dApplyBg() {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    const dark = pvO3dv && pvO3dv.bgDark;
    v.SetBackgroundColor(new ov.RGBAColor(dark ? 32 : 255, dark ? 32 : 255, dark ? 32 : 255, 255));
  }

  function pv3dToggleBg() {
    if (!pvO3dv) return;
    pvO3dv.bgDark = !pvO3dv.bgDark;
    pv3dApplyBg();
    // 边线颜色与背景强相关，开着就同步换色
    if (pvO3dv.edgesOn) pv3dSetEdges(true);
    const btn = $("pv3dBg");
    if (btn) btn.textContent = I18N.t(pvO3dv.bgDark ? "pv3d.bgDark" : "pv3d.bgLight");
  }

  function pv3dToggleNav() {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    // FixedUpVector=转台（水平旋转保持 Y 轴向上），FreeOrbit=自由旋转
    const next = pvO3dv.navFree ? ov.NavigationMode.FixedUpVector : ov.NavigationMode.FreeOrbit;
    v.SetNavigationMode(next);
    if (pvO3dv) pvO3dv.navFree = next === ov.NavigationMode.FreeOrbit;
    const btn = $("pv3dNav");
    if (btn) btn.textContent = I18N.t(pvO3dv.navFree ? "pv3d.navFree" : "pv3d.navTurntable");
  }

  // 六向标准视图：eye = 模型中心 + 方向 × 取景距离（复刻 GetFitToSphereCamera 的
  // 半视角/宽高比修正），Y 轴向上；顶/底视图 up 退化，改用 Z 轴。
  function pv3dView(dx, dy, dz) {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    const sphere = v.GetBoundingSphere(() => true);
    if (!sphere) return;
    const cam = v.GetCamera();
    const c = sphere.center;
    const dir = new ov.Coord3D(dx, dy, dz).Normalize();
    const canvas = v.GetCanvas();
    let halfFov = cam.fov / 2;
    if (canvas.clientWidth < canvas.clientHeight) {
      halfFov = halfFov * canvas.clientWidth / canvas.clientHeight;
    }
    const dist = sphere.radius / Math.sin(halfFov * Math.PI / 180);
    const eye = new ov.Coord3D(c.x + dir.x * dist, c.y + dir.y * dist, c.z + dir.z * dist);
    const useZUp = Math.abs(dy) === 1;
    const up = useZUp ? new ov.Coord3D(0, 0, 1) : new ov.Coord3D(0, 1, 0);
    v.SetCamera(new ov.Camera(eye, new ov.Coord3D(c.x, c.y, c.z), up, cam.fov));
    v.AdjustClippingPlanesToSphere(sphere);
  }

  function pv3dSnapshot() {
    const v = pv3dEngine();
    if (!v) return;
    try {
      const size = v.GetCanvasSize();
      const url = v.GetImageAsDataUrl(size.width, size.height, false);
      const base = (pvCurrentItem && pvCurrentItem.name.split("/").pop() || "model").replace(/\.[^.]+$/, "");
      const a = document.createElement("a");
      a.href = url;
      a.download = base + ".png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setPvMeta(I18N.t("pv3d.shotFail"));
    }
  }

  async function openPreview(it) {
    const kind = previewKind(it.name);
    if (!kind) return;
    // 切换目标前先释放上一个预览的 Blob：否则快速连续点多个文件会累积多个 Blob
    releasePvObjectUrl();
    destroyPvViewer();
    exitEditMode(); // 切换对象时退出上一个对象的编辑态
    pvCurrentItem = it;
    setPvToolbar(false); // 切换/加载中先收起缩放工具条（文本预览不适用）
    setPv3dToolbar(false); // 同上，收起 3D 工具条（3D 分支加载成功后再展开）
    els.pvName.textContent = displayName(it);
    els.pvName.title = it.name;
    els.pvMeta.textContent = "";
    setPvCopyAvailable(false); // 加载中先隐藏复制按钮，文本类成功后再显示
    setEditButtons(false, false); // 加载中不显示编辑/保存按钮
    els.pvBody.innerHTML = `<div class="pv-loading">${I18N.t("status.loading")}</div>`;
    els.previewOverlay.classList.remove("hidden");
    const sizeText = it.size ? formatSize(it.size) : "";

    try {
      if (kind === "office") {
        // file-viewer 渲染 docx/xlsx/pptx/ofd。Blob 包装为带扩展名的 File：
        // 渲染器按扩展名匹配，且 Viewer 内部需要文件名做标题/下载名。
        const { blob } = await readObjectBlob(it.name, PREVIEW_BLOB_CAP, (w, t) => {
          setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
        });
        const sdk = await ensureFileViewer();
        const filename = it.name.split("/").pop();
        const host = document.createElement("div");
        host.className = "pv-office";
        els.pvBody.innerHTML = "";
        els.pvBody.appendChild(host);
        // mountViewer 的 type 字段是“扩展名提示”而非 MIME：内部 normalizeSource()
        // 按 source.type || 文件名后缀 计算 extension，传 MIME 会被当成扩展名导致
        // “不支持 application/vnd... 格式”。因此这里传纯扩展名（无后缀时省略，
        // 让引擎回退到 filename 解析）。File 构造器的 type 仍是标准 MIME 语义。
        const extMatch = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
        const fileExt = extMatch ? extMatch[1] : "";
        // 沙箱内 Worker 必须用 blob URL 启动（origin 为 null，见 resolvePvWorkerUrl）。
        // docx 渲染器约定：不传 workerUrl 时走主线程解析；xlsx 有主线程回退；pptx 必须 Worker。
        const [docxWorkerUrl, docxJsZipUrl, sheetWorkerUrl, pptxWorkerUrl] = await Promise.all([
          resolvePvWorkerUrl("fileviewer/assets/vendor/docx/docx.worker.js"),
          resolvePvWorkerUrl("fileviewer/assets/vendor/docx/jszip.min.js"),
          resolvePvWorkerUrl("fileviewer/assets/vendor/xlsx/sheet.worker.js"),
          resolvePvWorkerUrl("fileviewer/assets/vendor/pptx/pptx.worker.js"),
        ]);
        // mountViewer 传 initialOptions 即自动加载；rendererMode:'replace' 表示
        // 只装配白名单渲染器，不使用核心默认集（格式边界与授权边界一致）。
        pvViewer = sdk.mountViewer(host, {
          file: new File([blob], filename, { type: guessMimeFromPath(it.name) }),
          filename: filename,
          ...(fileExt ? { type: fileExt } : {}),
          options: {
            renderers: sdk.officeRenderers,
            rendererMode: "replace",
            ...(docxWorkerUrl ? {
              docx: {
                workerUrl: docxWorkerUrl,
                // docx Worker 内部 importScripts(jszip) 需要同源可用的绝对地址，
                // blob URL 与 Worker 同 origin（null），importScripts 可加载
                ...(docxJsZipUrl ? { workerJsZipUrl: docxJsZipUrl } : {}),
              },
            } : {}),
            ...(sheetWorkerUrl ? { spreadsheet: { workerUrl: sheetWorkerUrl } } : {}),
            ...(pptxWorkerUrl ? {
              presentation: {
                workerUrl: pptxWorkerUrl,
                // pptx.worker.js 是 classic 脚本（esbuild IIFE，无 import/export）；
                // 引擎默认 type:"module"，而 module Worker 从 blob URL 加载时走模块脚本
                // 的 CORS 语义，在沙箱（opaque/null origin）下必失败（error 事件 →
                // "PPTX Worker 运行失败 / worker-runtime"）。显式声明 classic 后
                // blob Worker 可正常启动（已用真实 worker 在沙箱 iframe 实测验证）。
                workerType: "classic",
              },
            } : {}),
          },
        }, {
          // 引擎异步加载失败（含 Worker 失败）会回调 onError 并在面板内渲染原始诊断
          // 文案；这里统一接管为插件的友好失败提示。pptx 无主线程回退，Worker 不可用
          // 即视为该环境不支持 PPT 预览（对应产品决策：不能预览就明示不支持）。
          onError: (err) => {
            const code = err && err.code;
            const workerDown = code === "PPTX_WORKER_FAILED"
              || /worker/i.test(String((err && err.message) || err || ""));
            previewError(workerDown ? I18N.t("preview.pptWorkerFail") : I18N.t("preview.officeParseFail"));
          },
        });
        setPvMeta(formatSize(blob.size));
        return;
      }

      if (kind === "model3d") {
        // Online3DViewer 渲染 3D 模型：Blob 包装为带扩展名的 File（导入器按扩展名分发）。
        // 单实例复用——host 反复摘挂后必须手动 Resize 修正画布尺寸。
        const { blob } = await readObjectBlob(it.name, PREVIEW_BLOB_CAP, (w, t) => {
          setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
        });
        const ov = await ensureO3dv();
        const filename = it.name.split("/").pop();
        const host = ensurePvO3dvHost();
        els.pvBody.innerHTML = "";
        els.pvBody.appendChild(host);
        if (!pvO3dv.viewer) {
          // 背景跟随宿主明暗主题（bgDark 已在 ensurePvO3dvHost 解析；three 默认
          // 不透明画布，需显式设色）
          const dark = !!pvO3dv.bgDark;
          pvO3dv.viewer = new ov.EmbeddedViewer(host, {
            backgroundColor: new ov.RGBAColor(dark ? 32 : 255, dark ? 32 : 255, dark ? 32 : 255, 255),
          });
        } else {
          pvO3dv.viewer.Resize();
        }
        pvO3dv.viewer.LoadModelFromFileList([new File([blob], filename, { type: guessMimeFromPath(it.name) })]);
        // 重放用户设置：LoadModelFromInputFiles 内部 Clear 后重建渲染态，
        // 边线/投影不自动继承，需按当前开关状态补一次
        const engine = pv3dEngine();
        if (engine) {
          if (pvO3dv.orthoOn) engine.SetProjectionMode(ov.ProjectionMode.Orthographic);
          else engine.SetProjectionMode(ov.ProjectionMode.Perspective);
          if (pvO3dv.edgesOn) pv3dSetEdges(true);
        }
        setPv3dToolbar(true);
        setPvMeta(formatSize(blob.size));
        return;
      }

      if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
        // 沙箱 CSP 只放行 blob: → 统一分块读取拼 Blob 后挂媒体元素
        const cap = (kind === "video" || kind === "audio") ? PREVIEW_MEDIA_CAP : PREVIEW_BLOB_CAP;
        try {
          const { blob } = await readObjectBlob(it.name, cap, (w, t) => {
            setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
          });
          const url = URL.createObjectURL(blob);
          pvObjectUrl = url; // 登记以便关闭/切换时 revoke
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
          if (kind === "image") setPvToolbar(true);
          return;
        } catch (e) {
          previewError((e && e.message) ? e.message : String(e));
          return;
        }
      }

      if (kind === "markdown" || kind === "text" || kind === "html") {
        const r = await readObjectText(it.name, PREVIEW_TEXT_CAP);
        setPvMeta(sizeText + (r.truncated ? " · " + I18N.t("preview.truncated") : ""));
        pvCopyText = r.text;
        setPvCopyAvailable(true);
        // 文本类且可编辑时显示「编辑」按钮（只读连接 / 超大文件 / 非文本类均不可编辑）
        setEditButtons(canEditCurrent(it), false);
        if (kind === "html") {
          // HTML 直接 iframe 渲染（srcdoc 注入全文，浏览器式展示）。sandbox 只给
          // allow-scripts：页面脚本可跑，但处于不透明源，碰不到插件页面与 dbxPlugin 桥
          //（HTML 是桶里任意对象，不加 sandbox 会同源泄漏连接凭据）。看源码走「编辑」按钮。
          const frame = document.createElement("iframe");
          frame.className = "pv-html";
          frame.setAttribute("sandbox", "allow-scripts");
          frame.srcdoc = r.text;
          els.pvBody.innerHTML = "";
          els.pvBody.appendChild(frame);
          return;
        }
        if (kind === "markdown") {
          try {
            await loadScriptAny(MD_ASSETS.marked);
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
    loadStyleAny(MD_ASSETS.hljsCss).catch(() => {});
    loadScriptAny(MD_ASSETS.hljs)
      .then(() => {
        if (window.hljs) {
          code.className = "language-" + detectLang(name);
          try { window.hljs.highlightElement(code); } catch (e) { /* 降级纯文本 */ }
        }
      })
      .catch(() => {});
  }

  bindPreviewButtons();
  bindPreviewZoom();
  els.previewOverlay.addEventListener("mousedown", (e) => {
    if (e.target === els.previewOverlay) closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.previewOverlay.classList.contains("hidden")) closePreview();
    // 排序表头是 span（带 role=button/tabindex），补 Enter/Space 键盘操作
    if (e.key === "Enter" || e.key === " ") {
      const t = e.target;
      if (t && t.closest && t.closest("[data-sort]")) {
        e.preventDefault();
        toggleSort(t.closest("[data-sort]").getAttribute("data-sort"));
      }
    }
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

  // ---------- 公共读状态扫描（列表徽标） ----------
  // 仅当用户开启「公开状态」开关时运行：合并为单次 RPC（objects/get_acl_batch），
  // 后端按顺序读取每个对象的 ACL。已查过的对象记入 state.aclKnown，不重复查。
  // 扫描是异步且尽力而为的——失败只影响徽标、绝不阻塞浏览。
  let aclScanBusy = false;
  async function refreshAcl() {
    if (!state.showPublicAcl || !state.bucket) return;
    const gen = listGen;
    const todo = state.items.filter((it) => !it.isDir && !state.aclKnown.has(it.name));
    if (!todo.length) return;
    if (aclScanBusy) return; // 防并发
    aclScanBusy = true;
    setStatus(I18N.t("public.scanning"));
    try {
      const paths = todo.map((it) => it.name);
      const r = await invoke("objects/get_acl_batch", { bucket: state.bucket, paths });
      if (gen !== listGen) return; // 目录已切换，丢弃过期结果
      const map = {};
      (r && r.items || []).forEach((x) => { map[x.path] = !!x.public; });
      todo.forEach((it) => {
        it.public = map[it.name] || false;
        state.aclKnown.add(it.name);
      });
      renderVisible();
      setStatus(I18N.t("status.loaded", { n: state.items.length }));
    } catch (e) {
      setStatus(I18N.t("public.scanFail") + ((e && e.message) ? e.message : ""), true);
    } finally {
      aclScanBusy = false;
    }
  }

  // 公共读：与预签名是两条不同的分享路径。预签名 URL 必然带过期时间（S3 协议上限
  // 7 天），公共读则是把对象 ACL 设为 public-read，用不带签名的普通 URL 访问——
  // 没有过期时间，代价是任何持链接者都能永久访问。因此每次设置都要二次确认，
  // 且只读连接直接拒绝（后端 requireWritable 也会兜底拦一次）。
  //
  // 关键修复（针对「公开后不能取消」）：取消/设置的走向不再单纯信任每次点击的
  // get_acl 往返结果，而是优先使用本地已知状态 it.public——用户刚设置过公开的
  // 对象，本地状态即为 true，再次点击必然进入「恢复私有」分支，即便 get_acl 因
  // 服务端一致性/字段差异偶发返回 false 也不会卡死。未知状态才回退到 get_acl 查询。
  //
  // S3 兼容驱动无法在线改对象 ACL（minio-go 未提供 PutObjectAcl）：该分支只读取
  // 状态、展示公共链接，并明确告知需到服务商控制台设置，避免给出「设置失败」的
  // 误导性报错。
  async function doPublic(it) {
    if (!state.bucket) { setStatus(I18N.t("addr.missingEndpoint")); return; }
    // 确定当前公开状态：本地已知优先，未知才回退查询。
    let pub = it.public;
    if (pub == null) {
      try {
        const r = await invoke("objects/get_acl", { bucket: state.bucket, path: it.name });
        pub = !!(r && r.public);
      } catch (e) {
        setStatus(I18N.t("public.readFail") + ((e && e.message) ? e.message : ""), true);
        return;
      }
      it.public = pub;
      state.aclKnown.add(it.name);
    }

    // S3 兼容驱动：不支持在线修改，只展示只读说明 / 公共链接。
    if (state.provider === "s3") {
      if (pub) {
        showCopy(I18N.t("public.title"), fallbackUrl(it), false, I18N.t("public.hint"));
      } else {
        setStatus(I18N.t("public.s3ReadOnly"), true);
      }
      return;
    }

    if (state.readOnly) { setStatus(I18N.t("public.readOnly"), true); return; }

    if (pub) {
      const revoke = await openConfirm(I18N.t("public.alreadyTitle"), I18N.t("public.alreadyMsg"));
      if (!revoke) {
        showCopy(I18N.t("public.title"), fallbackUrl(it), false, I18N.t("public.hint"));
        renderVisible();
        return;
      }
      try {
        await invoke("objects/set_acl", { bucket: state.bucket, path: it.name, public: false });
        it.public = false; // 立即更新本地状态与徽标，无需等待扫描
        setStatus(I18N.t("public.revoked"));
      } catch (e) {
        setStatus(I18N.t("public.setFail") + ((e && e.message) ? e.message : ""), true);
      }
    } else {
      const ok = await openConfirm(I18N.t("public.confirmTitle"), I18N.t("public.confirmMsg"), it.name);
      if (!ok) return;
      try {
        await invoke("objects/set_acl", { bucket: state.bucket, path: it.name, public: true });
        it.public = true; // 立即更新本地状态与徽标
        setStatus(I18N.t("public.ok"));
        showCopy(I18N.t("public.title"), fallbackUrl(it), false, I18N.t("public.hint"));
      } catch (e) {
        setStatus(I18N.t("public.setFail") + ((e && e.message) ? e.message : ""), true);
      }
    }
    renderVisible(); // 刷新行内徽标，立即反映最新公开状态
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
      showCopy(I18N.t("presign.title") + " · " + exp, r.url, false, I18N.t("presign.publicHint"));
    } catch (e) {
      // 预签名失败（如 RAM 无 SignURL 权限）：回退拼接地址（仅公共读场景可用）
      setStatus(I18N.t("presign.fail") + (e.message || e), true);
      showCopy(I18N.t("copy.title") + " · " + I18N.t("presign.fallback"), fallbackUrl(it));
    }
  }

  // 批量复制地址：一次填有效期，为选中的文件并发预签名，多行文本一次复制。
  // 单条签名失败只记数不中断（如个别 key 无权限），结果在弹窗 hint 里如实标注。
  async function doBatchAddr() {
    if (!state.bucket) { setStatus(I18N.t("addr.missingEndpoint")); return; }
    const items = await batchPick(BATCH_CAP, (x) => !x.isDir && state.sel.has(x.name));
    if (!items) return;
    const input = await openPrompt(
      I18N.t("presign.title"),
      I18N.t("presign.placeholder"),
      String(presignExpiry),
      I18N.t("modal.ok")
    );
    if (input == null || input === "") return;
    const expires = Math.min(604800, Math.max(60, parseInt(input, 10) || 86400));
    presignExpiry = expires;
    setStatus(I18N.t("batch.addrWorking", { n: items.length }));
    const exp = expires >= 3600 && expires % 3600 === 0 ? (expires / 3600) + "h" : expires + "s";
    // 分批并发签名（10/批）：避免一次性打满几百上千个并发 RPC 把 webview 或 sidecar 压垮；
    // 单条失败只记数不中断（如个别 key 无权限），结果在弹窗 hint 里如实标注。
    const urls = [];
    let failed = 0;
    const CONC = 10;
    for (let i = 0; i < items.length; i += CONC) {
      const slice = items.slice(i, i + CONC);
      const rs = await Promise.all(slice.map((x) =>
        invoke("objects/presign", { bucket: state.bucket, path: x.name, expires })
          .then((r) => (r && r.url) || "")
          .catch(() => "")
      ));
      for (const u of rs) { if (u) urls.push(u); else failed++; }
    }
    if (!urls.length) {
      setStatus(I18N.t("presign.fail") + I18N.t("batch.addrAllFail"), true);
      return;
    }
    setStatus(I18N.t("presign.ok") + " (" + exp + ")");
    showCopy(I18N.t("batch.addrTitle", { n: urls.length }) + " · " + exp, urls.join("\n"), true, I18N.t("presign.publicHint"));
    if (failed > 0) {
      const hintEl = $("copyHint");
      if (hintEl) hintEl.textContent = I18N.t("batch.addrPartial", { fail: failed, total: items.length });
    }
  }

  // dirObjectCount 预取目录下对象数，用于确认弹窗如实告知「将连带删除 N 个对象」。
  // 统计失败不阻断删除（退化为只显示目录名），但截断（超过后端扫描上限）必须如实标注。
  async function dirObjectCount(it) {
    try {
      const res = await invoke("objects/dir_info", { bucket: state.bucket, path: it.name }, { timeoutMs: 30000 });
      return { count: (res && res.count) || 0, truncated: !!(res && res.truncated) };
    } catch (e) {
      return null;
    }
  }

  // doRename 重命名（后端 objects/move = copy + delete，对象存储无原生 rename）。
  // 两个易错点：
  //   1. 目录在列表里的 name 带尾部 "/"（如 "a/b/"），重命名只需替换最后一段，
  //      尾部斜杠必须保留，否则会变成文件 "b" 而丢掉目录语义。
  //   2. 目标已存在时必须拦下——copy 会直接覆盖原对象，造成静默数据丢失。
  async function doRename(it) {
    if (!guardWritable()) return;
    if (!state.bucket) return;
    const isDir = it.isDir;
    // 目录项 name 形如 "prefix/sub/"，拆出父前缀与末段（末段不含尾斜杠）
    const raw = isDir ? it.name.replace(/\/$/, "") : it.name;
    const slash = raw.lastIndexOf("/");
    const parent = slash >= 0 ? raw.slice(0, slash + 1) : "";
    const oldBase = raw.slice(slash + 1);

    const input = await openPrompt(
      I18N.t("rename.title"),
      I18N.t("rename.placeholder"),
      oldBase,
      I18N.t("rename.ok")
    );
    if (input === null) return;
    const newBase = input.trim();
    if (!newBase) { setStatus(I18N.t("rename.empty")); return; }
    if (newBase === oldBase) return;
    if (newBase.indexOf("/") >= 0 || newBase.indexOf("\\") >= 0) {
      setStatus(I18N.t("rename.badChar"));
      return;
    }
    // 目录名以 / 结尾时保留目录语义；这里显式拒绝用户自己带斜杠，避免 a/b/ 这类歧义
    const target = parent + newBase + (isDir ? "/" : "");

    // 同名冲突检测：直接比对当前已加载的列表项即可（当前目录内的重命名不会跨页）
    const clash = state.items.some((x) => x.name === target && x.name !== it.name);
    if (clash) { setStatus(I18N.t("rename.exists", { name: newBase })); return; }

    setStatus(I18N.t("rename.working", { name: newBase }));
    try {
      if (isDir) {
        // 目录必须走 move_dir：对象存储没有实体目录，move 是单 key copy+delete，
        // 对前缀只会命中（通常不存在的）目录标记对象——要么报 NoSuchKey，
        // 要么搬了个空壳而子对象原地不动。move_dir 会递归搬迁 prefix 下全部对象。
        const res = await invoke("objects/move_dir", {
          bucket: state.bucket, from: it.name, to: target,
        }, { timeoutMs: 600000 });
        const n = (res && res.moved) || 0;
        setStatus(I18N.t("rename.doneDir", { from: displayName(it), to: newBase, count: n }));
      } else {
        await invoke("objects/move", { bucket: state.bucket, from: it.name, to: target }, { timeoutMs: 600000 });
        setStatus(I18N.t("rename.done", { from: displayName(it), to: newBase }));
      }
    } catch (e) {
      setStatus(I18N.t("rename.fail") + (e.message || e), true);
    }
    resetPaging();
    loadPage("");
  }

  async function doDelete(it) {
    if (!guardWritable()) return;
    const name = displayName(it);
    if (it.isDir) {
      // 目录删除是真删：递归清空其下所有对象，因此必须先告知影响面再动手。
      const info = await dirObjectCount(it);
      const tip = info
        ? I18N.t(info.truncated ? "delete.dirTipTruncated" : "delete.dirTip", { name, n: info.count })
        : I18N.t("delete.dirTipUnknown", { name });
      const ok = await openConfirm(I18N.t("modal.confirmTitle"), tip, name);
      if (!ok) return;
      if (info && info.truncated) {
        setStatus(I18N.t("delete.dirTooLarge", { name }), true);
        return;
      }
      setStatus(I18N.t("delete.deletingDir", { name }));
      try {
        const res = await invoke(
          "objects/delete_dir",
          { bucket: state.bucket, path: it.name },
          { timeoutMs: 600000 }
        );
        const n = (res && res.deleted) || 0;
        setStatus(I18N.t("delete.dirDeleted", { name, n }));
      } catch (e) {
        setStatus(I18N.t("delete.fail") + (e.message || e), true);
      }
      resetPaging();
      loadPage("");
      return;
    }
    const ok = await openConfirm(I18N.t("modal.confirmTitle"), I18N.t("delete.fileTip"), name);
    if (!ok) return;
    try {
      await invoke("objects/delete", { bucket: state.bucket, path: it.name });
      setStatus(I18N.t("delete.status") + name);
    } catch (e) {
      setStatus(I18N.t("delete.fail") + (e.message || e), true);
    }
    resetPaging();
    loadPage("");
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
    return !!(el && el.closest && el.closest("#connectOverlay, #modal, #copyModal, #dlCard, #previewOverlay, #ctxMenu"));
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

  function actOnRow(idx, it, act, e) {
    // 选中高亮：仅切换 class，不整列重绘（避免销毁行元素）
    state.selectedIndex = idx;
    els.listContent.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
    const rowEl = els.listContent.querySelector('.row[data-i="' + idx + '"]');
    if (rowEl) rowEl.classList.add("selected");

    if (act === "ctxmenu") { openCtxMenu(e.clientX, e.clientY, it); return; }
    if (act === "preview") { openPreview(it); return; }
    if (act === "download") { doDownload(it); return; }
    if (act === "addr") { doCopyUrl(it); return; }
    if (act === "public") { doPublic(it); return; }
    if (act === "detail") { openDetail(it); return; }
    if (act === "rename") { doRename(it); return; }
    if (act === "delete") { doDelete(it); return; }
    if (act === "open") { enterDir(it); return; }
    if (it.isDir) enterDir(it);
  }

  function onDocEvent(type, e) {
    // 仅左键参与行/按钮分派（右键菜单由独立的 contextmenu 处理器控制，
    // 右键的 mouseup 会先于此把抬升事件误当成行点击，导致右键目录直接进入）
    if (e.button !== 0) return;
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

    // 2a0b) 排序表头：早于行分派，避免被当成行点击
    const sortEl = e.target.closest && e.target.closest("[data-sort]");
    if (sortEl) { lastActAt = Date.now(); toggleSort(sortEl.getAttribute("data-sort")); return; }

    // 2a) 功能按钮：文档级委托分派（不依赖 els.* 属性绑定）
    const btn = e.target.closest && e.target.closest("button");
    if (btn && btn.id) {
      const id = btn.id;
      if (id === "refreshBtn") { lastActAt = Date.now(); doRefresh(); return; }
      if (id === "mkdirBtn") { lastActAt = Date.now(); doMkdir(); return; }
      if (id === "uploadBtn") { lastActAt = Date.now(); doUpload(); return; }
      if (id === "uploadDirBtn") { lastActAt = Date.now(); doUploadDir(); return; }
      if (id === "upBtn") { lastActAt = Date.now(); doUp(); return; }
      if (id === "connBtn") { lastActAt = Date.now(); openConnDialog(); return; }
      if (id === "batchDeleteBtn") { lastActAt = Date.now(); doBatchDelete(); return; }
      if (id === "batchDownloadBtn") { lastActAt = Date.now(); doBatchDownload(); return; }
      if (id === "batchAddrBtn") { lastActAt = Date.now(); doBatchAddr(); return; }
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
    actOnRow(idx, it, act, e);
  }

  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
    document.addEventListener(t, (e) => onDocEvent(t, e), true);
  });

  // ---------- 列宽拖拽（大小 / 时间列；名称列 1fr 自动伸缩） ----------
  // 宽度记录在 --col-*-w 变量上（表头与行共用同一网格模板），拖完经插件存储记忆。
  let colW = { size: 150, time: 180 };

  function applyColWidths() {
    const bv = els.browserView;
    if (!bv) return;
    bv.style.setProperty("--col-size-w", colW.size + "px");
    bv.style.setProperty("--col-time-w", colW.time + "px");
    layoutColResizers();
  }

  // 拖拽手柄按表头网格的实时边界定位（名称列是 1fr，不能用固定位置）
  function layoutColResizers() {
    const head = $("tableHead");
    if (!head || !head.offsetWidth) return; // 视图隐藏时宽度为 0，等显示后再定位
    const kids = head.children;
    if (kids.length < 4) return;
    const gap = 8;
    const r1 = $("colRz1"), r2 = $("colRz2");
    if (r1) r1.style.left = (kids[2].offsetLeft - gap / 2 - 4.5) + "px";
    if (r2) r2.style.left = (kids[3].offsetLeft - gap / 2 - 4.5) + "px";
  }

  function clampCol(w) { return Math.round(Math.max(84, Math.min(w, 600))); }

  async function persistColWidths() {
    const store = window.dbxPlugin && window.dbxPlugin.storage;
    if (store && typeof store.set === "function") {
      try { await store.set("colWidths", colW); } catch (e) { /* 存储不可用时仅本次会话生效 */ }
    }
  }

  async function restoreColWidths() {
    const store = window.dbxPlugin && window.dbxPlugin.storage;
    if (!store || typeof store.get !== "function") return;
    try {
      const w = await store.get("colWidths");
      if (w) {
        if (typeof w.size === "number") colW.size = clampCol(w.size);
        if (typeof w.time === "number") colW.time = clampCol(w.time);
        applyColWidths();
      }
    } catch (e) { /* 忽略 */ }
  }

  function attachColResizer(handle, which) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startW = colW[which];
      let moved = false;
      const onMove = (ev) => {
        moved = true;
        const head = $("tableHead");
        // 手柄在受控列的左边界（名称列 1fr 在前会吸收宽度变化，左边界与列宽反向联动）：
        // 向左拖动边界 ⇒ 列变宽，因此宽度 = 起始宽 − 位移（与右边界锚定直觉一致）
        const maxW = head ? head.clientWidth - 24 - 34 - 24 - 84 - 80 : 500;
        colW[which] = clampCol(Math.min(startW - (ev.clientX - startX), maxW));
        applyColWidths();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        handle.classList.remove("dragging");
        if (moved) persistColWidths();
        lastActAt = Date.now(); // 抬起产生的 click 不能落进相邻表头的排序分派
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    });
  }

  (function initColResize() {
    const head = $("tableHead");
    if (!head) return;
    const r1 = document.createElement("span");
    r1.className = "col-resizer";
    r1.id = "colRz1";
    r1.setAttribute("data-resize", "size");
    r1.setAttribute("title", I18N.t("col.dragHint"));
    head.appendChild(r1);
    const r2 = document.createElement("span");
    r2.className = "col-resizer";
    r2.id = "colRz2";
    r2.setAttribute("data-resize", "time");
    r2.setAttribute("title", I18N.t("col.dragHint"));
    head.appendChild(r2);
    attachColResizer(r1, "size");
    attachColResizer(r2, "time");
    window.addEventListener("resize", () => layoutColResizers());
    restoreColWidths();
  })();

  // ---------- 工具栏 ----------
  // 注意：这些动作不再用 els.*.onclick 属性绑定，而是由文档级事件委托按 id 调用
  // （见 onDocEvent 的“功能按钮”分派）。某些宿主会重建/包裹 DOM，属性绑定会失效，
  // 而委托挂在 document 上不受影响——这正是“内联 onclick 有效、JS 绑定无效”的解法。
  async function doMkdir() {
    if (!guardWritable()) return;
    if (!state.connected) { setStatus(I18N.t("common.notConnected"), true); return; }
    if (!state.bucket) { setStatus(I18N.t("mkdir.enterBucket"), true); return; }
    const name = await openPrompt(I18N.t("modal.mkdirTitle"), I18N.t("modal.mkdirPlaceholder"), "", I18N.t("modal.mkdirConfirm"));
    if (!name) return;
    const key = state.prefix + name.replace(/\/+$/, "") + "/";
    try {
      await invoke("objects/write", { bucket: state.bucket, path: key, content: "", mime: "" });
      setStatus(I18N.t("mkdir.done") + key);
      loadPage("");
    } catch (e) {
      setStatus(I18N.t("mkdir.fail") + (e.message || e), true);
    }
  }

  // 上传入口：文件 / 文件夹共用一个隐藏 input，按钮形态区分。
  // webkitdirectory 是非标准属性，宿主 webview 若不支持会退化为普通文件选择，
  // 此时选目录不可用但选文件仍正常——故用特性检测而非无条件声明。
  const SUPPORTS_DIR_PICK = "webkitdirectory" in document.createElement("input");
  const dirInput = document.createElement("input");
  dirInput.type = "file";
  dirInput.hidden = true;
  dirInput.multiple = true;
  if (SUPPORTS_DIR_PICK) {
    dirInput.setAttribute("webkitdirectory", "");
    dirInput.setAttribute("directory", "");
  }
  document.body.appendChild(dirInput);

  function pickFiles(input) {
    if (!state.connected) { setStatus(I18N.t("common.notConnected"), true); return; }
    if (!state.bucket) { setStatus(I18N.t("upload.enterBucket"), true); return; }
    input.click();
  }

  function doUpload() {
    if (!guardWritable()) return;
    pickFiles(els.fileInput);
  }

  function doUploadDir() {
    if (!guardWritable()) return;
    if (!SUPPORTS_DIR_PICK) {
      setStatus(I18N.t("upload.dirUnsupported"));
      return;
    }
    pickFiles(dirInput);
  }

  // 两个 input 共用同一套处理逻辑：直接传文件列表，不做 DataTransfer 转发
  // （部分 webview 无法构造 DataTransfer，转发会静默失败导致目录上传整体失效）。
  dirInput.onchange = () => {
    const files = Array.from(dirInput.files || []);
    if (files.length) runUpload(files);
  };

  // ---------- 拖拽上传（dropzone） ----------
  // 拖入文件/文件夹到列表区：dragover 高亮投放区，drop 后上传。
  // 投放区 pointer-events:none，drop 事件仍落在列表上，不会吞掉数据。
  // 目录拖入时 dataTransfer.files 丢失相对路径，改用 webkitGetAsEntry 递归
  // 还原层级；File 原型的 webkitRelativePath 是只读的，用 Object.create 继承
  // 并覆写（继承原型保证 slice/arrayBuffer 等方法可用）。
  function wrapFileWithRel(f, rel) {
    if (!rel) return f;
    const w = Object.create(f);
    try { Object.defineProperty(w, "webkitRelativePath", { value: rel }); } catch (e) { return f; }
    return w;
  }

  function collectDropFiles(dt) {
    const plain = Array.from(dt.files || []);
    const items = Array.from(dt.items || []);
    const roots = items
      .map((it) => (typeof it.webkitGetAsEntry === "function") ? it.webkitGetAsEntry() : null)
      .filter(Boolean);
    if (!roots.length) return Promise.resolve(plain);
    const out = [];
    return new Promise((resolve) => {
      let pending = 0, dispatched = false;
      const maybeDone = () => { if (dispatched && pending === 0) resolve(out.length ? out : plain); };
      // readEntries 每次只返回一批，必须循环读到空才说明目录遍历完了
      const walk = (entry, base) => {
        pending++;
        if (entry.isFile) {
          entry.file((f) => { out.push(wrapFileWithRel(f, base + entry.name)); pending--; maybeDone(); },
            () => { pending--; maybeDone(); });
        } else if (entry.isDirectory) {
          const dirBase = base + entry.name + "/";
          const reader = entry.createReader();
          const readBatch = () => reader.readEntries((ents) => {
            if (!ents.length) { pending--; maybeDone(); return; }
            ents.forEach((en) => walk(en, dirBase));
            readBatch();
          }, () => { pending--; maybeDone(); });
          readBatch();
        } else { pending--; maybeDone(); }
      };
      roots.forEach((en) => walk(en, ""));
      dispatched = true;
      maybeDone();
    });
  }

  function isFileDrag(e) {
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0);
  }

  function setDropVisible(on) {
    const d = $("dropZone");
    if (d) d.classList.toggle("hidden", !on);
  }

  if (els.list) {
    els.list.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropVisible(true);
    });
    els.list.addEventListener("dragleave", (e) => {
      // 仅当指针真正离开列表才收起（子元素间移动会高频触发 dragleave，否则闪烁）
      if (e.relatedTarget && els.list.contains(e.relatedTarget)) return;
      setDropVisible(false);
    });
    els.list.addEventListener("drop", async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDropVisible(false);
      const files = await collectDropFiles(e.dataTransfer);
      if (files.length) runUpload(files);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setDropVisible(false); // 拖拽途中可随时取消
  });
  // 大文件分片上传：256KB/片 base64 直发 sidecar 顺序落临时文件，
  // complete 时由驱动流式上转（阿里云分片并发 / MinIO 自动 multipart）。
  // 单条 RPC 负载小不超时、内存恒定、可随时取消。
  //
  // 两个能力：
  //  - 断点续传：upload/begin 会带回上次已写入的 offset（sidecar 崩溃/被杀后
  //    临时分片仍在，下次传同一文件自动从断点继续，而非从头上传）。
  //  - 多文件 / 文件夹：遍历 files 逐个上传；勾选目录时按 webkitRelativePath
  //    保留层级。串行执行，避免多路并发抢同一块带宽反而更慢且难中断。
  const UP_CHUNK = 256 * 1024;

  // uploadOneFile 上传单个文件，返回 {ok, key, error}
  async function uploadOneFile(f, key) {
    let uploadId = null;
    try {
      const beg = await invoke("upload/begin", {
        bucket: state.bucket, path: key, size: f.size, mime: f.type || "",
      });
      uploadId = beg.uploadId;
      // 后端返回已写入字节数：从断点继续
      let offset = (typeof beg.offset === "number" && beg.offset > 0) ? beg.offset : 0;
      if (beg.resumed && offset > 0) {
        dlProgress(offset, f.size);
      }

      while (offset < f.size) {
        if (dl.cancelled) {
          // 取消时不 abort：保留分片供下次续传（abort 会连分片一起删掉）
          throw new Error(I18N.t("upload.cancelled"));
        }
        const buf = await f.slice(offset, offset + UP_CHUNK).arrayBuffer();
        const r = await invoke("upload/chunk", { uploadId, offset, content: base64FromArrayBuffer(buf) });
        offset = (r && typeof r.written === "number") ? r.written : offset + buf.byteLength;
        dlProgress(offset, f.size);
      }
      await invoke("upload/complete", { uploadId }, { timeoutMs: 600000 });
      uploadId = null; // 已完成，后续失败不应再 abort（分片已被后端清理）
      return { ok: true, key };
    } catch (e) {
      if (uploadId) { try { await invoke("upload/abort", { uploadId }); } catch (e2) { /* 幂等 */ } }
      return { ok: false, key, error: (e && e.message) ? e.message : String(e) };
    }
  }

  // uploadTargetKey 计算对象 key。
  // 目录上传（webkitRelativePath 含 "/"）按相对路径保留层级，否则用纯文件名。
  function uploadTargetKey(f) {
    const rel = f.webkitRelativePath || "";
    if (rel && rel.indexOf("/") >= 0) {
      return state.prefix + rel; // 形如 "a/b/c.txt"，已含目录层级
    }    return state.prefix + f.name;
  }

  // runUpload 逐个上传给定文件列表（串行），完成后汇总结果。
  // 「上传文件」与「上传文件夹」共用此函数，差异仅在传入的 File 是否带 webkitRelativePath。
  async function runUpload(files) {
    if (!guardWritable()) return;
    if (!files.length || !state.connected) return;
    if (!state.bucket) { setStatus(I18N.t("upload.enterBucket"), true); return; }

    const done = [];
    const failed = [];
    let cancelled = false;

    for (let i = 0; i < files.length; i++) {
      if (dl.cancelled) { cancelled = true; break; }
      const f = files[i];
      const key = uploadTargetKey(f);
      // 单文件时显示文件名；多文件时显示进度序号
      openDlCard(files.length > 1 ? I18N.t("upload.progress", { n: i + 1, m: files.length }) : f.name, "upload");
      const res = await uploadOneFile(f, key);
      if (res.ok) done.push(res.key);
      else failed.push({ f, key: res.key, error: res.error });
    }

    if (cancelled) {
      uploadRetryFiles = null;
      $("dlCard").classList.add("hidden");
      setStatus(I18N.t("upload.cancelledPartial", { done: done.length, total: files.length }));
    } else if (failed.length) {
      const first = failed[0];
      failDlCard(first.error);
      // 失败的 File 留给「重试失败项」：upload/begin 会带回断点 offset，只续传未完成的分片
      uploadRetryFiles = failed.map((x) => x.f).filter(Boolean);
      const retryEl = $("dlRetry");
      if (retryEl && uploadRetryFiles.length) {
        $("dlMsg").textContent += " · " + I18N.t("dl.retryHint", { n: uploadRetryFiles.length });
        retryEl.classList.remove("hidden");
      }
      setStatus(I18N.t("upload.summary", { ok: done.length, fail: failed.length })
        + " · " + I18N.t("upload.fail") + first.key + ": " + first.error, true);
    } else {
      const last = done[done.length - 1];
      const text = done.length > 1 ? I18N.t("upload.doneMulti", { n: done.length }) : I18N.t("upload.done") + last;
      finishDlCard(text);
      setStatus(text);
    }
    resetPaging();
    loadPage("");
  }

  els.fileInput.onchange = async () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = ""; // 允许重复选择同一批文件
    await runUpload(files);
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
    if (e.key === "Enter") {
      state.search = els.searchInput.value.trim();
      resetPaging();
      loadPage("");
      return;
    }
    // Esc：有过滤时一键清除并把焦点还给列表（回到上一级用 Backspace 即可）
    if (e.key === "Escape" && els.searchInput.value) {
      clearSearch();
      els.searchInput.blur();
    }
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
      // 回填记住的 Secret：仅当上次确实勾选过且存有值时才填。
      // 没有勾选或没存值时留空，由用户重输（宿主托管场景走下方 context 分支）。
      const savedSk = meta.rememberSk ? (meta.accessKeySecret || "") : "";
      state.rememberSk = !!savedSk;
      els.fSk.value = savedSk;
      if (els.fRegion) els.fRegion.value = meta.region || "";
      if (els.fPathStyle) els.fPathStyle.checked = !!meta.pathStyle;
      if (meta.color) { selectedColor = meta.color; buildSwatches(); }
      if (meta.pageSize) state.pageSize = meta.pageSize;
      if (els.fPageSize) els.fPageSize.value = state.pageSize;
      updateProviderUI();
    }
    renderRememberCk();
    renderReadOnlyCk();

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
      // 只读标记：宿主 connection-provider 声明的 read_only 字段。
      // 既可能在 external_config 里（binding:"config"），也可能在 connection 顶层。
      const readOnly = ec.read_only === true || ec.read_only === "true"
        || c.read_only === true || c.read_only === "true";
      if (endpoint || ak || sk) {
        ctxConn = { endpoint, accessKeyId: ak, accessKeySecret: sk, bucket, name: c.name || "", readOnly };
        if (ctxConn.name) els.fName.value = ctxConn.name;
        els.fProvider.value = provider === "s3" ? "s3" : "aliyun";
        els.fEndpoint.value = endpoint;
        els.fBucket.value = bucket;
        els.fAk.value = ak;
        els.fSk.value = sk;
        if (els.fRegion) els.fRegion.value = region;
        if (els.fPathStyle) els.fPathStyle.checked = pathStyle;
        if (els.fReadOnly) els.fReadOnly.checked = readOnly;
        updateProviderUI();
      }
    }

    if (meta && !ctxConn) {
      // 已记住 Secret 时不必再提示重输，避免造成"没保存"的误解
      msg(state.rememberSk && els.fSk.value
        ? I18N.t("conn.loadedSk")
        : I18N.t("conn.loaded"));
    }

    // 宿主已自动连接（凭据在 Sidecar 内存）：直接进入浏览器视图
    try {
      const st = await invoke("connection/status", {});
      if (st && st.connected) {
        state.connected = true;
        state.provider = st.provider === "s3" ? "s3" : "aliyun";
        state.endpoint = st.endpoint || "";
        state.bucket = st.bucket || "";
        state.prefix = "";
        // 只读状态由后端裁定（宿主 connection.read_only 已在后端解析并落地），
        // 前端据此隐藏写入口。
        state.readOnly = !!st.readOnly;
        updateEndpointLabel();
        state.pageSize = Math.min(1000, Math.max(10, state.pageSize || 200));
        enterBrowser();
        return;
      }
    } catch (e) { /* 后端未就绪则回退到连接表单 */ }

    // 宿主托管连接但还未自动连：用 context 下发的凭据自动连接，免去手填 AK/Secret
    if (ctxConn && ctxConn.accessKeyId && ctxConn.accessKeySecret) {
      // 宿主 context 里若带 readOnly，同步到表单勾选框，连接后状态才一致
      if (ctxConn.readOnly && els.fReadOnly) {
        els.fReadOnly.checked = true;
      }
      await doConnect();
      return;
    }
  }

  boot();
})();
