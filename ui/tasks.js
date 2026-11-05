// tasks.js — 传输任务中心（B1）。
//
// 统一记录批量传输的结果（下载/上传/删除/移动/复制），失败清单落盘 sidecar
// （tasks/append，后端只管存取，见 backend/rpc_tasks.go），任务中心可回看
// 历史并对「下载」类失败项一键重试（objects/save 断点续传兜底）。
//
// 刻意不提供重试的类型：删除/移动/复制有副作用（重复执行 = 二次删除/搬迁），
// 只记录不重试；上传的 File 句柄无法序列化落盘（跨重启必失效），
// 会话内已有 dlRetry 按钮，不在任务中心重复提供。
//
// 本文件是 core.js 之后的经典 script 模块：宿主 UI 跑在 origin=null 的
// 沙箱 iframe 里，ES Module 不可用，必须经典 script + OB 命名空间。

(function (OB) {
  "use strict";

  const { esc } = window.Utils;
  const { svg } = window.ICONS;
  const $ = (id) => document.getElementById(id);

  // 会话内记录（最新在前）。持久化在 sidecar tasks.jsonl，这里只做打开
  // 任务中心前的即时渲染缓存；打开时始终以 tasks/list 为准。
  OB.shared.tasks = [];

  // ---------- 记录 ----------

  // recordTask 记录一次批量传输的结果。
  // info: { type, bucket, dstBucket, dir, keys, ok, failed[{key,error,rel}], cancelled }
  // 落盘 fire-and-forget：记录失败绝不阻塞主流程（传输结果本身已经完成）。
  OB.recordTask = function recordTask(info) {
    const o = info || {};
    const rec = {
      id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: o.type || "download",
      bucket: o.bucket || "",
      dstBucket: o.dstBucket || "",
      dir: o.dir || "",
      keys: o.keys || [],
      ok: o.ok || 0,
      failed: o.failed || [],
      cancelled: !!o.cancelled,
      ts: Date.now(),
    };
    OB.shared.tasks.unshift(rec);
    if (OB.shared.tasks.length > 200) OB.shared.tasks.length = 200;
    OB.invoke("tasks/append", { record: rec }).catch(() => {});
    // 任务中心开着时增量刷新（关着则下次打开重新 list）
    const ov = $("tasksOverlay");
    if (ov && !ov.classList.contains("hidden")) renderTasks();
    return rec;
  };

  // ---------- 任务中心 UI ----------

  let taskDetailOpen = {}; // id -> bool，重渲染时保持展开态

  function fmtTs(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function typeIcon(type) {
    const map = { download: "download", upload: "upload", delete: "trash", move: "move", copy: "copy" };
    return map[type] || "list";
  }

  function taskSummary(t) {
    const parts = [I18N.t("tasks.ok", { n: t.ok || 0 })];
    if (t.failed && t.failed.length) parts.push(I18N.t("tasks.fail", { n: t.failed.length }));
    if (t.cancelled) parts.push(I18N.t("tasks.cancelled"));
    return parts.join(" · ");
  }

  function renderTasks() {
    const listEl = $("tasksList");
    if (!listEl) return;
    if (!OB.shared.tasks.length) {
      listEl.innerHTML = `<div class="tasks-empty">${esc(I18N.t("tasks.empty"))}</div>`;
      return;
    }
    let html = "";
    for (const t of OB.shared.tasks) {
      const failed = (t.failed && t.failed.length) || 0;
      const bucket = t.bucket ? `${OB.displayName({ name: t.bucket.replace(/\/$/, "") })}` : "";
      const dst = t.dstBucket && t.dstBucket !== t.bucket ? " → " + esc(t.dstBucket) : "";
      const retryable = t.type === "download" && failed > 0 && !t.cancelled;
      const open = taskDetailOpen[t.id] ? " open" : "";
      let detail = "";
      if (failed > 0) {
        const rows = t.failed.slice(0, 50).map((f) =>
          `<div class="task-err-row"><span class="task-err-key">${esc(OB.displayName({ name: f.key }))}</span><span class="task-err-msg">${esc(OB.truncateErr ? OB.truncateErr(f.error) : String(f.error || ""))}</span></div>`
        ).join("");
        const more = failed > 50 ? `<div class="task-err-more">${esc(I18N.t("tasks.moreErrs", { n: failed - 50 }))}</div>` : "";
        detail = `<details class="task-detail"${open}><summary>${esc(I18N.t("tasks.fail", { n: failed }))}</summary>${rows}${more}</details>`;
      }
      html += `<div class="task-item" data-task="${esc(t.id)}">` +
        `<div class="task-head">` +
        `<span class="task-ico">${ICONS.svg(typeIcon(t.type), 15)}</span>` +
        `<span class="task-type">${esc(I18N.t("tasks.type." + t.type))}</span>` +
        `<span class="task-bucket">${bucket}${dst}</span>` +
        `<span class="task-summary${failed ? " has-fail" : ""}${t.cancelled ? " is-cancel" : ""}">${esc(taskSummary(t))}</span>` +
        `<span class="task-time">${fmtTs(t.ts)}</span>` +
        (retryable ? `<button type="button" class="task-retry" data-retry="${esc(t.id)}">${esc(I18N.t("tasks.retry"))}</button>` : "") +
        `</div>${detail}</div>`;
    }
    listEl.innerHTML = html;
    // 重试按钮：从记录重放批量下载（保留原始落盘目录与相对路径，断点续传兜底）
    listEl.querySelectorAll("[data-retry]").forEach((btn) => {
      btn.onclick = () => {
        const rec = OB.shared.tasks.find((x) => x.id === btn.getAttribute("data-retry"));
        if (rec) retryDownload(rec);
      };
    });
    // 明细展开态记忆
    listEl.querySelectorAll("details.task-detail").forEach((d) => {
      const item = d.closest(".task-item");
      if (!item) return;
      d.addEventListener("toggle", () => { taskDetailOpen[item.getAttribute("data-task")] = d.open; });
    });
  }

  // retryDownload 对下载任务的失败项重放 objects/save。
  // 记录里带了原始落盘目录（dir）与相对路径（rel），可直接复刻原始落盘位置；
  // 中断过的对象由后端 .part 断点续传，不会重头下载。
  async function retryDownload(rec) {
    if (!rec || !rec.failed || !rec.failed.length) return;
    const bucket = rec.bucket;
    if (!bucket) { OB.setStatus(I18N.t("tasks.loadFail"), true); return; }
    const items = rec.failed.slice(); // [{key, error, rel}]
    OB.openDlCard(I18N.t("tasks.retryTitle", { n: items.length }), "download");
    OB.dlProgressItems(0, items.length);
    let done = 0, fail = 0, cancelled = false, next = 0;
    const failed = [];
    const worker = async () => {
      for (;;) {
        if (OB.shared.dl.cancelled) { cancelled = true; return; }
        const i = next++;
        if (i >= items.length) return;
        const f = items[i];
        $("dlName").textContent = OB.displayName({ name: f.key });
        $("dlName").title = f.key;
        try {
          await OB.invoke("objects/save", {
            bucket, path: f.key, downloadDir: rec.dir, picked: true,
            relPath: f.rel || "",
          }, { timeoutMs: 600000 });
          done++;
        } catch (e) {
          fail++;
          failed.push({ key: f.key, error: String((e && e.message) || e), rel: f.rel || "" });
        }
        OB.dlProgressItems(done + fail, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, items.length) }, worker));
    $("dlName").textContent = "";
    const text = cancelled
      ? I18N.t("batch.cancelled", { n: done, r: items.length - done - fail })
      : I18N.t("tasks.retryDone", { n: done, m: fail });
    if (fail && !cancelled) OB.failDlCard(text); else OB.finishDlCard(text, cancelled);
    OB.setStatus(text, !!fail);
    // 记录为一条新的下载任务（仍失败的项继续可重试）
    OB.recordTask({
      type: "download", bucket, dir: rec.dir,
      keys: items.map((x) => x.key),
      ok: done, failed, cancelled,
    });
  }

  // openTasks 拉取历史并打开任务中心。list 失败时仍显示会话内记录。
  async function openTasks() {
    const ov = $("tasksOverlay");
    if (!ov) return;
    ov.classList.remove("hidden");
    try {
      const r = await OB.invoke("tasks/list", { limit: 200 });
      const list = (r && r.tasks) || [];
      // sidecar 历史与会话内记录合并去重（会话内的记录 append 成功后就在历史里）
      const seen = new Set(OB.shared.tasks.map((x) => x.id));
      for (const t of list) {
        if (!seen.has(t.id)) OB.shared.tasks.push(t);
      }
      OB.shared.tasks.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (OB.shared.tasks.length > 200) OB.shared.tasks.length = 200;
    } catch (e) {
      // sidecar 不可用（如刚启动尚未连接）：退化为只看会话内记录
      const listEl = $("tasksList");
      if (listEl && !OB.shared.tasks.length) {
        listEl.innerHTML = `<div class="tasks-empty">${esc(I18N.t("tasks.loadFail"))}</div>`;
        return;
      }
    }
    renderTasks();
  }

  function closeTasks() {
    const ov = $("tasksOverlay");
    if (ov) ov.classList.add("hidden");
  }

  // ---------- 绑定 ----------

  const tasksBtn = $("tasksBtn");
  if (tasksBtn) tasksBtn.onclick = () => { void openTasks(); };

  const tasksClose = $("tasksClose");
  if (tasksClose) tasksClose.onclick = closeTasks;

  const tasksClear = $("tasksClear");
  if (tasksClear) tasksClear.onclick = async () => {
    const ok = await OB.openConfirm(I18N.t("modal.confirmTitle"), I18N.t("tasks.clearTip"));
    if (!ok) return;
    OB.shared.tasks = [];
    taskDetailOpen = {};
    try { await OB.invoke("tasks/clear", {}); } catch (e) { /* 尽力而为 */ }
    renderTasks();
    OB.setStatus(I18N.t("tasks.cleared"));
  };

  const ov = $("tasksOverlay");
  if (ov) {
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeTasks(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !ov.classList.contains("hidden")) closeTasks();
    });
  }
})(window.OB);
