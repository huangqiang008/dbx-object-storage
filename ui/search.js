// search.js — 搜索模块。
//
// 深度搜索（递归扫描目录树）与过滤条件（大小 / 时间 / 扩展名 / 正则）。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // 纯工具：各模块自行从 window 取（utils.js / icons.js 是纯函数包，无状态依赖）
  const $ = (id) => document.getElementById(id);

  // ---------- 搜索过滤条件（1.5） ----------
  //
  // 过滤在客户端做：服务端列举协议（OSS marker / S3 continuation-token）
  // 不支持按大小或时间过滤，条件只能在拿到结果后本地筛。
  //
  // 过滤条件是「视图层」的，不影响服务端列举——因此切换条件只重筛
  // 当前已加载的 state.items，不重新发请求（重新列举在大桶上代价太高）。
  const filterModal = $("filterModal");
  let filterResolve = null;

  // filterState 当前生效的过滤条件。
  const filterState = {
    minSize: 0,   // 字节
    maxSize: 0,   // 字节，0 = 不限
    days: 0,      // 修改于最近 N 天内，0 = 不限
    exts: [],     // 扩展名白名单（小写，不含点）
    regex: null,  // 名称正则
  };

  // filterMatch 判断一个列表项是否通过全部过滤条件。
  OB.filterMatch = function filterMatch(it) {
    const f = filterState;
    if (f.minSize > 0 && it.size < f.minSize) return false;
    if (f.maxSize > 0 && it.size > f.maxSize) return false;
    if (f.days > 0 && it.modified) {
      const t = Date.parse(it.modified);
      if (!isNaN(t)) {
        const cutoff = Date.now() - f.days * 86400000;
        if (t < cutoff) return false;
      }
    }
    if (f.exts.length) {
      const m = String(it.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
      const ext = m ? m[1] : "";
      if (f.exts.indexOf(ext) < 0) return false;
    }
    if (f.regex) {
      if (!f.regex.test(it.name || "")) return false;
    }
    return true;
  };

  // filterApply 对当前列表套用过滤条件，返回通过过滤的项。
  function filterApply(items) {
    const anyActive = filterState.minSize > 0 || filterState.maxSize > 0 ||
      filterState.days > 0 || filterState.exts.length > 0 || filterState.regex;
    if (!anyActive) return items;
    return items.filter(OB.filterMatch);
  }

  function openFilterModal() {
    return new Promise((resolve) => {
      filterResolve = resolve;
      $("filterMinSize").value = filterState.minSize ? Math.round(filterState.minSize / 1024) : "";
      $("filterMaxSize").value = filterState.maxSize ? Math.round(filterState.maxSize / 1024) : "";
      $("filterDays").value = filterState.days || "";
      $("filterExt").value = filterState.exts.join(",");
      $("filterRegex").value = filterState.regex ? filterState.regex.source : "";
      OB.setModalDetail("");
      filterModal.classList.remove("hidden");
      setTimeout(() => $("filterMinSize").focus(), 30);
    });
  }

  // filterCommit 写入过滤条件并重筛当前列表。
  function filterCommit(f) {
    filterState.minSize = f.minSize || 0;
    filterState.maxSize = f.maxSize || 0;
    filterState.days = f.days || 0;
    filterState.exts = f.exts || [];
    filterState.regex = f.regex || null;
    // 基准必须是「未过滤全量」：state.items 可能已是上次过滤的结果，
    // 在子集上重筛会导致条件放宽后列表不变（快照由 core.js 的 items 访问器维护）
    const base = (OB.shared.allItems && OB.shared.allItems.length)
      ? OB.shared.allItems : OB.state.items;
    // 重筛：全量快照
    const kept = filterApply(base.slice());
    // 目录项不受过滤影响（过滤只针对文件），否则筛完目录会凭空消失
    const dirs = base.filter((it) => it.isDir);
    OB.state.items = dirs.concat(kept.filter((it) => !it.isDir));
    // 上面的赋值会把快照覆盖成本次过滤子集，这里恢复为全量（顺序不能反）
    OB.shared.allItems = base.slice();
    OB.applySort();
    OB.renderList();
    const n = kept.filter((it) => !it.isDir).length;
    OB.setStatus(I18N.t("search.filtered", { n, t: OB.state.items.length }));
  }

  if (filterModal) {
    $("filterCancel").onclick = () => {
      filterModal.classList.add("hidden");
      if (filterResolve) { const r = filterResolve; filterResolve = null; r(null); }
    };
    $("filterReset").onclick = () => {
      filterModal.classList.add("hidden");
      if (filterResolve) { const r = filterResolve; filterResolve = null; r({ reset: true }); }
    };
    $("filterOk").onclick = () => {
      const minKB = Number($("filterMinSize").value);
      const maxKB = Number($("filterMaxSize").value);
      const days = Number($("filterDays").value);
      const extRaw = $("filterExt").value.trim();
      const regexRaw = $("filterRegex").value.trim();
      let regex = null;
      if (regexRaw) {
        try {
          regex = new RegExp(regexRaw, "i");
        } catch (e) {
          OB.setStatus(I18N.t("batchRename.badRegex"), true);
          return;
        }
      }
      const exts = extRaw
        ? extRaw.split(",").map((s) => s.trim().replace(/^\./, "").toLowerCase()).filter(Boolean)
        : [];
      filterModal.classList.add("hidden");
      if (filterResolve) {
        const r = filterResolve; filterResolve = null;
        r({
          minSize: isNaN(minKB) ? 0 : minKB * 1024,
          maxSize: isNaN(maxKB) ? 0 : maxKB * 1024,
          days: isNaN(days) ? 0 : days,
          exts, regex,
        });
      }
    };
    filterModal.addEventListener("mousedown", (e) => {
      if (e.target === filterModal) $("filterCancel").onclick();
    });
    filterModal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("filterCancel").onclick();
    });
  }

  if ($("searchFilterBtn")) {
    $("searchFilterBtn").onclick = async () => {
      const r = await openFilterModal();
      if (!r) return;
      if (r.reset) {
        filterState.minSize = 0; filterState.maxSize = 0; filterState.days = 0;
        filterState.exts = []; filterState.regex = null;
        // 清除条件后恢复未过滤全量（items 当前是上次过滤的子集）
        if (OB.shared.allItems && OB.shared.allItems.length) {
          OB.setItems(OB.shared.allItems.slice());
        }
        OB.applySort();
        OB.renderList();
        OB.setStatus(I18N.t("search.filterCleared"));
        return;
      }
      filterCommit(r);
    };
  }

  // ---------- 深度搜索（递归扫描当前目录树） ----------
  // 普通搜索是服务端 prefix 过滤，只命中「当前一层」；Shift+Enter 触发深度搜索：
  // 以 当前前缀+搜索词 为 prefix 递归列举（不折叠目录），游标翻页直到耗尽或取消。
  // 结果为全 key 平铺列表，直接进 state.items——批量下载/删除/移动照常可用。
  // 结果集与扫描页数均有上限，防止在桶根误触全桶扫描时无限膨胀。
  const DEEP_SEARCH_CAP = 20000;
  const DEEP_SEARCH_MAX_PAGES = 2000;
  OB.doDeepSearch = async function doDeepSearch() {
    if (!OB.state.connected || !OB.state.bucket) return;
    const q = OB.els.searchInput.value.trim();
    if (!q) return;
    OB.resetPaging();
    OB.state.search = q;
    const gen = OB.shared.listGen; // resetPaging 之后再捕获：它会使旧代次失效
    const prefix = OB.state.prefix + q;
    OB.openDlCard(I18N.t("search.title"), "search");
    $("dlName").textContent = I18N.t("search.scanning");
    let marker = "";
    let pages = 0, found = 0;
    let stopped = false, overCap = false;
    try {
      for (;;) {
        if (OB.shared.dl.cancelled || OB.shared.listGen !== gen) { stopped = true; break; }
        if (found >= DEEP_SEARCH_CAP || pages >= DEEP_SEARCH_MAX_PAGES) { stopped = true; overCap = true; break; }
        const res = await OB.invoke("objects/list", {
          bucket: OB.state.bucket,
          prefix,
          delimiter: "/",
          recursive: true,
          marker,
          maxKeys: 1000,
        }, { timeoutMs: 120000 });
        if (OB.shared.dl.cancelled || OB.shared.listGen !== gen) { stopped = true; break; }
        pages++;
        const items = (res.items || []).map((it) => ({
          name: it.name,
          isDir: false,
          size: it.size || 0,
          mime: it.mime || "",
          modified: it.modified || "",
        }));
        // 过滤在客户端做：服务端列举协议不支持按大小/时间过滤（1.5）。
        // 全量快照收未过滤结果，视图收过滤结果——放宽过滤条件后才能重筛出完整集合。
        const newAll = (OB.shared.allItems || []).concat(items);
        const kept = filterApply(items.slice());
        OB.state.items = OB.state.items.concat(kept);
        OB.shared.allItems = newAll;
        found += kept.length;
        marker = res.next_marker || "";
        $("dlBytes").textContent = I18N.t("search.progress", { n: found, p: pages });
        OB.applySort();
        OB.renderBreadcrumb();
        OB.renderList();
        OB.updateSortIndicators();
        if (!res.is_truncated || !marker) break;
      }
      OB.refreshAcl();
      OB.renderEmptyState();
      $("dlName").textContent = ""; // 清掉"正在扫描…"过时文案
      let text;
      if (stopped) {
        text = I18N.t(overCap ? "search.capHit" : "search.stopped", { n: found });
        OB.finishDlCard(text, true);
      } else {
        text = I18N.t("search.done", { n: found });
        OB.finishDlCard(text);
      }
      OB.setStatus(text, overCap);
    } catch (e) {
      if (OB.shared.listGen === gen) {
        OB.failDlCard(I18N.t("search.fail") + ((e && e.message) || e));
        OB.setStatus(I18N.t("search.fail") + ((e && e.message) || e), true);
      }
    }
  };


})(window.OB);
