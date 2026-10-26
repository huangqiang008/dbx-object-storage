// core.js — 共享核心层。
//
// 这是整个 UI 唯一的全局命名空间（window.OB）。其余模块（conn / browse /
// batch / search / meta / transfer / preview / app）都把自己的能力挂到 OB 上，
// 跨模块调用统一走 OB.xxx。
//
// 为什么是「全局命名空间」而不是 ES Module：
// 宿主把插件 UI 放在 sandbox="allow-scripts"（无 allow-same-origin）的 iframe 里，
// 文档 origin 为 null。此时 <script type="module"> 的模块图加载走 CORS 语义，
// null origin 无法通过 → 静默失败（无消息、无 error 事件）。
// 经典 <script src> 只受 CSP script-src 约束，可用。
// 所以 UI 必须保持经典 script + 全局命名空间（与 utils.js / icons.js / i18n.js 同风格）。
//
// 分层约定：
//   core       共享状态 + 基础能力（其他模块都依赖它）
//   conn       连接管理
//   browse     浏览 / 排序 / 多选 / 快捷键
//   batch      批量操作
//   search     深度搜索 + 过滤
//   meta       详情面板 + 元数据编辑
//   transfer   下载 / 上传
//   preview    文件预览
//   app        启动 + 全局事件委托（唯一知道「全部模块」的地方）

