// transfer.js — 传输模块。
//
// 下载（进度浮窗 / 断点续传）、上传（并发 / 分片 / 拖拽）、存储类别选择。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // 纯工具：各模块自行从 window 取（utils.js / icons.js 是纯函数包，无状态依赖）
  const { formatSize, base64FromArrayBuffer } = window.Utils;
  const $ = (id) => document.getElementById(id);

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

  OB.shared.dl = { cancelled: false, lastWritten: 0, lastT: 0, mode: "download" };
  // 上传失败待重试的 File 列表（复用断点续传；重试前必须置空，防误触发）
  OB.shared.uploadRetryFiles = null;

  OB.openDlCard = function openDlCard(name, mode) {
    OB.shared.dl.cancelled = false; OB.shared.dl.lastWritten = 0; OB.shared.dl.lastT = 0;
    OB.shared.dl.mode = mode || "download";
    const retryEl = $("dlRetry");
    if (retryEl) retryEl.classList.add("hidden"); // 新一轮开始前先收起重试按钮
    const titleEl = $("dlTitle");
    if (titleEl) {
      const titleKey = {
        upload: "upload.title",
        delete: "batch.delete",
        move: "batch.moveTitle",
        copy: "batch.copyTitle",
        search: "search.title",
      }[OB.shared.dl.mode] || "dl.title";
      titleEl.textContent = I18N.t(titleKey);
    }
    $("dlName").textContent = name;
    $("dlName").title = name;
    dlResetPhase(); // 清掉上一轮可能残留的「正在上传到云端」不确定态
    $("dlFill").style.width = "0%";
    $("dlPct").textContent = "0%";
    $("dlBytes").textContent = "";
    $("dlSpeed").textContent = "";
    const msg = $("dlMsg");
    msg.textContent = ""; msg.className = "dl-msg";
    $("dlCancel").classList.remove("hidden");
    $("dlOk").classList.add("hidden");
    $("dlCard").classList.remove("hidden");
  };
  function dlProgress(written, total) {
    const pct = total > 0 ? Math.min(100, (written / total) * 100) : 0;
    $("dlFill").style.width = pct.toFixed(1) + "%";
    $("dlPct").textContent = pct.toFixed(0) + "%";
    $("dlBytes").textContent = formatSize(written) + " / " + formatSize(total);
    const now = performance.now();
    if (OB.shared.dl.lastT) {
      const dt = (now - OB.shared.dl.lastT) / 1000;
      const db = written - OB.shared.dl.lastWritten;
      if (dt > 0 && db > 0) $("dlSpeed").textContent = (db / dt / 1048576).toFixed(2) + " MB/s";
    }
    OB.shared.dl.lastWritten = written; OB.shared.dl.lastT = now;
  }
  // dlUploadingPhase 把进度卡切到「正在上传到云端」的不确定态。
  //
  // 上传是两跳：先把分片写进 sidecar 的本地临时文件（快，dlProgress 量的是这个），
  // 再由 upload/complete 把临时文件真正传到云端（慢，可达数分钟，且当前后端
  // 不回传进度）。若在第二跳仍显示"100%"，用户会以为已经完成或界面卡死。
  //
  // 这里改为：填充条走不确定态动画、百分比文案换成阶段说明、清空字节与速率
  //（它们描述的是第一跳，已无意义）。单文件上传时进度条从 100% 退到不确定态
  // 是**更诚实**的表达：字节已交给 sidecar ≠ 已上传完成。
  OB.dlUploadingPhase = function dlUploadingPhase(name) {
    if (OB.shared.dl.mode !== "upload") return; // 仅上传有此两阶段
    const fill = $("dlFill");
    if (fill) {
      fill.style.width = "";
      fill.classList.add("indeterminate");
    }
    const pct = $("dlPct");
    if (pct) pct.textContent = I18N.t("upload.phaseUploading");
    const bytes = $("dlBytes");
    if (bytes) bytes.textContent = name || "";
    const speed = $("dlSpeed");
    if (speed) speed.textContent = "";
    // 清掉第一跳的计时基准：否则下次 dlProgress 会拿旧时间算出离谱速率
    OB.shared.dl.lastT = 0;
    OB.shared.dl.lastWritten = 0;
  };

  // dlResetPhase 清除不确定态，供同一张进度卡复用于下一个文件时调用。
  function dlResetPhase() {
    const fill = $("dlFill");
    if (fill) {
      fill.classList.remove("indeterminate");
      fill.style.width = "0%";
    }
  }

  // 按条数（而非字节）推进度：批量下载 / 批量删除的进度单位是「项」
  OB.dlProgressItems = function dlProgressItems(done, total) {
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    $("dlFill").style.width = pct.toFixed(1) + "%";
    $("dlPct").textContent = pct.toFixed(0) + "%";
    $("dlBytes").textContent = done + " / " + total;
    const now = performance.now();
    if (OB.shared.dl.lastT) {
      const dt = (now - OB.shared.dl.lastT) / 1000;
      const dn = done - OB.shared.dl.lastWritten;
      if (dt > 0 && dn > 0) $("dlSpeed").textContent = I18N.t("batch.rate", { n: (dn / dt).toFixed(1) });
    }
    OB.shared.dl.lastWritten = done; OB.shared.dl.lastT = now;
  };
  OB.finishDlCard = function finishDlCard(text, keepFill) {
    $("dlMsg").textContent = text || I18N.t("dl.saved");
    $("dlMsg").className = "dl-msg ok";
    // 必须先清掉不确定态：它带 transform 动画，若残留会让"100%"的填充条
    // 继续来回滑动，看起来像没传完。
    dlResetPhase();
    // keepFill：取消场景保留当前真实进度，不强行拉到 100%
    if (!keepFill) {
      $("dlFill").style.width = "100%";
      $("dlPct").textContent = "100%";
    }
    $("dlSpeed").textContent = "";
    $("dlCancel").classList.add("hidden");
    $("dlOk").classList.remove("hidden");
    const retryEl = $("dlRetry");
    if (retryEl) retryEl.classList.add("hidden");
    OB.shared.uploadRetryFiles = null;
  };
  OB.failDlCard = function failDlCard(err) {
    $("dlMsg").textContent = err;
    $("dlMsg").className = "dl-msg err";
    dlResetPhase(); // 同上：失败收尾也要停掉不确定态动画
    $("dlCancel").classList.add("hidden");
    $("dlOk").classList.remove("hidden");
  };

  async function writeChunk(ft, handleId, offset, b64, total) {
    await ft.write(handleId, offset, b64);
    const n = atob(b64).length;
    dlProgress(offset + n, total);
    return offset + n;
  }

  async function downloadViaHost(it, name) {
    const ft = window.dbxPlugin.fileTransfer;
    OB.openDlCard(name);
    let handleId = null;
    try {
      // 原生保存对话框：用户自选目录与文件名
      const target = await ft.beginSave({ name: name });
      if (!target) { // 用户在原生对话框中取消
        $("dlCard").classList.add("hidden");
        OB.setStatus(I18N.t("download.cancelled") + name);
        return;
      }
      handleId = target.handleId;
      const CHUNK = Math.max(1024, Math.min(DL_CHUNK, target.chunkBytes || DL_CHUNK));

      let res = await OB.invoke("objects/read", { bucket: OB.state.bucket, path: it.name, offset: 0, limit: CHUNK }, { timeoutMs: 60000 });
      const total = Number(res.size) || 0;
      let offset = await writeChunk(ft, handleId, 0, res.content, total);
      while (offset < total && !OB.shared.dl.cancelled) {
        res = await OB.invoke("objects/read", { bucket: OB.state.bucket, path: it.name, offset: offset, limit: CHUNK }, { timeoutMs: 60000 });
        if (!res || !res.content) break;
        offset = await writeChunk(ft, handleId, offset, res.content, total);
      }
      if (OB.shared.dl.cancelled) {
        try { await ft.cancel(handleId); } catch (e) {}
        $("dlCard").classList.add("hidden");
        OB.setStatus(I18N.t("download.cancelled") + name);
        return;
      }
      await ft.finish(handleId);
      OB.finishDlCard();
      OB.setStatus(I18N.t("download.doneName") + name + "（" + formatSize(total) + "）");
    } catch (e) {
      if (handleId != null) { try { await ft.cancel(handleId); } catch (_) {} }
      OB.failDlCard(e.message || String(e));
      OB.setStatus(I18N.t("download.fail") + (e.message || e), true);
    }
  }

  // openDirPicker 下载目录选择：
  //   1) 宿主桥接若提供目录选择 API（预留探测）→ 直接用；
  //   2) sidecar 原生对话框（app/pick_dir：Windows FolderBrowserDialog /
  //      macOS choose folder / Linux zenity）——用户在系统 UI 里自选；
  //   3) 都不可用 → 退回手输路径文本框。
  // 返回 {dir, picked}；用户取消返回 null。picked=true 表示目录来自原生
  // 选择器，后端据此放宽落盘白名单（OS 确认的选择不存在误输/逃逸）。
  OB.openDirPicker = async function openDirPicker() {
    const ft = window.dbxPlugin && window.dbxPlugin.fileTransfer;
    for (const m of ["pickDirectory", "selectDirectory", "chooseDirectory"]) {
      if (ft && typeof ft[m] === "function") {
        try {
          const r = await ft[m]({});
          if (r && r.path) return { dir: r.path, picked: true };
        } catch (e) { /* 尝试下一方案 */ }
      }
    }
    let def = "";
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.get === "function") {
        def = (await store.get("downloadDir")) || "";
      }
    } catch (e) {}
    OB.setStatus(I18N.t("dl.pickerOpening")); // PowerShell 冷启动 2–3 秒，先给个提示
    try {
      const r = await OB.invoke("app/pick_dir", { initialDir: def }, { timeoutMs: 600000 });
      if (r && r.path) return { dir: r.path, picked: true };
      if (r && r.cancelled) return null; // 用户在系统对话框点了取消
    } catch (e) { /* 原生对话框不可用，落到手输兜底 */ }
    const dir = await OB.openPrompt(I18N.t("dl.dirTitle"), I18N.t("dl.dirPlaceholder"), def, I18N.t("dl.dirConfirm"));
    if (!dir) return null;
    return { dir: dir.trim(), picked: false };
  };

  async function downloadViaSidecar(it, name) {
    const pick = await OB.openDirPicker();
    if (pick === null) { OB.setStatus(I18N.t("download.cancelled") + name); return; }
    const dir = pick.dir;
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.set === "function") {
        await store.set("downloadDir", dir);
      }
    } catch (e) {}
    OB.setStatus(I18N.t("download.status") + name + "（" + I18N.t("dl.dirTitle") + ": " + dir + "）");
    try {
      const res = await OB.invoke("objects/save", { bucket: OB.state.bucket, path: it.name, downloadDir: dir, picked: pick.picked }, { timeoutMs: 600000 });
      OB.setStatus(I18N.t("download.done") + res.path);
      OB.showCopy(I18N.t("modal.copyTitle"), res.path);
    } catch (e) {
      OB.setStatus(I18N.t("download.fail") + (e.message || e), true);
    }
  }

  OB.doDownload = async function doDownload(it) {
    const name = OB.displayName(it);
    if (hasHostSave()) {
      await downloadViaHost(it, name);
    } else {
      await downloadViaSidecar(it, name);
    }
  };

  // 空值保护：避免元素缺失时对 null 赋 onclick 抛出 TypeError、进而中断整个脚本
  // （历史事故：index.html 缺 #dlCard 系列元素 → $("dlCancel") 为 null → 顶层抛错 → boot() 永不执行）
  const dlCardEl = $("dlCard");
  const dlCancelEl = $("dlCancel");
  const dlOkEl = $("dlOk");
  const dlCloseEl = $("dlClose");
