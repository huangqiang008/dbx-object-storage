// meta.js — 元数据模块。
//
// 对象详情面板、元数据编辑、对象标签。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // 纯工具：各模块自行从 window 取（utils.js / icons.js 是纯函数包，无状态依赖）
  const { esc, formatSize, fmtTime } = window.Utils;
  const $ = (id) => document.getElementById(id);

  // ---------- 对象详情面板 ----------
  // 展示单个对象的完整元数据。列表里的「类型/大小」列只给出 MIME 与大小，
  // 这里补齐 ETag、精确时间戳、完整存储键等排障时真正需要的信息。
  const detailModal = $("detailModal");
  OB.shared.detailGrid = $("detailGrid");
  const detailTitle = $("detailTitle");
  let detailKey = "";
  let detailItem = null; // 当前详情项（编辑元数据时需要）

  function detailRow(label, value, mono) {
    return `<div class="detail-row">`
      + `<span class="detail-label">${esc(label)}</span>`
      + `<span class="detail-value${mono ? " mono" : ""}">${esc(value == null ? "" : String(value))}</span>`
      + `</div>`;
  }

  OB.openDetail = async function openDetail(it) {
    if (!OB.state.bucket) return;
    detailKey = it.name;
    detailItem = it;
    detailTitle.textContent = OB.displayName(it);
    OB.shared.detailGrid.innerHTML = detailRow(I18N.t("detail.loading"), "…");
    detailModal.classList.remove("hidden");
    const editBtn = $("detailEditMeta");
    if (editBtn) editBtn.classList.add("hidden");
    try {
      const st = await OB.invoke("objects/stat", { bucket: OB.state.bucket, path: it.name }, { timeoutMs: 30000 });
      // 目录没有 stat 元数据（对象存储里目录只是逻辑前缀），直接用列表项信息
      if (it.isDir) {
        OB.shared.detailGrid.innerHTML =
          detailRow(I18N.t("detail.type"), I18N.t("detail.typeDir")) +
          detailRow(I18N.t("detail.bucket"), OB.state.bucket) +
          detailRow(I18N.t("detail.key"), it.name, true);
        return;
      }
      // 标签是独立的 API（objects/get_tags），失败不影响其余字段展示
      let tags = st.tags;
      if (!tags || !Object.keys(tags).length) {
        try {
          const tr = await OB.invoke("objects/get_tags", { bucket: OB.state.bucket, path: it.name }, { timeoutMs: 30000 });
          tags = (tr && tr.tags) || {};
        } catch (e) { tags = {}; }
      }
      OB.shared.detailGrid.innerHTML = renderDetailRows(Object.assign({}, st, { tags }), it.name);
      // 「编辑元数据」仅对文件开放，且只读连接下不可用
      if (editBtn) editBtn.classList.toggle("hidden", OB.state.readOnly);
    } catch (e) {
      // stat 失败不阻塞查看：退化为展示列表项已有信息
      OB.shared.detailGrid.innerHTML =
        detailRow(I18N.t("detail.type"), it.mime || "") +
        detailRow(I18N.t("detail.size"), formatSize(it.size)) +
        detailRow(I18N.t("detail.key"), it.name, true) +
        detailRow(I18N.t("detail.statFailed"), (e && e.message) || String(e));
    }
  };

  $("detailEditMeta").onclick = async () => {
    if (!detailItem || !OB.state.bucket) return;
    try {
      const st = await OB.invoke("objects/stat", { bucket: OB.state.bucket, path: detailItem.name }, { timeoutMs: 30000 });
      let tags = st.tags;
      if (!tags || !Object.keys(tags).length) {
        try {
          const tr = await OB.invoke("objects/get_tags", { bucket: OB.state.bucket, path: detailItem.name }, { timeoutMs: 30000 });
          tags = (tr && tr.tags) || {};
        } catch (e) { tags = {}; }
      }
      await OB.openMetaEditor(detailItem, Object.assign({}, st, { tags }));
    } catch (e) {
      OB.setStatus(I18N.t("detail.statFailed") + (e.message || e), true);
    }
  };

  $("detailClose").onclick = () => detailModal.classList.add("hidden");
  $("detailCopyKey").onclick = async () => {
    if (!detailKey) return;
    try {
      await OB.writeClipboard(detailKey);
      OB.setStatus(I18N.t("detail.copied"));
    } catch (e) {
      OB.setStatus(I18N.t("modal.copyFail"), true);
    }
  };
  detailModal.addEventListener("mousedown", (e) => {
    if (e.target === detailModal) detailModal.classList.add("hidden");
  });
  detailModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") detailModal.classList.add("hidden");
  });

  // ---------- 对象元数据编辑（2.1） ----------
  //
  // 对象存储没有「原地改元数据」的 API：阿里云与 S3 都只能靠
  // CopyObject + MetadataDirective=REPLACE 把对象复制到自身并替换元数据。
  // 因此保存后对象的 Last-Modified 会被刷新——这是协议固有代价。
  const metaModal = $("metaModal");
  let metaResolve = null;
  let metaTarget = null; // { bucket, path }
  let metaOriginal = null; // 原始元数据（用于「留空=不改」的判断）

  // kvToText 把 {k:v} 格式化成「每行 k=value」，供 textarea 编辑。
  function kvToText(obj) {
    if (!obj) return "";
    return Object.keys(obj).sort().map((k) => k + "=" + (obj[k] === undefined ? "" : obj[k])).join("\n");
  }

  // textToKv 解析 textarea 的「每行 k=value」。空行忽略；
  // 缺少 "=" 的行视为「删除该键」（值为空）。
  function textToKv(text) {
    const out = {};
    String(text || "").split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s) return;
      const i = s.indexOf("=");
      if (i < 0) { out[s] = ""; return; }
      out[s.slice(0, i).trim()] = s.slice(i + 1);
    });
    return out;
  }

  OB.openMetaEditor = async function openMetaEditor(it, st) {
    if (!OB.guardWritable()) return;
    if (!OB.state.bucket) return;
    metaTarget = { bucket: OB.state.bucket, path: it.name };
    metaOriginal = st || {};
    $("metaTitle").textContent = I18N.t("meta.title") + " · " + OB.displayName(it);
    $("metaContentType").value = st.contentType || st.mime || "";
    $("metaDisposition").value = st.contentDisposition || "";
    $("metaCacheControl").value = st.cacheControl || "";
    $("metaUserMeta").value = kvToText(st.userMetadata);
    $("metaTags").value = kvToText(st.tags);
    OB.setModalDetail("");
    metaModal.classList.remove("hidden");
    setTimeout(() => $("metaContentType").focus(), 30);
  };

  if (metaModal) {
    $("metaCancel").onclick = () => {
      metaModal.classList.add("hidden");
      metaTarget = null;
      if (metaResolve) { const r = metaResolve; metaResolve = null; r(null); }
    };
    $("metaOk").onclick = async () => {
      if (!metaTarget) return;
      const target = metaTarget;
      // 只提交「改了」的字段：留空 = 不改（后端 patch 语义）。
      // 空值清空某项做不到——那是协议限制（REPLACE 语义下不传=保留原值）。
      const orig = metaOriginal || {};
      const patch = {};
      const ct = $("metaContentType").value.trim();
      if (ct && ct !== (orig.contentType || orig.mime || "")) patch.contentType = ct;
      const cd = $("metaDisposition").value.trim();
      if (cd !== (orig.contentDisposition || "")) patch.contentDisposition = cd;
      const cc = $("metaCacheControl").value.trim();
      if (cc !== (orig.cacheControl || "")) patch.cacheControl = cc;

      // 自定义 meta 与标签：整体替换（后端 UserMetadata 非 nil = 替换语义）
      const userMeta = textToKv($("metaUserMeta").value);
      if (kvToText(orig.userMetadata) !== kvToText(userMeta)) patch.userMetadata = userMeta;
      const tags = textToKv($("metaTags").value);
      const tagsChanged = kvToText(orig.tags) !== kvToText(tags);

      const btn = $("metaOk");
      btn.disabled = true;
      try {
        if (Object.keys(patch).length) {
          await OB.invoke("objects/set_meta", {
            bucket: target.bucket, path: target.path,
            contentType: patch.contentType || "",
            contentDisposition: patch.contentDisposition || "",
            cacheControl: patch.cacheControl || "",
            userMetadata: patch.userMetadata || null,
          }, { timeoutMs: 120000 });
        }
        if (tagsChanged) {
          await OB.invoke("objects/set_tags", {
            bucket: target.bucket, path: target.path, tags,
          }, { timeoutMs: 60000 });
        }
        metaModal.classList.add("hidden");
        metaTarget = null;
        OB.setStatus(I18N.t("meta.saved"));
        // 刷新详情面板
        const st = await OB.invoke("objects/stat", { bucket: OB.state.bucket, path: target.path }, { timeoutMs: 30000 });
        OB.shared.detailGrid.innerHTML = renderDetailRows(st, target.path);
      } catch (e) {
        OB.setStatus(I18N.t("meta.fail") + (e.message || e), true);
      } finally {
        btn.disabled = false;
      }
    };
    metaModal.addEventListener("mousedown", (e) => {
      if (e.target === metaModal) $("metaCancel").onclick();
    });
    metaModal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("metaCancel").onclick();
    });
  }

  // renderDetailRows 渲染详情面板的行（提取出来供保存后刷新复用）。
  function renderDetailRows(st, key) {
    const size = st && st.size != null ? Number(st.size) : 0;
    let html =
      detailRow(I18N.t("detail.type"), (st && (st.contentType || st.mime)) || "") +
      detailRow(I18N.t("detail.size"), formatSize(size)) +
      detailRow(I18N.t("detail.sizeBytes"), String(size) + " B") +
      detailRow(I18N.t("detail.modified"), (st && st.modified) ? fmtTime(st.modified) : "") +
      detailRow(I18N.t("detail.etag"), (st && st.etag) || "");
    if (st && st.contentDisposition) {
      html += detailRow(I18N.t("detail.disposition"), st.contentDisposition);
    }
    if (st && st.cacheControl) {
      html += detailRow(I18N.t("detail.cacheControl"), st.cacheControl);
    }
    if (st && st.storageClass) {
      html += detailRow(I18N.t("detail.storageClass"), st.storageClass);
    }
    if (st && st.userMetadata && Object.keys(st.userMetadata).length) {
      html += detailRow(I18N.t("detail.userMeta"), kvToText(st.userMetadata), true);
    }
    if (st && st.tags && Object.keys(st.tags).length) {
      html += detailRow(I18N.t("detail.tags"), kvToText(st.tags), true);
    }
    html += detailRow(I18N.t("detail.bucket"), OB.state.bucket) +
      detailRow(I18N.t("detail.key"), key, true);
    return html;
  }


})(window.OB);