(function (global) {
  "use strict";

  // 唯一全局命名空间。已存在说明脚本被重复加载（index.html 顺序错了）。
  if (global.OB) {
    console.error("[object-browser] core.js 重复加载：index.html 的 script 顺序有误");
    return;
  }

  const OB = {};

  // 构建版本号：必须与 manifest.json 的 version 及 backend 的 pluginVersion 一致。
  // 常驻显示在状态栏，用于确认宿主实际加载的是哪个版本（排查"改了却没生效"）。
  // 发版时三处（manifest.json / backend/oss.go / 此处）需一并修改。
  OB.BUILD = "1.2.0";

  OB.COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444", "#3b82f6", "#a855f7"];
  OB.selectedColor = OB.COLORS[4];

  // 全局 UI 状态。所有模块共享同一份对象（引用语义，改一处处处可见）。
  OB.state = {
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
    // selAnchor: 上次勾选的行下标，Shift 连选的区间起点（1.3）。
    // -1 = 无锚点（此时 Shift 点击退化为单点切换）。
    selAnchor: -1,
    // uploadStorageClass 上传时的存储类别（2.5）："" | standard | ia | archive。
    // 空串 = 服务端默认。两侧枚举名不同，这里存归一化值，由后端翻译。
    uploadStorageClass: "",
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

  // DOM 引用表。集中在此，避免各模块各自 getElementById。
  //
  // $ 是 DOM 查询的本地 helper（core 内部大量使用），同时挂到 OB.$ 上
  // 供其它模块取用——但各模块更推荐自己写 document.getElementById，
  // 避免为了一个 helper 引入跨模块依赖。
  const $ = (id) => document.getElementById(id);
  OB.$ = $;

  OB.els = {
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
    storageClassSel: $("storageClassSel"),
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
    fStsToken: $("fStsToken"),
    fRememberCk: $("fRememberCk"),
    fReadOnly: $("fReadOnlyCk"),
    connMsg: $("connMsg"),
    testBtn: $("testBtn"),
    saveBtn: $("saveBtn"),
    savedConnSel: $("savedConnSel"),
    connSaveBtn: $("connSaveBtn"),
    connDelBtn: $("connDelBtn"),
  };

  // 工具函数（来自 utils.js / icons.js）与 i18n 的引用。
  const { esc, formatSize, fmtTime, base64FromArrayBuffer, b64ToBuffer } = global.Utils;
  OB.esc = esc;
  OB.formatSize = formatSize;
  OB.fmtTime = fmtTime;
  OB.base64FromArrayBuffer = base64FromArrayBuffer;
  OB.b64ToBuffer = b64ToBuffer;
  OB.svg = global.ICONS.svg;

  // ---------- 跨模块共享状态 ----------
  //
  // 这些变量在原单文件 main.js 里是同一个闭包内的模块级变量，被多个功能分区共用。
  // 拆成独立模块后必须显式共享，否则各模块会各持一份、互不同步。
  //
  // 约定：初始值由**归属模块**在自身加载时赋值（`OB.shared.X = <初始化器>`），
  // 此处只声明容器；归属见各变量所在模块的文件头。
  OB.shared = {};

  // OB.shared.allItems：state.items 的「未过滤全量快照」。
  // 过滤（search.js）语义上是视图层，但实现会直接改写 state.items——没有快照的话，
  // 第二次过滤会在上一次的过滤结果上重筛（条件放宽列表也不会变宽），重置也无法恢复全量。
  // 维护规则：只有「数据加载」才更新快照（一律走 OB.setItems）；
  // 排序（applySort）与过滤写回子集走普通赋值，禁止触发快照更新，
  // 过滤模块写回子集后自行恢复 OB.shared.allItems（见 search.js filterCommit）。
  OB.shared.allItems = [];

  // setItems 数据加载的唯一入口：替换列表视图并同步全量快照。
  OB.setItems = function setItems(arr) {
    OB.state.items = Array.isArray(arr) ? arr : [];
    OB.shared.allItems = (Array.isArray(arr) ? arr : []).slice();
  };

  // 状态栏：常规状态 + 常驻版本号（便于确认宿主实际加载的版本）。
  // 错误消息红色常驻（需下一条消息覆盖），普通消息 6s 后自动淡出为版本号，
  // 避免“提示已删除、日志早已滚走”或“一个旧提示挂了一整天”。
  let statusFadeTimer = 0;
  OB.setStatus = function (t, isErr) {
    const el = OB.els.statusText || OB.els.status;
    el.textContent = (t ? t + "  " : "") + "· v" + OB.BUILD;
    el.classList.toggle("err", !!isErr);
    if (statusFadeTimer) { clearTimeout(statusFadeTimer); statusFadeTimer = 0; }
    if (t && !isErr) {
      statusFadeTimer = setTimeout(() => {
        statusFadeTimer = 0;
        el.textContent = "· v" + OB.BUILD;
        el.classList.remove("err");
      }, 6000);
    }
  };

  OB.msg = function (t, isErr) {
    OB.els.connMsg.textContent = t || "";
    OB.els.connMsg.classList.toggle("err", !!isErr);
  };

  // OB.invoke 调用宿主 sidecar 的 JSON-RPC。
  OB.invoke = function (method, params, opts) {
    return global.dbxPlugin.invoke(method, params, Object.assign({ timeoutMs: 30000 }, opts || {}));
  };

  // 批量操作上限：仅约束「批量复制地址」（一次性生成上万行大文本会拖垮 webview）。
  // 批量下载 / 批量删除已改为分块循环 + 进度卡 + 可取消，不再截断选择集。
  OB.BATCH_CAP = 1000;

  // OB.batchPick 取选中文件（非目录，保持列表顺序）；超过上限时弹确认框，
  // 用户确认则截断到前 CAP 项，取消则放弃本次操作。
  OB.batchPick = async function (cap, scope) {
    const items = OB.state.items.filter(scope);
    if (!items.length) return null;
    if (items.length > cap) {
      const ok = await OB.openConfirm(
        I18N.t("batch.capTitle"),
        I18N.t("batch.overCap", { n: items.length, cap })
      );
      if (!ok) return null;
      return items.slice(0, cap);
    }
    return items;
  };

  // updateEndpointLabel 渲染端点标签。
  // 只读标记也在这里拼（而不是分散到别处）：标签内容由「端点 + 只读态」共同决定，
  // 任何一处单独更新都可能把另一个信息覆盖掉。
  OB.updateEndpointLabel = function () {
    const els = OB.els;
    const state = OB.state;
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
  };

  // ---------- 通用内嵌模态框（替代原生 prompt/confirm，宿主 webview 可能禁用原生对话框） ----------

  const modal = $("modal");
  const modalTitle = modal.querySelector(".modal-title");
  const modalInput = $("modalInput");
  const modalMsg = modal.querySelector(".modal-msg");
  const modalDetail = modal.querySelector(".modal-detail");
  const modalOk = $("modalOk");
  const modalCancel = $("modalCancel");
  let modalResolve = null;

  // closeModal 关闭通用模态框并回传结果。
  function closeModal(val) {
    modal.classList.add("hidden");
    if (modalResolve) { const r = modalResolve; modalResolve = null; r(val); }
  }

  // openPrompt 文本输入弹窗。返回 Promise<string|null>。
  OB.openPrompt = function (title, placeholder, value, confirmText) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      modalTitle.textContent = title;
      modalInput.style.display = "";
      modalInput.value = value || "";
      modalInput.placeholder = placeholder || "";
      modalMsg.textContent = "";
      OB.setModalDetail("");
      modalOk.textContent = confirmText || I18N.t("modal.ok");
      modal.classList.remove("hidden");
      setTimeout(() => modalInput.focus(), 30);
    });
  };

  // openConfirm 确认弹窗。返回 Promise<boolean>。
  OB.openConfirm = function (title, message, detail) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      modalTitle.textContent = title;
      modalInput.style.display = "none";
      modalMsg.textContent = message || "";
      OB.setModalDetail(detail);
      modalOk.textContent = I18N.t("modal.ok");
      modal.classList.remove("hidden");
      setTimeout(() => modalOk.focus(), 30);
    });
  };

  // detail：长标识（对象 key / 路径）单独一行展示。塞进正文会把句子劈成两段，
  // 且无空格长串的断行位置不可控——所以正文保持完整成句，标识放到这里。
  OB.setModalDetail = function (text) {
    if (!modalDetail) return;
    modalDetail.textContent = text || "";
    modalDetail.classList.toggle("hidden", !text);
  };

  modalOk.onclick = () => closeModal(modalInput.style.display === "none" ? true : modalInput.value);
  modalCancel.onclick = () => closeModal(null);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closeModal(null);
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal(null);
    else if (e.key === "Enter" && modalInput.style.display !== "none") closeModal(modalInput.value);
  });

  // ---------- 复制弹窗（展示下载路径 / 对象地址，一键复制） ----------

  const copyModal = $("copyModal");
  const copyTitle = $("copyTitle");
  const copyInput = $("copyInput");
  const copyArea = $("copyArea");
  const copyHint = $("copyHint");
  let copyText = "";

  // showCopy 展示可复制内容。multiline=true 时用 textarea（多行地址）。
  OB.showCopy = function (title, text, multiline, hint) {
    copyText = text || "";
    copyTitle.textContent = title;
    if (multiline) {
      copyInput.classList.add("hidden");
      copyArea.classList.remove("hidden");
      copyArea.value = copyText;
    } else {
      copyArea.classList.add("hidden");
      copyInput.classList.remove("hidden");
      copyInput.value = copyText;
    }
    copyHint.textContent = hint || "";
    copyModal.classList.remove("hidden");
    setTimeout(() => { (multiline ? copyArea : copyInput).focus(); (multiline ? copyArea : copyInput).select(); }, 30);
  };

  // writeClipboard 复制文本到剪贴板（宿主桥）。
  OB.writeClipboard = async function (text) {
    if (global.dbxPlugin && typeof global.dbxPlugin.copy === "function") {
      await global.dbxPlugin.copy(text);
      return;
    }
    // 无宿主桥时降级：临时 textarea + execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } finally { document.body.removeChild(ta); }
  };

  // OB.copyNow 复制弹窗的「复制」按钮动作。
  // 失败时选中输入框让用户手动 Ctrl+C（沙箱里 execCommand 可能被禁）。
  OB.copyNow = async function () {
    try {
      await OB.writeClipboard(copyText);
      copyHint.textContent = I18N.t("modal.copyHint");
    } catch (e) {
      copyInput.select();
      copyHint.textContent = I18N.t("modal.copyFail");
    }
  };

  $("copyClose").onclick = () => copyModal.classList.add("hidden");
  $("copyBtn").onclick = OB.copyNow;
  copyModal.addEventListener("mousedown", (e) => {
    if (e.target === copyModal) copyModal.classList.add("hidden");
  });

  global.OB = OB;
})(window);