if (dlCancelEl) dlCancelEl.onclick = () => { OB.shared.dl.cancelled = true; };
if (dlOkEl) dlOkEl.onclick = () => { if (dlCardEl) dlCardEl.classList.add("hidden"); };
// 重试失败项：重新走 runUpload（同一批 File，断点续传只补未完成的分片）
const dlRetryEl = $("dlRetry");
if (dlRetryEl) dlRetryEl.onclick = () => {
  OB.shared.files = OB.shared.uploadRetryFiles;
  OB.shared.uploadRetryFiles = null;
  dlRetryEl.classList.add("hidden");
  if (OB.shared.files && OB.shared.files.length) runUpload(OB.shared.files);
};
  if (dlCloseEl) dlCloseEl.onclick = () => { if (dlCardEl) dlCardEl.classList.add("hidden"); };

  OB.shared.presignExpiry = 86400; // 上次选择的有效期（秒），会话内记忆;

  // ---------- 工具栏 ----------
  // 注意：这些动作不再用 els.*.onclick 属性绑定，而是由文档级事件委托按 id 调用
  // （见 onDocEvent 的“功能按钮”分派）。某些宿主会重建/包裹 DOM，属性绑定会失效，
  // 而委托挂在 document 上不受影响——这正是“内联 onclick 有效、JS 绑定无效”的解法。
  OB.doMkdir = async function doMkdir() {
    if (!OB.guardWritable()) return;
    if (!OB.state.connected) { OB.setStatus(I18N.t("common.notConnected"), true); return; }
    if (!OB.state.bucket) { OB.setStatus(I18N.t("mkdir.enterBucket"), true); return; }
    const name = await OB.openPrompt(I18N.t("modal.mkdirTitle"), I18N.t("modal.mkdirPlaceholder"), "", I18N.t("modal.mkdirConfirm"));
    if (!name) return;
    const key = OB.state.prefix + name.replace(/\/+$/, "") + "/";
    try {
      await OB.invoke("objects/write", { bucket: OB.state.bucket, path: key, content: "", mime: "" });
      OB.setStatus(I18N.t("mkdir.done") + key);
      OB.loadPage("");
    } catch (e) {
      OB.setStatus(I18N.t("mkdir.fail") + (e.message || e), true);
    }
  };

  // 上传入口：文件 / 文件夹共用一个隐藏 input，按钮形态区分。
  // webkitdirectory 是非标准属性，宿主 webview 若不支持会退化为普通文件选择，
  // 此时选目录不可用但选文件仍正常——故用特性检测而非无条件声明。
  OB.shared.SUPPORTS_DIR_PICK = "webkitdirectory" in document.createElement("input");
  OB.shared.dirInput = document.createElement("input");
  OB.shared.dirInput.type = "file";
  OB.shared.dirInput.hidden = true;
  OB.shared.dirInput.multiple = true;
  if (OB.shared.SUPPORTS_DIR_PICK) {
    OB.shared.dirInput.setAttribute("webkitdirectory", "");
    OB.shared.dirInput.setAttribute("directory", "");
  }
  document.body.appendChild(OB.shared.dirInput);

  function pickFiles(input) {
    if (!OB.state.connected) { OB.setStatus(I18N.t("common.notConnected"), true); return; }
    if (!OB.state.bucket) { OB.setStatus(I18N.t("upload.enterBucket"), true); return; }
    input.click();
  }

  OB.doUpload = function doUpload() {
    if (!OB.guardWritable()) return;
    pickFiles(OB.els.fileInput);
  };

  // ---------- 存储类别选择（2.5） ----------
  //
  // 存储类别是「上传时」的属性，不是连接属性——同一个连接可以这次传标准、
  // 下次传归档。因此它挂在工具栏上（而不是连接表单里），
  // 选择结果记进插件 storage，下次打开沿用。
  const STORAGE_CLASS_KEY = "uploadStorageClass";
  const STORAGE_CLASS_VALUES = ["", "standard", "ia", "archive"];

  OB.loadStorageClass = async function loadStorageClass() {
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (!store || typeof store.get !== "function") return;
      const v = await store.get(STORAGE_CLASS_KEY);
      if (v && STORAGE_CLASS_VALUES.indexOf(v) >= 0) {
        OB.state.uploadStorageClass = v;
        if (OB.els.storageClassSel) OB.els.storageClassSel.value = v;
      }
    } catch (e) { /* ignore */ }
  };

  if (OB.els.storageClassSel) {
    OB.els.storageClassSel.onchange = async () => {
      OB.state.uploadStorageClass = OB.els.storageClassSel.value || "";
      try {
        const store = window.dbxPlugin && window.dbxPlugin.storage;
        if (store && typeof store.set === "function") {
          await store.set(STORAGE_CLASS_KEY, OB.state.uploadStorageClass);
        }
      } catch (e) { /* ignore */ }
    };
  }

  OB.doUploadDir = function doUploadDir() {
    if (!OB.guardWritable()) return;
    if (!OB.shared.SUPPORTS_DIR_PICK) {
      OB.setStatus(I18N.t("upload.dirUnsupported"));
      return;
    }
    pickFiles(OB.shared.dirInput);
  };

  // 两个 input 共用同一套处理逻辑：直接传文件列表，不做 DataTransfer 转发
  // （部分 webview 无法构造 DataTransfer，转发会静默失败导致目录上传整体失效）。
  OB.shared.dirInput.onchange = () => {
    OB.shared.files = Array.from(OB.shared.dirInput.files || []);
    if (OB.shared.files.length) runUpload(OB.shared.files);
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

  if (OB.els.list) {
    OB.els.list.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropVisible(true);
    });
    OB.els.list.addEventListener("dragleave", (e) => {
      // 仅当指针真正离开列表才收起（子元素间移动会高频触发 dragleave，否则闪烁）
      if (e.relatedTarget && OB.els.list.contains(e.relatedTarget)) return;
      setDropVisible(false);
    });
    OB.els.list.addEventListener("drop", async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDropVisible(false);
      OB.shared.files = await collectDropFiles(e.dataTransfer);
      if (OB.shared.files.length) runUpload(OB.shared.files);
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
  // UP_CONC 上传并发路数（1.2）。
  //
  // 原实现是纯串行 for 循环：批量上传 50 个文件要 50 轮往返，
  // 而每个文件内部还要分片（256KB 一片），往返次数被进一步放大。
  // 3 路并发与后端批量下载的 2 路、目录搬迁的 4 路处于同一量级，
  // 再多容易触发服务端限流（429）。
  const UP_CONC = 3;

  // ---------- 异步上传任务（issue #11 第二批） ----------
  //
  // upload/complete 现在是**异步**的：它立即返回 taskId，真正上云在后端后台
  // 执行（详见 backend/upload_task.go）。这样 RPC 主循环不再被数分钟的上传独占，
  // 多文件的 3 路并发才真正生效。
  //
  // 代价是前端必须等任务终态，不能像以前那样"complete 返回即完成"——
  // 否则会在文件还没传上去时就报成功、刷新列表看不到新文件。
  //
  // 两条获取进度的通道，互为补充：
  //   1. 事件推送（主）：后端经 host.events 推 <plugin>/uploadProgress；
  //   2. upload/status 轮询（兜底）：宿主不支持 onEvent、或事件丢失时使用。
  // 两者都失败才算上传失败。

  const UPLOAD_PROGRESS_EVENT = "com.object.browser/uploadProgress";
  // 轮询间隔与兜底超时。兜底超时取后端 idle 看门狗（10 分钟）之上留余量：
  // 后端判定卡死会主动把任务置为 cancelled/failed 并推终态事件，
  // 前端这个超时只是"连事件都收不到"时的最后防线，不该先于后端触发。
  const TASK_POLL_INTERVAL = 1000;
  const TASK_WAIT_TIMEOUT = 30 * 60 * 1000;

  // taskId → 等待者。事件到达时唤醒对应的 waitForTask。
  const taskWaiters = new Map();
  let taskEventHooked = false;

  // hookUploadEvents 订阅后端的上传进度事件（只做一次）。
  // 返回是否订阅成功：宿主无 onEvent（老版本/Web 宿主）时退回轮询。
  function hookUploadEvents() {
    if (taskEventHooked) return true;
    const dp = window.dbxPlugin;
    if (!dp || typeof dp.onEvent !== "function") return false;
    try {
      dp.onEvent((msg) => {
        if (!msg || typeof msg.method !== "string") return;
        // 用后缀匹配，避免插件 id 变更时失配
        if (msg.method !== UPLOAD_PROGRESS_EVENT && !msg.method.endsWith("/uploadProgress")) return;
        const p = msg.params || {};
        const taskId = p.taskId;
        if (!taskId) return;
        const w = taskWaiters.get(taskId);
        if (!w) return; // 无人等待（例如任务已被清理），忽略
        w.onEvent(p);
      });
      taskEventHooked = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  // waitForUploadTask 等待异步上传任务到达终态。
  // resolve {state, sent, total, error}；state ∈ done|failed|cancelled。
  //
  // opts.onProgress(sent,total,state)：进度回调（节流由后端做，这里直接转发）。
  // opts.shouldCancel()：每轮检查，返回 true 则请求后端取消并结束等待。
  function waitForUploadTask(taskId, opts) {
    const o = opts || {};
    // 建立事件订阅（幂等）。宿主无 onEvent 时内部返回 false，不影响后续轮询兜底。
    hookUploadEvents();

    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = 0;
      let timeoutTimer = 0;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        taskWaiters.delete(taskId);
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = 0; }
        resolve(result);
      };

      const isTerminal = (s) => s === "done" || s === "failed" || s === "cancelled";

      const handle = (snap) => {
        if (!snap) return;
        if (o.onProgress) {
          try { o.onProgress(snap.sent || 0, snap.total || 0, snap.state); } catch (e) { /* 回调异常不影响等待 */ }
        }
        if (isTerminal(snap.state)) {
          finish({ state: snap.state, sent: snap.sent || 0, total: snap.total || 0, error: snap.error || "" });
        }
      };

      taskWaiters.set(taskId, { onEvent: handle });

      const poll = async () => {
        try {
          const snap = await OB.invoke("upload/status", { taskId });
          handle(snap);
        } catch (e) {
          // 任务不存在/已过期：视为失败，避免永久等待
          finish({ state: "failed", sent: 0, total: 0, error: (e && e.message) || String(e) });
        }
      };

      // 用户取消：请求后端中止（后端 ctx 取消会让 SDK 停止发送）
      const checkCancel = async () => {
        if (!o.shouldCancel || !o.shouldCancel()) return;
        try { await OB.invoke("upload/cancel", { taskId }); } catch (e) { /* 幂等，忽略 */ }
        finish({ state: "cancelled", sent: 0, total: 0, error: "" });
      };

      // 无论是否有事件通道都起轮询：事件可能丢失，轮询保证最终一致。
      // 有事件时轮询只是兜底，通常会被事件抢先。
      //
      // 用递归 setTimeout 而不是 setInterval，有两个原因：
      //   1) 单次 status 请求慢于轮询间隔时，setInterval 会让请求重叠堆积；
      //      递归链保证「上一轮结束才排下一轮」。
      //   2) 沙箱只保证提供 setTimeout/clearTimeout，setInterval 未必存在。
      const scheduleNext = () => {
        if (settled) return;
        pollTimer = setTimeout(tick, TASK_POLL_INTERVAL);
      };
      const tick = async () => {
        if (settled) return;
        await checkCancel();
        if (settled) return;
        await poll();
        scheduleNext();
      };

      timeoutTimer = setTimeout(() => {
        finish({ state: "failed", sent: 0, total: 0, error: I18N.t("upload.taskTimeout") });
      }, TASK_WAIT_TIMEOUT);
      // 立即查一次：小文件上云极快，任务可能在订阅建立前就已结束。
      tick();
    });
  }

  // pinUploadContext 在批次开始时钉住上传目标上下文。
  //
  // 为什么必须钉住：进度卡只是右下角浮动卡片（styles.css .dl-card，position:fixed），
  // 不是遮罩，上传期间用户完全可以点面包屑换目录、甚至切到别的桶。若在每次
  // upload/begin 时才读 OB.state，跑到一半用户一导航，**后续文件就会被传到他
  // 新点开的目录/桶里去**——数据写错位置且无提示。整批共用一份快照即可杜绝。
  function pinUploadContext() {
    return {
      bucket: OB.state.bucket,
      prefix: OB.state.prefix,
      storageClass: OB.state.uploadStorageClass,
    };
  }

  // uploadOneFile 上传单个文件，返回 {ok, key, error}
  //
  // ctx：由 pinUploadContext 钉住的目标上下文（bucket/prefix/storageClass），
  //      整批共用，不随用户中途导航而变。
  // hooks（全部可选）：
  //   onProgress(written,total)      第一跳：分片写入 sidecar 本地临时文件的字节进度。
  //                                  **省略即完全不上报**——多文件并发必须省略，
  //                                  否则 3 个 worker 抢写同一张进度卡会互相覆盖成乱跳的数字。
  //   onUploading(name)              进入第二跳（上云）时回调一次。
  //   onCloudProgress(sent,total)    第二跳的真实云端字节进度（来自后端事件/轮询）。
  async function uploadOneFile(f, key, ctx, hooks) {
    const h = hooks || {};
    let uploadId = null;
    const emit = (w, t) => { if (h.onProgress) h.onProgress(w, t); };
    try {
      const beg = await OB.invoke("upload/begin", {
        bucket: ctx.bucket, path: key, size: f.size, mime: f.type || "",
        storageClass: ctx.storageClass,
      });
      uploadId = beg.uploadId;
      // 后端返回已写入字节数：从断点继续
      let offset = (typeof beg.offset === "number" && beg.offset > 0) ? beg.offset : 0;
      if (beg.resumed && offset > 0) {
        emit(offset, f.size);
      }

      while (offset < f.size) {
        if (OB.shared.dl.cancelled) {
          // 取消时不 abort：保留分片供下次续传（abort 会连分片一起删掉）
          throw new Error(I18N.t("upload.cancelled"));
        }
        const buf = await f.slice(offset, offset + UP_CHUNK).arrayBuffer();
        const r = await OB.invoke("upload/chunk", { uploadId, offset, content: base64FromArrayBuffer(buf) });
        offset = (r && typeof r.written === "number") ? r.written : offset + buf.byteLength;
        emit(offset, f.size);
      }

      // ---- 第二跳：真正上云 ----
      // complete 立即返回 taskId，上传在后端后台进行（backend/upload_task.go）。
      // 这里必须等到任务终态才算这个文件传完：否则会在上传仍在进行时就报成功、
      // 刷新列表也看不到新文件。
      if (h.onUploading) h.onUploading(f.name);
      const comp = await OB.invoke("upload/complete", { uploadId });
      // 会话已被 complete 摘除（takeUploadSession），后续失败不应再 abort/release
      uploadId = null;

      const taskId = comp && comp.taskId;
      if (!taskId) {
        // 兼容旧后端（同步 complete，无 taskId）：返回即完成
        return { ok: true, key };
      }

      const res = await waitForUploadTask(taskId, {
        onProgress: h.onCloudProgress,
        shouldCancel: () => OB.shared.dl.cancelled,
      });
      if (res.state === "done") return { ok: true, key };
      if (res.state === "cancelled") throw new Error(I18N.t("upload.cancelled"));
      throw new Error(res.error || I18N.t("upload.cloudFail"));
    } catch (e) {
      // 取消时**不** abort：abort 会连同已落盘的分片一起删掉，
      // 那样「取消后重传从断点继续」就失效了（分片没了，只能从头传）。
      // 改调 upload/release：释放内存会话与文件句柄，但保留磁盘分片，
      // 下次 upload/begin 由后端接管续传。
      //
      // 其他失败（网络错误、complete 报错）才 abort——分片内容不完整，
      // 留着也没意义，反而占磁盘。
      const cancelled = OB.shared.dl.cancelled;
      if (uploadId) {
        try {
          await OB.invoke(cancelled ? "upload/release" : "upload/abort", { uploadId });
        } catch (e2) { /* 幂等 */ }
      }
      return { ok: false, key, error: (e && e.message) ? e.message : String(e) };
    }
  }

  // uploadTargetKey 计算对象 key。
  // 目录上传（webkitRelativePath 含 "/"）按相对路径保留层级，否则用纯文件名。
  // prefix 取自钉住的 ctx 而非实时 OB.state：多文件上传期间用户可能已导航到
  // 别处，用实时值会把后续文件传到新目录（见 pinUploadContext）。
  function uploadTargetKey(f, ctx) {
    const rel = f.webkitRelativePath || "";
    if (rel && rel.indexOf("/") >= 0) {
      return ctx.prefix + rel; // 形如 "a/b/c.txt"，已含目录层级
    }
    return ctx.prefix + f.name;
  }

  // runUpload 上传给定文件列表，完成后汇总结果。
  // 「上传文件」与「上传文件夹」共用此函数，差异仅在传入的 File 是否带 webkitRelativePath。
  //
  // 并发策略（1.2）：
  //   - 单文件：串行，按字节显示进度（与旧行为一致，能看到实时字节数）
  //   - 多文件：UP_CONC 路并发，进度按「项」推进（多个文件抢同一张进度卡，
  //     按字节显示会互相覆盖成乱跳的数字）
  async function runUpload(files) {
    if (!OB.guardWritable()) return;
    if (!files.length || !OB.state.connected) return;
    if (!OB.state.bucket) { OB.setStatus(I18N.t("upload.enterBucket"), true); return; }

    // 整批共用一份钉住的上下文：期间用户导航不会改变文件去向。
    const ctx = pinUploadContext();
    const done = [];
    const failed = [];
    let cancelled = false;

    if (files.length === 1) {
      // ---------- 单文件：两阶段字节进度 ----------
      // 第一跳（写本地临时文件）与第二跳（上云）都用 dlProgress 显示真实字节；
      // 第二跳开始时先切不确定态，一旦后端推来真实云端进度再恢复百分比条。
      const f = files[0];
      const key = uploadTargetKey(f, ctx);
      OB.openDlCard(f.name, "upload");
      const res = await uploadOneFile(f, key, ctx, {
        onProgress: dlProgress,
        onUploading: (name) => OB.dlUploadingPhase(name),
        onCloudProgress: (sent, total) => {
          // 有真实字节进度就从不确定态切回百分比条（total 未知时维持不确定态）
          if (total > 0) {
            dlResetPhase();
            dlProgress(sent, total);
          }
        },
      });
      if (OB.shared.dl.cancelled) {
        cancelled = true;
      } else if (res.ok) {
        done.push(res.key);
      } else {
        failed.push({ f, key: res.key, error: res.error });
      }
    } else {
      // ---------- 多文件：并发上传，按项推进进度 ----------
      //
      // 进度单位是「项」，且只在单个文件**完整走完两跳**（含上云）后才 +1，
      // 所以不会出现"字节写完就显示 100%"的假进度。
      //
      // 上云阶段不再逐文件切不确定态（3 个 worker 会互相覆盖进度卡），
      // 改为统计"已进入上云阶段的文件数"并在文案里如实说明：
      // 已完成 N/M，另有 K 个正在上传到云端。
      OB.openDlCard(I18N.t("upload.progress", { n: 0, m: files.length }), "upload");
      let next = 0;
      let finished = 0;
      let uploading = 0; // 已写完分片、正在上云的文件数

      const renderSummary = () => {
        const msg = $("dlMsg");
        if (msg) {
          msg.textContent = uploading > 0
            ? I18N.t("upload.cloudPhase", { k: uploading })
            : "";
        }
      };
      const worker = async () => {
        for (;;) {
          if (OB.shared.dl.cancelled) { cancelled = true; return; }
          const i = next++;
          if (i >= files.length) return;
          const f = files[i];
          const key = uploadTargetKey(f, ctx);
          // 当前项显示文件名（并发下多个文件交替，显示的是最近开始的那个）
          $("dlName").textContent = f.name;
          $("dlName").title = f.name;
          // 省略 onProgress：并发下不做字节级上报，避免抢写同一张卡；
          // 进度由下方 dlProgressItems 按「项」推进（只在文件真正传完后 +1）。
          // onUploading 在进入上云阶段时被调用一次，用于统计在途上云文件数。
          let inCloudPhase = false;
          const res = await uploadOneFile(f, key, ctx, {
            onUploading: () => {
              inCloudPhase = true;
              uploading++;
              renderSummary();
            },
          });
          // 只有真正进入过上云阶段的文件才需要递减；
          // 在分片阶段就失败/取消的文件从未计数，减了会变负。
          if (inCloudPhase) uploading = Math.max(0, uploading - 1);
          if (res.ok) done.push(res.key);
          else failed.push({ f, key: res.key, error: res.error });
          finished++;
          OB.dlProgressItems(finished, files.length);
          renderSummary();
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UP_CONC, files.length) }, worker)
      );
      $("dlName").textContent = ""; // 清掉最后一个文件名，结束时卡片只留汇总
      uploading = 0;
    }

    if (cancelled) {
      OB.shared.uploadRetryFiles = null;
      $("dlCard").classList.add("hidden");
      OB.setStatus(I18N.t("upload.cancelledPartial", { done: done.length, total: files.length }));
    } else if (failed.length) {
      const first = failed[0];
      OB.failDlCard(first.error);
      // 失败的 File 留给「重试失败项」：upload/begin 会带回断点 offset，只续传未完成的分片
      OB.shared.uploadRetryFiles = failed.map((x) => x.f).filter(Boolean);
      const retryEl = $("dlRetry");
      if (retryEl && OB.shared.uploadRetryFiles.length) {
        $("dlMsg").textContent += " · " + I18N.t("dl.retryHint", { n: OB.shared.uploadRetryFiles.length });
        retryEl.classList.remove("hidden");
      }
      OB.setStatus(I18N.t("upload.summary", { ok: done.length, fail: failed.length })
        + " · " + I18N.t("upload.fail") + first.key + ": " + first.error, true);
    } else {
      const last = done[done.length - 1];
      const text = done.length > 1 ? I18N.t("upload.doneMulti", { n: done.length }) : I18N.t("upload.done") + last;
      OB.finishDlCard(text);
      OB.setStatus(text);
    }
    // 记入任务中心（B1）：上传只记录（File 句柄不可持久化，重试靠会话内 dlRetry 按钮）
    // bucket 取钉住的 ctx：文件实际传到了那里，与用户此刻在哪无关。
    OB.recordTask({
      type: "upload",
      bucket: ctx.bucket,
      keys: done.concat(failed.map((x) => x.key)),
      ok: done.length,
      failed: failed.map((x) => ({ key: x.key, error: x.error })),
      cancelled,
    });
    // 仅当用户仍停留在「上传目标目录」时才刷新列表。
    //
    // 上传动辄数分钟，期间用户很可能已导航到别处；此时刷新会把他正在看的
    // 视图整份重置（resetPaging 清空 items），既无必要也很突兀。
    // 反之若他还在原地，刷新才能看到刚传上去的文件。
    // 注意 loadPage("") 的参数是分页游标而非 prefix，它内部读 OB.state.prefix，
    // 所以这里必须先确认 state 仍等于 ctx 才能安全调用。
    const stillHere = !cancelled
      && OB.state.bucket === ctx.bucket
      && OB.state.prefix === ctx.prefix;
    if (stillHere) {
      OB.resetPaging();
      OB.loadPage("");
    }
  }

  OB.els.fileInput.onchange = async () => {
    OB.shared.files = Array.from(OB.els.fileInput.files || []);
    OB.els.fileInput.value = ""; // 允许重复选择同一批文件
    await runUpload(OB.shared.files);
  };

  OB.doRefresh = function doRefresh() {
    OB.resetPaging();
    OB.loadPage("");
  };

  OB.doUp = function doUp() {
    if (OB.state.prefix) {
      const parts = OB.state.prefix.replace(/\/$/, "").split("/").filter(Boolean);
      parts.pop();
      OB.navigate(parts.length ? parts.join("/") + "/" : "");
    } else if (OB.state.bucket) {
      OB.state.bucket = "";
      OB.state.search = "";
      OB.els.searchInput.value = "";
      OB.resetPaging();
      OB.loadPage("");
    }
  };

  OB.els.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      OB.state.search = OB.els.searchInput.value.trim();
      // Shift+Enter：深度搜索（递归扫描当前目录树）；普通 Enter：前缀过滤
      if (e.shiftKey) {
        e.preventDefault();
        OB.doDeepSearch();
        return;
      }
      OB.resetPaging();
      OB.loadPage("");
      return;
    }
    // Esc：有过滤时一键清除并把焦点还给列表（回到上一级用 Backspace 即可）
    if (e.key === "Escape" && OB.els.searchInput.value) {
      OB.clearSearch();
      OB.els.searchInput.blur();
    }
  });

  // 语言变化（宿主 init 完成 / 运行时切换语言）后重绘动态文案。
  // 静态 [data-i18n*] 由 I18N.apply() 自行处理；这里只管 JS 生成的：面包屑、列表行、状态栏。
  I18N.onChange(() => {
    OB.updateProviderUI(); // 接入点帮助文案随语言刷新
    if (OB.state.connected) {
      OB.renderBreadcrumb();
      OB.renderList();
      OB.setStatus(OB.state.hasMore
        ? I18N.t("status.loadedMore", { n: OB.state.items.length })
        : I18N.t("status.loaded", { n: OB.state.items.length }));
    } else {
      OB.setStatus(I18N.t("status.notConnected"));
    }
  });


})(window.OB);
