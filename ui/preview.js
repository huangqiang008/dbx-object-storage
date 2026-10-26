// preview.js — 预览模块。
//
// 文件预览：图片 / 音视频 / PDF / 文本 / 代码 / Markdown / Office / OFD / 3D，含在线编辑与 3D 工具条。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // 纯工具：各模块自行从 window 取（utils.js / icons.js 是纯函数包，无状态依赖）
  const { esc, formatSize, b64ToBuffer } = window.Utils;
  const $ = (id) => document.getElementById(id);

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
  OB.shared.PREVIEW_TEXT_CAP = 2 * 1024 * 1024;   // 文本预览上限 2MB;
  OB.shared.PREVIEW_BLOB_CAP = 20 * 1024 * 1024;  // 图片/PDF Blob 上限 20MB;
  OB.shared.PREVIEW_MEDIA_CAP = 64 * 1024 * 1024; // 音视频 Blob 上限 64MB;
  const PREVIEW_CHUNK = 1024 * 1024;          // 预览分块 1MB（objects/read 单次上限 8MB 内）
  // 实测沙箱 CSP：img-src 'self' data: blob: → 远程 presign 直链被拦，媒体预览一律走 blob: URL。

  OB.previewKind = function previewKind(name) {
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
  };

  // Markdown / 代码高亮用的两个库：随包本地资产优先（零外联、离线可用），
  // 本地资产缺失时才回退 cdnjs（旧包或资产被剪枝的场景）。失败一律降级纯文本，不阻塞预览。
  OB.shared.MD_ASSETS = {
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
    const first = await OB.invoke("objects/read", { bucket: OB.state.bucket, path, offset: 0, limit: PREVIEW_CHUNK });
    const total = Number(first.size) || 0;
    if (cap && total > cap) throw new Error(I18N.t("preview.tooLarge"));
    // 总长已知，一次性分配；写满后正好是完整内容
    const buf = new Uint8Array(total);
    buf.set(b64ToBuffer(first.content), 0);
    let got = PREVIEW_CHUNK;
    if (onProgress) onProgress(Math.min(got, total), total);
    while (got < total) {
      const n = Math.min(PREVIEW_CHUNK, total - got);
      const r = await OB.invoke("objects/read", { bucket: OB.state.bucket, path, offset: got, limit: n });
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
    const first = await OB.invoke("objects/read", { bucket: OB.state.bucket, path, offset: 0, limit: PREVIEW_CHUNK });
    const total = Number(first.size) || 0;
    const limit = Math.min(total, cap);
    const buf = new Uint8Array(limit);
    buf.set(b64ToBuffer(first.content).subarray(0, limit), 0);
    let got = PREVIEW_CHUNK;
    while (got < limit) {
      const n = Math.min(PREVIEW_CHUNK, limit - got);
      const r = await OB.invoke("objects/read", { bucket: OB.state.bucket, path, offset: got, limit: n });
      buf.set(b64ToBuffer(r.content).subarray(0, n), got);
      got += n;
    }
    return { text: new TextDecoder("utf-8").decode(buf), truncated: total > limit, size: total };
  }

  function setPvMeta(text) { OB.els.pvMeta.textContent = text || ""; }

  // 预览复制：仅文本类预览（text/code/markdown）可用，复制的是原始文本
  OB.shared.pvCopyText = "";

  // pvCurrentItem 当前预览的对象项。在线编辑需要知道「正在编辑哪个对象」，
  // 以及判断它是否可编辑（文本类 / 非只读 / 未超大小上限）。
  OB.shared.pvCurrentItem = null;

  function setPvCopyAvailable(on) {
    if (OB.els.pvCopy) OB.els.pvCopy.classList.toggle("hidden", !on);
    if (!on) OB.shared.pvCopyText = "";
  }

  // ---------- 图片缩放/旋转/平移（pvToolbar；仅图片预览启用） ----------
  // 当前预览对象用上方 pvCurrentItem，此处只维护缩放状态
  let pvZoom = { s: 1, r: 0, x: 0, y: 0 };

  function pvZoomClamp(s) { return Math.min(8, Math.max(0.1, s)); }

  function applyPvZoom() {
    const img = OB.els.pvBody && OB.els.pvBody.querySelector("img.pv-img");
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
    const body = OB.els.pvBody;
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
    OB.els.pvClose.onclick = closePreview;
    // 全屏切换：Office/表格类内容小窗口里挤成一团，全屏后可读性大幅提升
    const fullBtn = $("pvFull");
    if (fullBtn) {
      fullBtn.onclick = () => {
        const box = OB.els.previewOverlay.querySelector(".preview-box");
        if (box) box.classList.toggle("fs");
        // 全屏只改弹窗 CSS（.preview-box.fs → 100vw/100vh），不触发 window resize，
        // O3DV 引擎的自适应监听收不到通知；双 rAF 等 flex 布局生效后手动同步画布
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (OB.shared.pvO3dv && OB.shared.pvO3dv.viewer) OB.shared.pvO3dv.viewer.Resize();
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
    if (d3Edges) d3Edges.onclick = () => pv3dSetEdges(!OB.shared.pvO3dv.edgesOn);
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
        if (!OB.shared.pvCurrentItem || !OB.state.bucket) return;
        try {
          const r = await OB.invoke("objects/presign", { bucket: OB.state.bucket, path: OB.shared.pvCurrentItem.name, expires: OB.shared.presignExpiry });
          let w = null;
          try { w = window.open(r.url, "_blank"); } catch (e2) { w = null; }
          if (!w) { OB.showCopy(I18N.t("presign.title"), r.url, false, I18N.t("presign.publicHint")); OB.setStatus(I18N.t("pv.openBlocked")); }
          else OB.setStatus(I18N.t("presign.ok"));
        } catch (e) {
          OB.showCopy(I18N.t("copy.title") + " · " + I18N.t("presign.fallback"), fallbackUrl(OB.shared.pvCurrentItem));
        }
      };
    }
    if (OB.els.pvCopy) {
      OB.els.pvCopy.onclick = async () => {
        if (!OB.shared.pvCopyText) return;
        const prev = OB.els.pvMeta.textContent;
        try {
          await OB.writeClipboard(OB.shared.pvCopyText);
          setPvMeta(I18N.t("preview.copied"));
        } catch (e) {
          setPvMeta(I18N.t("modal.copyFail"));
        }
        setTimeout(() => { setPvMeta(prev); }, 1500);
      };
    }
    if (OB.els.pvEdit) OB.els.pvEdit.onclick = enterEditMode;
    if (OB.els.pvSave) OB.els.pvSave.onclick = saveEditedText;
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
    if (OB.els.pvEdit) OB.els.pvEdit.classList.toggle("hidden", !showEdit);
    if (OB.els.pvSave) OB.els.pvSave.classList.toggle("hidden", !showSave);
  }

  // canEditCurrent 判断当前预览对象是否可编辑：
  // 必须是文本类（含 HTML，以源码形式编辑）、不是只读连接、且未超大小上限。
  function canEditCurrent(it) {
    if (!it) return false;
    if (OB.state.readOnly) return false; // 只读连接禁止写
    const kind = OB.previewKind(it.name);
    if (kind !== "text" && kind !== "markdown" && kind !== "html") return false;
    if (it.size > EDIT_MAX_BYTES) return false;
    return true;
  }

  async function enterEditMode() {
    const it = OB.shared.pvCurrentItem;
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

    OB.els.pvBody.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "pv-editor";
    ta.value = text;
    ta.spellcheck = false;
    ta.setAttribute("aria-label", OB.displayName(it));
    ta.addEventListener("input", () => {
      pvEditState.dirty = ta.value !== pvEditState.original;
    });
    OB.els.pvBody.appendChild(ta);
    ta.focus();
    setPvMeta(I18N.t("preview.editing"));
    setEditButtons(false, true);
    setPvCopyAvailable(false);
  }

  async function saveEditedText() {
    if (!pvEditState.active) return;
    const ta = OB.els.pvBody.querySelector("textarea.pv-editor");
    if (!ta) return;
    const content = ta.value;
    // 编码后大小才是实际写入量（base64 前的原始字节数）
    const bytes = new Blob([content]).size;
    if (bytes > EDIT_MAX_BYTES) {
      setPvMeta(I18N.t("preview.editTooLarge"));
      return;
    }
    if (!OB.guardWritable()) return;

    setPvMeta(I18N.t("preview.saving"));
    setEditButtons(false, false);
    try {
      await OB.invoke("objects/write", {
        bucket: OB.state.bucket,
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
  OB.shared.pvObjectUrl = "";

  function releasePvObjectUrl() {
    if (!OB.shared.pvObjectUrl) return;
    try { URL.revokeObjectURL(OB.shared.pvObjectUrl); } catch (e) { /* ignore */ }
    OB.shared.pvObjectUrl = "";
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
    OB.els.pvBody.innerHTML = `<div class="pv-fail">${esc(msg)}</div>`;
  }

  function closePreview() {
    OB.els.previewOverlay.classList.add("hidden");
    OB.els.pvBody.innerHTML = ""; // 停掉 video/audio
    destroyPvViewer();
    releasePvObjectUrl();
    exitEditMode();
    setPvToolbar(false);
    setPv3dToolbar(false);
    OB.shared.pvCurrentItem = null;
  }

  // ---------- Office/OFD 预览（file-viewer 安全子集） ----------
  // 本地 IIFE（ui/fileviewer/viewer.iife.js）+ 本地资产（ui/fileviewer/assets/），
  // 渲染全程无外部网络请求（Worker/WASM/字体均从包内相对路径加载）。
  // 仅在首次预览 Office 文件时懒加载，避免拖慢插件启动。
  // 授权边界：仅含 Apache-2.0/MIT 组件，已排除 AGPL CAD 与专有水印 ppt，
  // 详见 ui/THIRD-PARTY-NOTICES.md。
  OB.shared.pvViewer = null;        // 当前 file-viewer 控制器；关闭/切换/失败时必须 destroy（释放 Worker）;
  let fileViewerLoading = null;

  function destroyPvViewer() {
    if (!OB.shared.pvViewer) return;
    try { OB.shared.pvViewer.destroy(); } catch (e) { /* ignore */ }
    OB.shared.pvViewer = null;
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
  OB.shared.pvO3dv = null; // { host, viewer };
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
    if (!OB.shared.pvO3dv) {
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      OB.shared.pvO3dv = { host: null, viewer: null, edgesOn: false, orthoOn: false, bgDark: dark, navFree: false };
    }
    if (!OB.shared.pvO3dv.host) {
      const host = document.createElement("div");
      host.className = "pv-model3d";
      OB.shared.pvO3dv.host = host;
    }
    return OB.shared.pvO3dv.host;
  }

  // ---------- 3D 工具条（适应视图/边线/投影/背景/导航/六向视图/截图） ----------
  // 引擎层 EmbeddedViewer 只提供画布与鼠标交互，工具栏属上游 website 层未集成；
  // 这里基于引擎公开 API 自建轻量工具条。每次加载模型后需重放用户设置
  //（Viewer.Clear 只移除 three 对象，边线等渲染态不跟随新模型）。
  function pv3dEngine() {
    return OB.shared.pvO3dv && OB.shared.pvO3dv.viewer ? OB.shared.pvO3dv.viewer.GetViewer() : null;
  }

  function pv3dSyncButtons() {
    if (!OB.shared.pvO3dv) return;
    const edgesBtn = $("pv3dEdges");
    if (edgesBtn) edgesBtn.classList.toggle("active", !!OB.shared.pvO3dv.edgesOn);
    const projBtn = $("pv3dProj");
    if (projBtn) projBtn.textContent = I18N.t(OB.shared.pvO3dv.orthoOn ? "pv3d.projOrtho" : "pv3d.projPersp");
    const bgBtn = $("pv3dBg");
    if (bgBtn) bgBtn.textContent = I18N.t(OB.shared.pvO3dv.bgDark ? "pv3d.bgDark" : "pv3d.bgLight");
    const navBtn = $("pv3dNav");
    if (navBtn) navBtn.textContent = I18N.t(OB.shared.pvO3dv.navFree ? "pv3d.navFree" : "pv3d.navTurntable");
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
    const c = OB.shared.pvO3dv && OB.shared.pvO3dv.bgDark ? 160 : 0;
    v.SetEdgeSettings(new ov.EdgeSettings(on, new ov.RGBColor(c, c, c), 1));
    if (OB.shared.pvO3dv) OB.shared.pvO3dv.edgesOn = on;
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
    if (OB.shared.pvO3dv) OB.shared.pvO3dv.orthoOn = next === ov.ProjectionMode.Orthographic;
    const btn = $("pv3dProj");
    if (btn) btn.textContent = I18N.t(OB.shared.pvO3dv.orthoOn ? "pv3d.projOrtho" : "pv3d.projPersp");
  }

  function pv3dApplyBg() {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    const dark = OB.shared.pvO3dv && OB.shared.pvO3dv.bgDark;
    v.SetBackgroundColor(new ov.RGBAColor(dark ? 32 : 255, dark ? 32 : 255, dark ? 32 : 255, 255));
  }

  function pv3dToggleBg() {
    if (!OB.shared.pvO3dv) return;
    OB.shared.pvO3dv.bgDark = !OB.shared.pvO3dv.bgDark;
    pv3dApplyBg();
    // 边线颜色与背景强相关，开着就同步换色
    if (OB.shared.pvO3dv.edgesOn) pv3dSetEdges(true);
    const btn = $("pv3dBg");
    if (btn) btn.textContent = I18N.t(OB.shared.pvO3dv.bgDark ? "pv3d.bgDark" : "pv3d.bgLight");
  }

  function pv3dToggleNav() {
    const ov = window.OV;
    const v = pv3dEngine();
    if (!v || !ov) return;
    // FixedUpVector=转台（水平旋转保持 Y 轴向上），FreeOrbit=自由旋转
    const next = OB.shared.pvO3dv.navFree ? ov.NavigationMode.FixedUpVector : ov.NavigationMode.FreeOrbit;
    v.SetNavigationMode(next);
    if (OB.shared.pvO3dv) OB.shared.pvO3dv.navFree = next === ov.NavigationMode.FreeOrbit;
    const btn = $("pv3dNav");
    if (btn) btn.textContent = I18N.t(OB.shared.pvO3dv.navFree ? "pv3d.navFree" : "pv3d.navTurntable");
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
      const base = (OB.shared.pvCurrentItem && OB.shared.pvCurrentItem.name.split("/").pop() || "model").replace(/\.[^.]+$/, "");
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

  OB.openPreview = async function openPreview(it) {
    const kind = OB.previewKind(it.name);
    if (!kind) return;
    // 切换目标前先释放上一个预览的 Blob：否则快速连续点多个文件会累积多个 Blob
    releasePvObjectUrl();
    destroyPvViewer();
    exitEditMode(); // 切换对象时退出上一个对象的编辑态
    OB.shared.pvCurrentItem = it;
    setPvToolbar(false); // 切换/加载中先收起缩放工具条（文本预览不适用）
    setPv3dToolbar(false); // 同上，收起 3D 工具条（3D 分支加载成功后再展开）
    OB.els.pvName.textContent = OB.displayName(it);
    OB.els.pvName.title = it.name;
    OB.els.pvMeta.textContent = "";
    setPvCopyAvailable(false); // 加载中先隐藏复制按钮，文本类成功后再显示
    setEditButtons(false, false); // 加载中不显示编辑/保存按钮
    OB.els.pvBody.innerHTML = `<div class="pv-loading">${I18N.t("status.loading")}</div>`;
    OB.els.previewOverlay.classList.remove("hidden");
    const sizeText = it.size ? formatSize(it.size) : "";

    try {
      if (kind === "office") {
        // file-viewer 渲染 docx/xlsx/pptx/ofd。Blob 包装为带扩展名的 File：
        // 渲染器按扩展名匹配，且 Viewer 内部需要文件名做标题/下载名。
        const { blob } = await readObjectBlob(it.name, OB.shared.PREVIEW_BLOB_CAP, (w, t) => {
          setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
        });
        const sdk = await ensureFileViewer();
        const filename = it.name.split("/").pop();
        const host = document.createElement("div");
        host.className = "pv-office";
        OB.els.pvBody.innerHTML = "";
        OB.els.pvBody.appendChild(host);
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
        OB.shared.pvViewer = sdk.mountViewer(host, {
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
        const { blob } = await readObjectBlob(it.name, OB.shared.PREVIEW_BLOB_CAP, (w, t) => {
          setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
        });
        const ov = await ensureO3dv();
        const filename = it.name.split("/").pop();
        const host = ensurePvO3dvHost();
        OB.els.pvBody.innerHTML = "";
        OB.els.pvBody.appendChild(host);
        if (!OB.shared.pvO3dv.viewer) {
          // 背景跟随宿主明暗主题（bgDark 已在 ensurePvO3dvHost 解析；three 默认
          // 不透明画布，需显式设色）
          const dark = !!OB.shared.pvO3dv.bgDark;
          OB.shared.pvO3dv.viewer = new ov.EmbeddedViewer(host, {
            backgroundColor: new ov.RGBAColor(dark ? 32 : 255, dark ? 32 : 255, dark ? 32 : 255, 255),
          });
        } else {
          OB.shared.pvO3dv.viewer.Resize();
        }
        OB.shared.pvO3dv.viewer.LoadModelFromFileList([new File([blob], filename, { type: guessMimeFromPath(it.name) })]);
        // 重放用户设置：LoadModelFromInputFiles 内部 Clear 后重建渲染态，
        // 边线/投影不自动继承，需按当前开关状态补一次
        const engine = pv3dEngine();
        if (engine) {
          if (OB.shared.pvO3dv.orthoOn) engine.SetProjectionMode(ov.ProjectionMode.Orthographic);
          else engine.SetProjectionMode(ov.ProjectionMode.Perspective);
          if (OB.shared.pvO3dv.edgesOn) pv3dSetEdges(true);
        }
        setPv3dToolbar(true);
        setPvMeta(formatSize(blob.size));
        return;
      }

      if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
        // 沙箱 CSP 只放行 blob: → 统一分块读取拼 Blob 后挂媒体元素
        const cap = (kind === "video" || kind === "audio") ? OB.shared.PREVIEW_MEDIA_CAP : OB.shared.PREVIEW_BLOB_CAP;
        try {
          const { blob } = await readObjectBlob(it.name, cap, (w, t) => {
            setPvMeta(t ? Math.round((w / t) * 100) + "%" : "");
          });
          const url = URL.createObjectURL(blob);
          OB.shared.pvObjectUrl = url; // 登记以便关闭/切换时 revoke
          let el;
          if (kind === "image") {
            el = document.createElement("img");
            el.className = "pv-img";
            el.alt = OB.displayName(it);
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
            el.setAttribute("title", OB.displayName(it));
            setPvMeta(formatSize(blob.size));
          }
          el.onerror = () => {
            el.onerror = null;
            previewError(I18N.t("preview.loadFail"));
          };
          el.src = url;
          OB.els.pvBody.innerHTML = "";
          OB.els.pvBody.appendChild(el);
          if (kind === "image") setPvToolbar(true);
          return;
        } catch (e) {
          previewError((e && e.message) ? e.message : String(e));
          return;
        }
      }

      if (kind === "markdown" || kind === "text" || kind === "html") {
        const r = await readObjectText(it.name, OB.shared.PREVIEW_TEXT_CAP);
        setPvMeta(sizeText + (r.truncated ? " · " + I18N.t("preview.truncated") : ""));
        OB.shared.pvCopyText = r.text;
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
          OB.els.pvBody.innerHTML = "";
          OB.els.pvBody.appendChild(frame);
          return;
        }
        if (kind === "markdown") {
          try {
            await loadScriptAny(OB.shared.MD_ASSETS.marked);
            const unsafe = window.marked.parse(r.text);
            // 自有文件渲染：剥离 script/事件属性后注入
            const safe = unsafe
              .replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/ on\w+="[^"]*"/gi, "");
            OB.els.pvBody.innerHTML = `<div class="pv-md">${safe}</div>`;
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
  };

  function detectLang(name) {
    const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
    const map = { js: "javascript", mjs: "javascript", ts: "typescript", py: "python", yml: "yaml", md: "markdown", html: "xml", htm: "xml", sh: "bash", bat: "dos", ps1: "powershell" };
    return map[ext] || (ext || "plaintext");
  }

  function renderCode(name, text) {
    OB.els.pvBody.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "pv-code";
    const code = document.createElement("code");
    code.textContent = text;
    pre.appendChild(code);
    OB.els.pvBody.appendChild(pre);
    // 高亮为渐进增强：CDN 可用则高亮，失败保持纯文本
    loadStyleAny(OB.shared.MD_ASSETS.hljsCss).catch(() => {});
    loadScriptAny(OB.shared.MD_ASSETS.hljs)
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
  OB.els.previewOverlay.addEventListener("mousedown", (e) => {
    if (e.target === OB.els.previewOverlay) closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !OB.els.previewOverlay.classList.contains("hidden")) closePreview();
    // 排序表头是 span（带 role=button/tabindex），补 Enter/Space 键盘操作
    if (e.key === "Enter" || e.key === " ") {
      const t = e.target;
      if (t && t.closest && t.closest("[data-sort]")) {
        e.preventDefault();
        OB.toggleSort(t.closest("[data-sort]").getAttribute("data-sort"));
      }
    }
  });

  function fallbackUrl(it) {
    const ep = OB.state.endpoint || "";
    const scheme = ep.indexOf("http://") === 0 ? "http" : "https";
    const host = ep.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const key = it.name.split("/").map(encodeURIComponent).join("/");
    // S3 兼容端点（尤其 MinIO 自建）多为 path-style；阿里云为 virtual-host
    if (OB.state.provider === "s3") return `${scheme}://${host}/${OB.state.bucket}/${key}`;
    return `https://${OB.state.bucket}.${host}/${key}`;
  }

  // ---------- 公共读状态扫描（列表徽标） ----------
  // 仅当用户开启「公开状态」开关时运行：合并为单次 RPC（objects/get_acl_batch），
  // 后端按顺序读取每个对象的 ACL。已查过的对象记入 state.aclKnown，不重复查。
  // 扫描是异步且尽力而为的——失败只影响徽标、绝不阻塞浏览。
  let aclScanBusy = false;
  OB.refreshAcl = async function refreshAcl() {
    if (!OB.state.showPublicAcl || !OB.state.bucket) return;
    const gen = OB.shared.listGen;
    const todo = OB.state.items.filter((it) => !it.isDir && !OB.state.aclKnown.has(it.name));
    if (!todo.length) return;
    if (aclScanBusy) return; // 防并发
    aclScanBusy = true;
    OB.setStatus(I18N.t("public.scanning"));
    try {
      const paths = todo.map((it) => it.name);
      const r = await OB.invoke("objects/get_acl_batch", { bucket: OB.state.bucket, paths });
      if (gen !== OB.shared.listGen) return; // 目录已切换，丢弃过期结果
      const map = {};
      (r && r.items || []).forEach((x) => { map[x.path] = !!x.public; });
      todo.forEach((it) => {
        it.public = map[it.name] || false;
        OB.state.aclKnown.add(it.name);
      });
      OB.renderVisible();
      OB.setStatus(I18N.t("status.loaded", { n: OB.state.items.length }));
    } catch (e) {
      OB.setStatus(I18N.t("public.scanFail") + ((e && e.message) ? e.message : ""), true);
    } finally {
      aclScanBusy = false;
    }
  };

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
    if (!OB.state.bucket) { OB.setStatus(I18N.t("addr.missingEndpoint")); return; }
    // 确定当前公开状态：本地已知优先，未知才回退查询。
    let pub = it.public;
    if (pub == null) {
      try {
        const r = await OB.invoke("objects/get_acl", { bucket: OB.state.bucket, path: it.name });
        pub = !!(r && r.public);
      } catch (e) {
        OB.setStatus(I18N.t("public.readFail") + ((e && e.message) ? e.message : ""), true);
        return;
      }
      it.public = pub;
      OB.state.aclKnown.add(it.name);
    }

    // S3 兼容驱动：不支持在线修改，只展示只读说明 / 公共链接。
    if (OB.state.provider === "s3") {
      if (pub) {
        OB.showCopy(I18N.t("public.title"), fallbackUrl(it), false, I18N.t("public.hint"));
      } else {
        OB.setStatus(I18N.t("public.s3ReadOnly"), true);
      }
      return;
    }

    if (OB.state.readOnly) { OB.setStatus(I18N.t("public.readOnly"), true); return; }

    if (pub) {
      const revoke = await OB.openConfirm(I18N.t("public.alreadyTitle"), I18N.t("public.alreadyMsg"));
      if (!revoke) {
        OB.showCopy(I18N.t("public.title"), fallbackUrl(it), false, I18N.t("public.hint"));
        OB.renderVisible();
        return;
      }
      try {
        await OB.invoke("objects/set_acl", { bucket: OB.state.bucket, path: it.name, public: false });
        it.public = false; // 立即更新本地状态与徽标，无需等待扫描
        OB.setStatus(I18N.t("public.revoked"));
      } catch (e) {
        OB.setStatus(I18N.t("public.setFail") + ((e && e.message) ? e.message : ""), true);
      }
    } else {
      const ok = await OB.openConfirm(I18N.t("public.confirmTitle"), I18N.t("public.confirmMsg"), it.name);
      if (!ok) return;
      try {
        await OB.invoke("objects/set_acl", { bucket: OB.state.bucket, path: it.name, public: true });
        it.public = true; // 立即更新本地状态与徽标
        OB.setStatus(I18N.t("public.ok"));
        OB.showCopy(I18N.t("public.title"), fallbackUrl(it), false, I18N.t("public.hint"));
      } catch (e) {
        OB.setStatus(I18N.t("public.setFail") + ((e && e.message) ? e.message : ""), true);
      }
    }
    OB.renderVisible(); // 刷新行内徽标，立即反映最新公开状态
  }

  async function doCopyUrl(it) {
    if (!OB.state.bucket) { OB.setStatus(I18N.t("addr.missingEndpoint")); return; }
    // 询问有效期（秒）：60 ~ 7 天；取消则放弃
    const input = await OB.openPrompt(
      I18N.t("presign.title"),
      I18N.t("presign.placeholder"),
      String(OB.shared.presignExpiry),
      I18N.t("modal.ok")
    );
    if (input == null || input === "") return;
    const expires = Math.min(604800, Math.max(60, parseInt(input, 10) || 86400));
    OB.shared.presignExpiry = expires;
    try {
      const r = await OB.invoke("objects/presign", { bucket: OB.state.bucket, path: it.name, expires });
      const exp = expires >= 3600 && expires % 3600 === 0 ? (expires / 3600) + "h" : expires + "s";
      OB.setStatus(I18N.t("presign.ok") + " (" + exp + ")");
      OB.showCopy(I18N.t("presign.title") + " · " + exp, r.url, false, I18N.t("presign.publicHint"));
    } catch (e) {
      // 预签名失败（如 RAM 无 SignURL 权限）：回退拼接地址（仅公共读场景可用）
      OB.setStatus(I18N.t("presign.fail") + (e.message || e), true);
      OB.showCopy(I18N.t("copy.title") + " · " + I18N.t("presign.fallback"), fallbackUrl(it));
    }
  }

  // 批量复制地址：一次填有效期，为选中的文件并发预签名，多行文本一次复制。
  // 单条签名失败只记数不中断（如个别 key 无权限），结果在弹窗 hint 里如实标注。
  async function doBatchAddr() {
    if (!OB.state.bucket) { OB.setStatus(I18N.t("addr.missingEndpoint")); return; }
    const items = await OB.batchPick(OB.BATCH_CAP, (x) => !x.isDir && OB.state.sel.has(x.name));
    if (!items) return;
    const input = await OB.openPrompt(
      I18N.t("presign.title"),
      I18N.t("presign.placeholder"),
      String(OB.shared.presignExpiry),
      I18N.t("modal.ok")
    );
    if (input == null || input === "") return;
    const expires = Math.min(604800, Math.max(60, parseInt(input, 10) || 86400));
    OB.shared.presignExpiry = expires;
    OB.setStatus(I18N.t("batch.addrWorking", { n: items.length }));
    const exp = expires >= 3600 && expires % 3600 === 0 ? (expires / 3600) + "h" : expires + "s";
    // 分批并发签名（10/批）：避免一次性打满几百上千个并发 RPC 把 webview 或 sidecar 压垮；
    // 单条失败只记数不中断（如个别 key 无权限），结果在弹窗 hint 里如实标注。
    const urls = [];
    let failed = 0;
    const CONC = 10;
    for (let i = 0; i < items.length; i += CONC) {
      const slice = items.slice(i, i + CONC);
      const rs = await Promise.all(slice.map((x) =>
        OB.invoke("objects/presign", { bucket: OB.state.bucket, path: x.name, expires })
          .then((r) => (r && r.url) || "")
          .catch(() => "")
      ));
      for (const u of rs) { if (u) urls.push(u); else failed++; }
    }
    if (!urls.length) {
      OB.setStatus(I18N.t("presign.fail") + I18N.t("batch.addrAllFail"), true);
      return;
    }
    OB.setStatus(I18N.t("presign.ok") + " (" + exp + ")");
    OB.showCopy(I18N.t("batch.addrTitle", { n: urls.length }) + " · " + exp, urls.join("\n"), true, I18N.t("presign.publicHint"));
    if (failed > 0) {
      const hintEl = $("copyHint");
      if (hintEl) hintEl.textContent = I18N.t("batch.addrPartial", { fail: failed, total: items.length });
    }
  }

  // dirObjectCount 预取目录下对象数，用于确认弹窗如实告知「将连带删除 N 个对象」。
  // 统计失败不阻断删除（退化为只显示目录名），但截断（超过后端扫描上限）必须如实标注。
  async function dirObjectCount(it) {
    try {
      const res = await OB.invoke("objects/dir_info", { bucket: OB.state.bucket, path: it.name }, { timeoutMs: 30000 });
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
  OB.doRename = async function doRename(it) {
    if (!OB.guardWritable()) return;
    if (!OB.state.bucket) return;
    const isDir = it.isDir;
    // 目录项 name 形如 "prefix/sub/"，拆出父前缀与末段（末段不含尾斜杠）
    const raw = isDir ? it.name.replace(/\/$/, "") : it.name;
    const slash = raw.lastIndexOf("/");
    const parent = slash >= 0 ? raw.slice(0, slash + 1) : "";
    const oldBase = raw.slice(slash + 1);

    const input = await OB.openPrompt(
      I18N.t("rename.title"),
      I18N.t("rename.placeholder"),
      oldBase,
      I18N.t("rename.ok")
    );
    if (input === null) return;
    const newBase = input.trim();
    if (!newBase) { OB.setStatus(I18N.t("rename.empty")); return; }
    if (newBase === oldBase) return;
    if (newBase.indexOf("/") >= 0 || newBase.indexOf("\\") >= 0) {
      OB.setStatus(I18N.t("rename.badChar"));
      return;
    }
    // 目录名以 / 结尾时保留目录语义；这里显式拒绝用户自己带斜杠，避免 a/b/ 这类歧义
    const target = parent + newBase + (isDir ? "/" : "");

    // 同名冲突检测：直接比对当前已加载的列表项即可（当前目录内的重命名不会跨页）
    const clash = OB.state.items.some((x) => x.name === target && x.name !== it.name);
    if (clash) { OB.setStatus(I18N.t("rename.exists", { name: newBase })); return; }

    OB.setStatus(I18N.t("rename.working", { name: newBase }));
    try {
      if (isDir) {
        // 目录必须走 move_dir：对象存储没有实体目录，move 是单 key copy+delete，
        // 对前缀只会命中（通常不存在的）目录标记对象——要么报 NoSuchKey，
        // 要么搬了个空壳而子对象原地不动。move_dir 会递归搬迁 prefix 下全部对象。
        const res = await OB.invoke("objects/move_dir", {
          bucket: OB.state.bucket, from: it.name, to: target,
        }, { timeoutMs: 600000 });
        const n = (res && res.moved) || 0;
        OB.setStatus(I18N.t("rename.doneDir", { from: OB.displayName(it), to: newBase, count: n }));
      } else {
        await OB.invoke("objects/move", { bucket: OB.state.bucket, from: it.name, to: target }, { timeoutMs: 600000 });
        OB.setStatus(I18N.t("rename.done", { from: OB.displayName(it), to: newBase }));
      }
    } catch (e) {
      OB.setStatus(I18N.t("rename.fail") + (e.message || e), true);
    }
    OB.resetPaging();
    OB.loadPage("");
  };

  OB.doDelete = async function doDelete(it) {
    if (!OB.guardWritable()) return;
    const name = OB.displayName(it);
    if (it.isDir) {
      // 目录删除是真删：递归清空其下所有对象，因此必须先告知影响面再动手。
      const info = await dirObjectCount(it);
      const tip = info
        ? I18N.t(info.truncated ? "delete.dirTipTruncated" : "delete.dirTip", { name, n: info.count })
        : I18N.t("delete.dirTipUnknown", { name });
      const ok = await OB.openConfirm(I18N.t("modal.confirmTitle"), tip, name);
      if (!ok) return;
      if (info && info.truncated) {
        OB.setStatus(I18N.t("delete.dirTooLarge", { name }), true);
        return;
      }
      OB.setStatus(I18N.t("delete.deletingDir", { name }));
      try {
        const res = await OB.invoke(
          "objects/delete_dir",
          { bucket: OB.state.bucket, path: it.name },
          { timeoutMs: 600000 }
        );
        const n = (res && res.deleted) || 0;
        OB.setStatus(I18N.t("delete.dirDeleted", { name, n }));
      } catch (e) {
        OB.setStatus(I18N.t("delete.fail") + (e.message || e), true);
      }
      OB.resetPaging();
      OB.loadPage("");
      return;
    }
    const ok = await OB.openConfirm(I18N.t("modal.confirmTitle"), I18N.t("delete.fileTip"), name);
    if (!ok) return;
    try {
      await OB.invoke("objects/delete", { bucket: OB.state.bucket, path: it.name });
      OB.setStatus(I18N.t("delete.status") + name);
    } catch (e) {
      OB.setStatus(I18N.t("delete.fail") + (e.message || e), true);
    }
    OB.resetPaging();
    OB.loadPage("");
  };

  // 进入目录：单击行内任意位置（名称/空白）或行内「打开」均可触发。
  // 不再依赖原生 dblclick——宿主 webview 对其支持不稳定，且列表虚拟化重绘会销毁行节点，
  // 而原生 dblclick 要求两次 click 命中同一 DOM 节点，稍有重绘就永不触发（曾导致“双击/打开都进不去”）。
  // navCooldown 仅用于抑制“双击”时第二下 click 造成的重复进入。
  let navCooldownUntil = 0;
  OB.enterDir = function enterDir(it) {
    const now = Date.now();
    if (now < navCooldownUntil) return;
    navCooldownUntil = now + 300;
    OB.openDir(it);
  };

  // ---- 指针/鼠标事件：文档级捕获委托（绕开行节点被虚拟化重绘销毁的问题） ----
  // 业务统一在「抬升型」事件上触发（click / pointerup / mouseup），同一手势 350ms 内只处理一次。
  OB.shared.lastActAt = 0;
  let downX = 0, downY = 0;

  // 是否位于弹窗/浮层内（连接对话框、通用模态框、复制弹窗、下载浮窗）。
  // 这些层叠在列表之上，其中的输入框/按钮点击绝不能被当成“点了某一行”。
  OB.inFloatingLayer = function inFloatingLayer(el) {
    return !!(el && el.closest && el.closest("#connectOverlay, #modal, #copyModal, #dlCard, #previewOverlay, #ctxMenu, #dirTreeModal, #renameModal, #metaModal, #filterModal"));
  };

  // 按坐标定位行：即使点击事件的目标不是 .row（被遮挡/落在容器上），也能根据 Y 坐标算出是哪一行。
  OB.rowIndexAt = function rowIndexAt(clientX, clientY) {
    const r = OB.els.list.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return -1;
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return -1;
    // 坐标兜底必须确认命中点最顶层的元素确实属于列表本身，
    // 否则弹窗/浮层覆盖在列表之上时，纯坐标算法会误命中下面的行。
    const top = document.elementFromPoint(clientX, clientY);
    if (!top || !OB.els.list.contains(top)) return -1;
    const y = clientY - r.top + OB.els.list.scrollTop;
    const i = Math.floor(y / OB.shared.ROW_H);
    return (i >= 0 && i < OB.state.items.length) ? i : -1;
  };

  // actOnRow 行操作分派。
  //
  // async：部分动作（如「编辑元数据」）需要先取 stat 才能打开编辑框，
  // 因此这里是 async。调用方不需要 await（fire-and-forget），
  // 但内部错误必须自己吞掉并转成状态提示，不能变成 unhandled rejection。
  OB.actOnRow = async function actOnRow(idx, it, act, e) {
    try {
      await actOnRowInner(idx, it, act, e);
    } catch (err) {
      // 兜底：行操作里的任何未捕获异常都转成状态提示，
      // 不能冒成 unhandled rejection（宿主沙箱里表现为静默无响应）
      OB.setStatus(String((err && err.message) || err), true);
    }
  };

  async function actOnRowInner(idx, it, act, e) {
    // 目录导航（单击进入）：跳过选中高亮——列表即将整体重绘，瞬时的蓝色
    // 选中态只会表现为闪烁（用户反馈）。其余动作（右键菜单/下载/改名等）
    // 仍正常高亮，表示"当前作用行"。
    const willNavigate = act === "open" || ((act === "-" || !act) && it.isDir);
    OB.state.selectedIndex = idx;
    if (!willNavigate) {
      OB.els.listContent.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
      const rowEl = OB.els.listContent.querySelector('.row[data-i="' + idx + '"]');
      if (rowEl) rowEl.classList.add("selected");
    }

    if (act === "ctxmenu") { OB.openCtxMenu(e.clientX, e.clientY, it); return; }
    if (act === "preview") { OB.openPreview(it); return; }
    if (act === "download") { OB.doDownload(it); return; }
    if (act === "addr") { doCopyUrl(it); return; }
    if (act === "public") { doPublic(it); return; }
    if (act === "detail") { OB.openDetail(it); return; }
    if (act === "meta") {
      // 编辑元数据：复用详情面板的 stat 读取，再打开编辑弹窗
      try {
        const st = await OB.invoke("objects/stat", { bucket: OB.state.bucket, path: it.name }, { timeoutMs: 30000 });
        let tags = st.tags;
        if (!tags || !Object.keys(tags).length) {
          try {
            const tr = await OB.invoke("objects/get_tags", { bucket: OB.state.bucket, path: it.name }, { timeoutMs: 30000 });
            tags = (tr && tr.tags) || {};
          } catch (e) { tags = {}; }
        }
        await OB.openMetaEditor(it, Object.assign({}, st, { tags }));
      } catch (e) {
        OB.setStatus(I18N.t("detail.statFailed") + (e.message || e), true);
      }
      return;
    }
    if (act === "rename") { OB.doRename(it); return; }
    if (act === "delete") { OB.doDelete(it); return; }
    if (act === "open") { OB.enterDir(it); return; }
    if (it.isDir) OB.enterDir(it);
  }

  OB.onDocEvent = function onDocEvent(type, e) {
    // 仅左键参与行/按钮分派（右键菜单由独立的 contextmenu 处理器控制，
    // 右键的 mouseup 会先于此把抬升事件误当成行点击，导致右键目录直接进入）
    if (e.button !== 0) return;
    // 1) 按下：只记坐标（用于判断是否拖拽/滚动）
    if (type === "pointerdown" || type === "mousedown") { downX = e.clientX; downY = e.clientY; return; }
    if (type !== "click" && type !== "pointerup" && type !== "mouseup") return;

    // 2) 业务：抬升型事件。先按行元素判定，失败则按坐标兜底（应对遮挡/目标非 .row）。
    if (type !== "click" && (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8)) return; // 拖拽/滚动

    // 弹窗/浮层内的点击（输入框、按钮、空白）一律不参与列表与工具栏委托
    if (OB.inFloatingLayer(e.target)) return;

    if (Date.now() - OB.shared.lastActAt < 350) return;

    // 2a0) 复选框（含表头全选）：优先于行点击分派，避免勾选触发行导航
    const allEl = e.target.closest && e.target.closest("[data-selall]");
    if (allEl) { OB.shared.lastActAt = Date.now(); OB.toggleSelectAll(); return; }
    const ckEl = e.target.closest && e.target.closest("[data-ck]");
    if (ckEl) {
      OB.shared.lastActAt = Date.now();
      // Shift 连选：范围从上次勾选的行连到当前行（资源管理器式操作）
      OB.toggleSel(ckEl.getAttribute("data-ck"), !!e.shiftKey);
      return;
    }

    // 2a0b) 排序表头：早于行分派，避免被当成行点击
    const sortEl = e.target.closest && e.target.closest("[data-sort]");
    if (sortEl) { OB.shared.lastActAt = Date.now(); OB.toggleSort(sortEl.getAttribute("data-sort")); return; }

    // 2a) 功能按钮：文档级委托分派（不依赖 els.* 属性绑定）
    const btn = e.target.closest && e.target.closest("button");
    if (btn && btn.id) {
      const id = btn.id;
      if (id === "refreshBtn") { OB.shared.lastActAt = Date.now(); OB.doRefresh(); return; }
      if (id === "mkdirBtn") { OB.shared.lastActAt = Date.now(); OB.doMkdir(); return; }
      if (id === "uploadBtn") { OB.shared.lastActAt = Date.now(); OB.doUpload(); return; }
      if (id === "uploadDirBtn") { OB.shared.lastActAt = Date.now(); OB.doUploadDir(); return; }
      if (id === "upBtn") { OB.shared.lastActAt = Date.now(); OB.doUp(); return; }
      if (id === "connBtn") { OB.shared.lastActAt = Date.now(); OB.openConnDialog(); return; }
      if (id === "batchDeleteBtn") { OB.shared.lastActAt = Date.now(); OB.doBatchDelete(); return; }
      if (id === "batchDownloadBtn") { OB.shared.lastActAt = Date.now(); OB.doBatchDownload(); return; }
      if (id === "batchMoveBtn") { OB.shared.lastActAt = Date.now(); OB.doBatchTransfer("move"); return; }
      if (id === "batchCopyBtn") { OB.shared.lastActAt = Date.now(); OB.doBatchTransfer("copy"); return; }
      if (id === "batchRenameBtn") { OB.shared.lastActAt = Date.now(); OB.doBatchRename(); return; }
      if (id === "batchAddrBtn") { OB.shared.lastActAt = Date.now(); doBatchAddr(); return; }
      if (id === "batchClearBtn") { OB.shared.lastActAt = Date.now(); OB.state.sel.clear(); OB.state.selAnchor = -1; OB.renderVisible(); OB.updateBatchUI(); return; }
    }

    // 2b) 行：优先取最近的 .row，取不到再用坐标兜底
    const rowEl = e.target.closest && e.target.closest(".row");
    let idx = rowEl ? +rowEl.getAttribute("data-i") : -1;
    // data-act 从最近的带属性祖先取：点击图标中心时 target 是内层 <svg>，自身没有 data-act
    const opEl = (e.target.closest && e.target.closest("[data-act]")) || null;
    let act = opEl ? (opEl.getAttribute("data-act") || "-") : "-";
    if (idx < 0) { idx = OB.rowIndexAt(e.clientX, e.clientY); act = "-"; }
    if (idx < 0) return;

    const it = OB.state.items[idx];
    if (!it) return;

    OB.shared.lastActAt = Date.now();
    OB.actOnRow(idx, it, act, e);
  };

  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
    document.addEventListener(t, (e) => OB.onDocEvent(t, e), true);
  });


})(window.OB);
