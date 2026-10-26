// batch.js — 批量操作模块。
//
// 批量删除 / 下载 / 移动 / 复制 / 重命名，以及目标目录树选择器。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // 纯工具：各模块自行从 window 取（utils.js / icons.js 是纯函数包，无状态依赖）
  const { esc } = window.Utils;
  const svg = window.ICONS.svg;
  const $ = (id) => document.getElementById(id);

  // ---------- 目标目录选择器（批量移动/复制） ----------
  // 桶内目录树懒加载：objects/list + delimiter 折叠目录，点箭头逐层展开。
  // 单选目标目录（含桶根），确定后以 {bucket, prefix} 回传
  //（prefix = "" 表示桶根，恒以 / 结尾）。
  // 对象存储没有可枚举的目录树 API，这正是逐层懒加载的形态：每层一次
  // 列举请求（maxKeys 1000 内的目录项），不扫全桶。
  //
  // 跨桶支持（2.2）：顶部有目标桶下拉。切桶后树整体重建（换桶 = 换命名空间，
  // 原树的结构不再适用）。回传时带上目标桶，调用方据此决定走同桶还是跨桶接口。
  const dirTreeModal = $("dirTreeModal");
  let dirTreeResolve = null;
  let dirTreeChosen = "";
  let dirTreeBucket = "";   // 当前树所属的桶
  const dirTreeLoaded = new Set(); // 已展开过的 prefix（懒加载只拉一次）

  function dtBranch(prefix, label, depth) {
    const caret = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
    return `<div class="dt-branch" data-prefix="${esc(prefix)}">` +
      `<div class="dt-node" style="padding-left:${8 + depth * 18}px" title="${esc(prefix || "/")}">` +
        `<span class="dt-caret">${caret}</span>${svg("folder", 14)}<span>${esc(label)}</span>` +
      `</div><div class="dt-kids"></div></div>`;
  }

  function dtBind(scope, depth) {
    scope.querySelectorAll(".dt-branch").forEach((branch) => {
      if (branch.dataset.bound) return;
      branch.dataset.bound = "1";
      const prefix = branch.getAttribute("data-prefix");
      const node = branch.querySelector(":scope > .dt-node");
      const kids = branch.querySelector(":scope > .dt-kids");
      const caret = node.querySelector(".dt-caret");
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        const opening = !branch.classList.contains("open");
        branch.classList.toggle("open", opening);
        if (opening && !dirTreeLoaded.has(prefix)) {
          dirTreeLoaded.add(prefix);
          dtLoadKids(prefix, kids, depth + 1);
        }
      });
      node.addEventListener("click", (e) => {
        if (e.target === caret || caret.contains(e.target)) return;
        dirTreeModal.querySelectorAll(".dt-node.sel").forEach((n) => n.classList.remove("sel"));
        node.classList.add("sel");
        dirTreeChosen = prefix;
        $("dirTreePath").textContent = "oss://" + (dirTreeBucket || "") + "/" + prefix;
      });
    });
  }

  async function dtLoadKids(prefix, container, depth) {
    container.innerHTML = `<div class="dt-dim">${esc(I18N.t("dirtree.loading"))}</div>`;
    try {
      const res = await OB.invoke("objects/list", {
        bucket: dirTreeBucket, prefix, delimiter: "/", maxKeys: 1000,
      }, { timeoutMs: 60000 });
      const dirs = (res.items || []).filter((it) => it.is_dir || /\/$/.test(it.name));
      if (!dirs.length) {
        container.innerHTML = `<div class="dt-dim">${esc(I18N.t("dirtree.empty"))}</div>`;
        return;
      }
      container.innerHTML = dirs.map((d) => dtBranch(d.name, d.name.slice(prefix.length).replace(/\/$/, ""), depth)).join("");
      dtBind(container, depth);
    } catch (e) {
      container.innerHTML = `<div class="dt-dim">${esc(String((e && e.message) || e))}</div>`;
    }
  }

  function closeDirTree(val) {
    dirTreeModal.classList.add("hidden");
    if (dirTreeResolve) { const r = dirTreeResolve; dirTreeResolve = null; r(val); }
  }

  // dtRenderTree 按当前 dtBucket 重建整棵树（切桶时调用）。
  function dtRenderTree() {
    dirTreeChosen = "";
    dirTreeLoaded.clear();
    $("dirTreePath").textContent = "oss://" + (dirTreeBucket || "") + "/";
    const tree = $("dirTree");
    tree.innerHTML = dtBranch("", I18N.t("dirtree.root"), 0);
    dtBind(tree, 0);
    const rootBranch = tree.querySelector('.dt-branch[data-prefix=""]');
    rootBranch.querySelector(".dt-node").classList.add("sel");
    rootBranch.classList.add("open"); // 默认展开根层级，直观可见
    dirTreeLoaded.add("");
    dtLoadKids("", rootBranch.querySelector(":scope > .dt-kids"), 0);
  }

  // dtLoadBuckets 拉取桶列表填入下拉（跨桶复制/移动用）。
  async function dtLoadBuckets() {
    const sel = $("dirTreeBucket");
    if (!sel) return;
    try {
      const res = await OB.invoke("buckets/list", {}, { timeoutMs: 30000 });
      // buckets/list 返回的是 items 数组（ListItem 形状，name 为桶名）
      const buckets = (res.items || []).map((b) => b.name).filter(Boolean);
      if (!buckets.length) {
        sel.innerHTML = `<option value="${esc(OB.state.bucket || "")}">${esc(OB.state.bucket || "")}</option>`;
        return;
      }
      sel.innerHTML = buckets.map((b) =>
        `<option value="${esc(b)}"${b === OB.state.bucket ? " selected" : ""}>${esc(b)}</option>`
      ).join("");
      // 默认选中当前桶（跨桶是可选动作，不是默认行为）
      if (OB.state.bucket && buckets.indexOf(OB.state.bucket) >= 0) sel.value = OB.state.bucket;
    } catch (e) {
      sel.innerHTML = `<option value="${esc(OB.state.bucket || "")}">${esc(OB.state.bucket || "")}</option>`;
    }
  }

  function openBucketDirPicker() {
    return new Promise((resolve) => {
      dirTreeResolve = resolve;
      dirTreeBucket = OB.state.bucket || "";
      dtLoadBuckets();
      dtRenderTree();
      dirTreeModal.classList.remove("hidden");
    });
  }

  if ($("dirTreeBucket")) {
    $("dirTreeBucket").onchange = (e) => {
      dirTreeBucket = e.target.value || OB.state.bucket || "";
      dtRenderTree(); // 换桶 = 换命名空间，整棵树重建
    };
  }

  if (dirTreeModal) {
    $("dirTreeOk").onclick = () => closeDirTree({ bucket: dirTreeBucket, prefix: dirTreeChosen });
    $("dirTreeCancel").onclick = () => closeDirTree(null);
    dirTreeModal.addEventListener("mousedown", (e) => {
      if (e.target === dirTreeModal) closeDirTree(null);
    });
    dirTreeModal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDirTree(null);
    });
  }

  OB.doBatchDownload = async function doBatchDownload() {
    // 不再截断选择集：分块逐个下载 + 进度卡 + 可取消，上万项也只是耗时长而非失控
    const items = OB.state.items.filter((it) => !it.isDir && OB.state.sel.has(it.name));
    if (!items.length) { OB.setStatus(I18N.t("batch.noFiles"), true); return; }
    const pick = await OB.openDirPicker();
    if (pick === null) { OB.setStatus(I18N.t("download.cancelled")); return; }
    const dir = pick.dir;
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.set === "function") await store.set("downloadDir", dir);
    } catch (e) { /* ignore */ }
    OB.openDlCard(I18N.t("batch.downloadTitle", { n: items.length }));
    OB.dlProgressItems(0, items.length);
    // 2 路并发：小文件多的桶大量耗时在请求往返上，双路即可接近翻倍；
    // 再多收益递减且容易触发服务端限流。断点续传在后端（objects/save），
    // 单文件失败重试时自动从 .part 断点续传。
    const DL_CONC = 2;
    let done = 0, fail = 0, cancelled = false, next = 0, firstErr = "";
    const worker = async () => {
      for (;;) {
        if (OB.shared.dl.cancelled) { cancelled = true; return; }
        const i = next++;
        if (i >= items.length) return;
        const it = items[i];
        $("dlName").textContent = OB.displayName(it);
        $("dlName").title = it.name;
        try {
          await OB.invoke("objects/save", {
            bucket: OB.state.bucket, path: it.name,
            downloadDir: dir, picked: pick.picked,
            relPath: downloadRelPath(it.name), // 保留目录层级（1.1）
          }, { timeoutMs: 600000 });
          done++;
        } catch (e) {
          fail++;
          if (!firstErr) firstErr = String((e && e.message) || e);
        }
        OB.dlProgressItems(done + fail, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DL_CONC, items.length) }, worker));
    if (!cancelled && OB.shared.dl.cancelled) cancelled = true;
    $("dlName").textContent = ""; // 清掉最后一个文件名，结束时卡片只留汇总信息
    let text;
    if (cancelled) {
      text = I18N.t("batch.cancelled", { n: done, r: items.length - done - fail });
      if (fail) text += " · " + I18N.t("batch.failed", { n: fail });
      OB.finishDlCard(text, true);
    } else if (fail) {
      // 首个错误透出：吞掉报错只显示"失败 N 项"无法定位原因
      text = I18N.t("batch.downloadFail", { a: done, b: fail }) + " · " + I18N.t("batch.firstErr", { e: OB.truncateErr(firstErr) });
      OB.failDlCard(text);
    } else {
      text = I18N.t("batch.downloadDone", { n: done });
      OB.finishDlCard(text);
    }
    OB.setStatus(I18N.t("batch.downloadDir") + dir);
  };

  // downloadRelPath 计算对象 key 相对落盘根目录的路径（1.1）。
  //
  // 以前批量下载一律用 filepath.Base 拍平：不同前缀下的同名对象落盘后
  // 互相改名（c.txt / c_1.txt），目录层级彻底丢失。上传方向是保留层级的
  //（webkitRelativePath），下载方向拍平，往返一趟结构就散了。
  //
  // 相对谁：桶内浏览时相对当前前缀（当前目录里的文件直接落在落盘根）；
  // 深搜结果时相对搜索起点前缀（保留搜索结果内部的子目录层级）。
  function downloadRelPath(key) {
    const base = OB.state.prefix || "";
    if (base && key.indexOf(base) === 0) {
      return key.slice(base.length);
    }
    // 不在当前前缀下（深搜结果）：保留 key 的完整相对结构
    return key;
  }

  // ---------- 批量移动 / 复制 ----------
  // 文件逐个 move/copy（2 路并发 + 进度卡 + 可取消）；目录：
  //   移动 → objects/move_dir 逐目录流式搬迁（进度粒度到目录级）；
  //   复制 → v1 不支持，如实计入跳过数（复制目录等于双倍存储成本，先不做）。
  // 目标同名冲突由后端 ensureNotExists 拦截（报错，不静默覆盖）。
  OB.doBatchTransfer = async function doBatchTransfer(mode) {
    if (!OB.guardWritable()) return;
    if (!OB.state.bucket) return;
    const sel = Array.from(OB.state.sel);
    if (!sel.length) return;
    const dirs = [];
    OB.shared.files = [];
    for (const name of sel) {
      const it = OB.state.items.find((x) => x.name === name);
      if (it && it.isDir) dirs.push(name);
      else OB.shared.files.push(name);
    }
    // 目标目录用桶内目录树选择器（懒加载展开 + 单选），不要求用户手输路径。
    // 选择器带目标桶下拉，因此这里可能拿到跨桶目标（2.2）。
    const picked = await openBucketDirPicker();
    if (!picked) return;
    const dstBucket = picked.bucket || OB.state.bucket;
    const crossBucket = dstBucket !== OB.state.bucket;
    let target = picked.prefix || "";
    if (target && !target.endsWith("/")) target += "/";
    const total = OB.shared.files.length + dirs.length;
    const ok = await OB.openConfirm(I18N.t("modal.confirmTitle"),
      mode === "move"
        ? I18N.t("batch.moveTip", { n: total, t: target || "/" })
        : I18N.t("batch.copyTip", { n: total, t: target || "/" })
    );
    if (!ok) return;
    // 标题由 openDlCard 按 mode 取静态文案（不带 {n}，数量在进度行体现）
    OB.openDlCard("", mode);
    OB.dlProgressItems(0, total);
    let done = 0, cancelled = false;
    const failed = [];
    const summary = () => {
      let text = I18N.t(mode === "move" ? "batch.moveDone" : "batch.copyDone", { n: done });
      if (failed.length) text += " · " + I18N.t("batch.failed", { n: failed.length }) + " · " + I18N.t("batch.firstErr", { e: OB.truncateErr(failed[0].error) });
      if (cancelled) text += " · " + I18N.t("batch.cancelled", { n: done, r: total - done - failed.length });
      return text;
    };
    // 1) 文件 2 路并发
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (OB.shared.dl.cancelled) { cancelled = true; return; }
        const i = next++;
        if (i >= OB.shared.files.length) return;
        const name = OB.shared.files[i];
        // 目标文件名取 key 最后一段：普通列表下等于相对名，深度搜索结果
        // （key 带 q/ 相对路径）下也正确
        const base = name.split("/").filter(Boolean).pop() || name;
        if (!cancelled) $("dlName").textContent = base;
        try {
          // 同桶走旧接口，跨桶走 across 接口（后端语义不同：桶参数分离）
          const method = mode === "move"
            ? (crossBucket ? "objects/move_across" : "objects/move")
            : (crossBucket ? "objects/copy_across" : "objects/copy");
          const payload = crossBucket
            ? { bucket: OB.state.bucket, dstBucket, from: name, to: target + base }
            : { bucket: OB.state.bucket, from: name, to: target + base };
          await OB.invoke(method, payload, { timeoutMs: 600000 });
          done++;
        } catch (e) {
          failed.push({ path: name, error: String((e && e.message) || e) });
        }
        OB.dlProgressItems(done + failed.length, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, OB.shared.files.length) }, worker));
    // 2) 目录逐个流式搬迁（移动=搬完删源，复制=保留源）
    for (const dirName of dirs) {
      if (OB.shared.dl.cancelled) { cancelled = true; break; }
      $("dlName").textContent = I18N.t("batch.progressDir", { name: OB.displayName({ name: dirName }) });
      const dirBase = dirName.split("/").filter(Boolean).pop() || dirName.replace(/\/$/, "");
      try {
        if (crossBucket) {
          // 跨桶目录：移动与复制都是 copy_dir_across + （移动时）删源
          await OB.invoke("objects/copy_dir_across",
            { bucket: OB.state.bucket, dstBucket, from: dirName, to: target + dirBase },
            { timeoutMs: 600000 }
          );
          if (mode === "move") {
            await OB.invoke("objects/delete_dir",
              { bucket: OB.state.bucket, path: dirName },
              { timeoutMs: 600000 }
            );
          }
        } else {
          await OB.invoke(mode === "move" ? "objects/move_dir" : "objects/copy_dir",
            { bucket: OB.state.bucket, from: dirName, to: target + dirBase },
            { timeoutMs: 600000 }
          );
        }
        done++;
      } catch (e) {
        failed.push({ path: dirName, error: String((e && e.message) || e) });
      }
      OB.dlProgressItems(done + failed.length, total);
    }
    if (!cancelled && OB.shared.dl.cancelled) cancelled = true;
    $("dlName").textContent = ""; // 清掉过时的"当前项"文案
    const text = summary();
    if (failed.length && !cancelled) OB.failDlCard(text);
    else OB.finishDlCard(text, cancelled);
    OB.setStatus(text, !!failed.length);
    if (done > 0) { OB.resetPaging(); OB.loadPage(""); }
  };

  // ---------- 批量重命名（1.4） ----------
  //
  // 对象存储没有 rename API，重命名 = copy + delete。对选中的一批文件
  // 施加「前缀 / 后缀 / 正则替换 / 序号」规则后逐个改名。
  //
  // 关键约束：改名是「移动」，目标已存在会被 copy 静默覆盖。
  // 因此必须先把所有目标算出来、统一检查冲突，再动手——
  // 否则前面几个改成功、后面撞上同名就停在那里，用户看到半改状态。
  const renameModal = $("renameModal");
  let renameResolve = null;

  // renameApplyRule 对单个文件名施加规则，返回新名字。
  // 规则顺序：正则替换 → 前缀 → 后缀 → 序号。
  // 实现在 rename_rule.js（独立文件，可被 node --test 直接跑单测）。
  function renameApplyRule(base, rule) {
    return window.RenameRule.apply(base, rule);
  }

  function openRenameModal(count) {
    return new Promise((resolve) => {
      renameResolve = resolve;
      $("renameScope").textContent = I18N.t("batchRename.scope", { n: count });
      $("renamePrefix").value = "";
      $("renameSuffix").value = "";
      $("renameFind").value = "";
      $("renameReplace").value = "";
      $("renameSeq").value = "0";
      OB.setModalDetail("");
      renameModal.classList.remove("hidden");
      setTimeout(() => $("renamePrefix").focus(), 30);
    });
  }

  OB.doBatchRename = async function doBatchRename() {
    if (!OB.guardWritable()) return;
    if (!OB.state.bucket) return;
    const sel = Array.from(OB.state.sel);
    if (!sel.length) return;
    // 目录不参与批量改名：目录改名是「前缀搬迁」（move_dir），
    // 与文件的「改名」语义不同，混在一起规则无法统一套用。
    const files = sel.filter((name) => {
      const it = OB.state.items.find((x) => x.name === name);
      return it && !it.isDir;
    });
    if (!files.length) {
      OB.setStatus(I18N.t("batchRename.noFiles"), true);
      return;
    }
    const rule = await openRenameModal(files.length);
    if (!rule) return;

    // 逐个算出新名字
    const plan = [];
    let seq = rule.seq;
    for (const name of files) {
      const raw = name.replace(/\/$/, "");
      const slash = raw.lastIndexOf("/");
      const parent = slash >= 0 ? raw.slice(0, slash + 1) : "";
      const base = raw.slice(slash + 1);
      const next = renameApplyRule(base, {
        find: rule.find, replace: rule.replace, prefix: rule.prefix, suffix: rule.suffix,
        seq: seq !== null && seq !== undefined ? seq++ : null,
      });
      if (next === null) { OB.setStatus(I18N.t("batchRename.badRegex"), true); return; }
      if (!next || next === base) continue; // 无变化，跳过
      if (next.indexOf("/") >= 0 || next.indexOf("\\") >= 0) {
        OB.setStatus(I18N.t("batchRename.badChar"), true);
        return;
      }
      plan.push({ from: name, to: parent + next });
    }
    if (!plan.length) { OB.setStatus(I18N.t("batchRename.noChange")); return; }

    // 冲突预检：新名字之间不能互相撞，也不能撞上已存在的对象
    const targets = new Set();
    for (const p of plan) {
      if (targets.has(p.to)) {
        OB.setStatus(I18N.t("batchRename.conflict", { name: p.to }), true);
        return;
      }
      targets.add(p.to);
    }
    const existed = OB.state.items.filter((x) => targets.has(x.name));
    if (existed.length) {
      OB.setStatus(I18N.t("batchRename.exists", { name: existed[0].name }), true);
      return;
    }

    // 确认
    const ok = await OB.openConfirm(I18N.t("modal.confirmTitle"),
      I18N.t("batchRename.tip", { n: plan.length }));
    if (!ok) return;

    OB.openDlCard(I18N.t("batchRename.title"), "rename");
    OB.dlProgressItems(0, plan.length);
    let done = 0, failed = 0, cancelled = false, firstErr = "";
    for (const p of plan) {
      if (OB.shared.dl.cancelled) { cancelled = true; break; }
      $("dlName").textContent = OB.displayName({ name: p.from });
      try {
        await OB.invoke("objects/move", { bucket: OB.state.bucket, from: p.from, to: p.to }, { timeoutMs: 600000 });
        done++;
      } catch (e) {
        failed++;
        if (!firstErr) firstErr = String((e && e.message) || e);
      }
      OB.dlProgressItems(done + failed, plan.length);
    }
    $("dlName").textContent = "";
    let text;
    if (cancelled) {
      text = I18N.t("batchRename.donePartial", { n: done, t: plan.length });
      OB.finishDlCard(text, true);
    } else if (failed) {
      text = I18N.t("batchRename.donePartial", { n: done, t: plan.length })
        + " · " + I18N.t("batch.failed", { n: failed })
        + " · " + I18N.t("batch.firstErr", { e: OB.truncateErr(firstErr) });
      OB.failDlCard(text);
    } else {
      text = I18N.t("batchRename.done", { n: done });
      OB.finishDlCard(text);
    }
    OB.setStatus(text, failed > 0);
    OB.resetPaging();
    OB.loadPage("");
  };

  if (renameModal) {
    $("renameCancel").onclick = () => {
      renameModal.classList.add("hidden");
      if (renameResolve) { const r = renameResolve; renameResolve = null; r(null); }
    };
    $("renameOk").onclick = () => {
      const seqRaw = $("renameSeq").value;
      const seq = seqRaw === "" ? null : Number(seqRaw);
      const rule = {
        prefix: $("renamePrefix").value,
        suffix: $("renameSuffix").value,
        find: $("renameFind").value,
        replace: $("renameReplace").value,
        seq: (seq !== null && !isNaN(seq)) ? seq : null,
      };
      renameModal.classList.add("hidden");
      if (renameResolve) { const r = renameResolve; renameResolve = null; r(rule); }
    };
    renameModal.addEventListener("mousedown", (e) => {
      if (e.target === renameModal) $("renameCancel").onclick();
    });
    renameModal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("renameCancel").onclick();
    });
  }


})(window.OB);
