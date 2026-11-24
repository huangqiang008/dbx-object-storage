// browse.js — 浏览模块。
//
// 目录浏览、分页虚拟化、排序、多选、文件类型图标、键盘快捷键、列宽拖拽。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // 纯工具：各模块自行从 window 取（utils.js / icons.js / scan.js 是纯函数包，无状态依赖）
  const { esc, formatSize, fmtTime } = window.Utils;
  const svg = window.ICONS.svg;
  const Scan = window.Scan;
  const $ = (id) => document.getElementById(id);

  // ---------- 浏览（bucket 感知 + 分页 + 虚拟化 + 前缀过滤） ----------
  OB.shared.ROW_H = 32;

  // 请求代次（generation）：每次「重置列表」自增。
  // loadPage 捕获进入时的代次，await 之后先比对是否已过期——过期就直接丢弃结果，
  // 不再写入 state.items、不再渲染。
  //
  // 为什么不用 state.loading 布尔：它在 await 期间为 true，会挡住并发请求，
  // 但切目录时导航并不经过 loadPage 的入口判断，旧请求照样能在新目录里落地，
  // 把上一个目录的数据渲染出来（搜索 + 快速切换目录即可复现）。
  OB.shared.listGen = 0;

  // 最后一次「首页加载成功」的位置（bucket+prefix）。重试按钮据此回退：
  // 导航到新位置失败后（如点面包屑桶名进入全桶列表被拒），重试不应重复
  // 同一个注定失败的请求，而应回到最后成功的目录。enterBrowser 换连接时重置。
  OB.shared.lastGoodLoc = null;

  // invalidateList 作废当前所有在途列表请求（切目录/改搜索/刷新时调用）
  OB.invalidateList = function invalidateList() {
    OB.shared.listGen++;
    OB.state.loading = false;
  };

  OB.loadPage = async function loadPage(marker) {
    if (OB.state.loading) return;
    const gen = OB.shared.listGen;
    OB.state.loading = true;
    OB.state.loadError = "";
    // 新目录/刷新：复位全量扫描的截断标记（上一目录的扫描结果不再适用）
    if (!marker) OB.state.scanTruncated = false;
    if (!marker && !OB.state.items.length) { ensureListExtras(); if (OB.shared.skelNode) OB.shared.skelNode.classList.remove("hidden"); }
    OB.setStatus(marker ? I18N.t("status.loadingMore") : I18N.t("status.loading"));
    try {
      let items;
      OB.shared.rawPage = null; // 本页未过滤原始数据（对象分支填，见下）
      if (!OB.state.bucket && OB.state.prefix === "") {
        const res = await OB.invoke("buckets/list", {});
        items = (res.items || []).map((it) => ({
          name: it.name,
          isDir: true,
          size: 0,
          mime: "application/x-bucket",
          modified: "",
        }));
        if (OB.state.search) {
          const q = OB.state.search.toLowerCase();
          items = items.filter((it) => it.name.toLowerCase().includes(q));
        }
        OB.state.isTruncated = false;
        OB.state.nextMarker = "";
        OB.state.hasMore = false;
        if (!marker) OB.state.items = [];
      } else {
        const res = await OB.invoke("objects/list", {
          bucket: OB.state.bucket,
          prefix: OB.state.prefix + (OB.state.search || ""),
          delimiter: "/",
          marker: marker || "",
          maxKeys: OB.state.pageSize,
        });
        // 过期响应：目录/搜索条件已变，丢弃整份结果，避免污染新目录
        if (gen !== OB.shared.listGen) return;
        items = (res.items || []).map((it) => ({
          name: it.name,
          isDir: !!it.is_dir || /\/$/.test(it.name),
          size: it.size || 0,
          mime: it.mime || "",
          modified: it.modified || "",
        }));
        OB.state.isTruncated = !!res.is_truncated;
        OB.state.nextMarker = res.next_marker || "";
        OB.state.hasMore = OB.state.isTruncated && !!OB.state.nextMarker;
        if (!marker) OB.state.items = [];
        // 快照收本页未过滤原始数据（供放宽过滤条件后重筛全量），视图收过滤结果
        OB.shared.rawPage = items.slice();
        // 过滤在客户端做（1.5）：目录项不过滤（否则筛完目录凭空消失）
        items = items.filter((it) => it.isDir || OB.filterMatch(it));
      }
      // buckets/list 分支同样需要这道校验（其 await 之后才有 items）
      if (gen !== OB.shared.listGen) return;
      if (OB.shared.rawPage) {
        // 对象分支：全量快照收未过滤原始页（!marker 时重新起算），视图收过滤页
        OB.shared.allItems = (marker ? OB.shared.allItems : []).concat(OB.shared.rawPage);
        OB.shared.rawPage = null;
        OB.state.items = OB.state.items.concat(items);
      } else {
        // buckets 分支：无对象过滤概念，快照与视图一致
        OB.setItems(OB.state.items.concat(items));
      }
      // 排序必须在每次加载后执行：翻页追加的对象也要纳入当前排序
      OB.applySort();
      OB.renderBreadcrumb();
      OB.renderList();
      OB.updateSortIndicators();
      // 扫描「公共读」徽标（若用户开启了该开关）：仅拉取尚未查过的对象，
      // 异步进行、不阻塞浏览；出错仅影响徽标，不中断列表。
      OB.refreshAcl();
      // 首页加载成功后记录最近访问（fire-and-forget，失败静默）
      if (!marker) void OB.rememberRecent();
      // 首页成功即更新位置基线（buckets 分支与 objects 分支都走这里），
      // 作为后续「重试回退到上一正常目录」的目标
      if (!marker) OB.shared.lastGoodLoc = { bucket: OB.state.bucket, prefix: OB.state.prefix };
      OB.setStatus(OB.state.hasMore
        ? I18N.t("status.loadedMore", { n: OB.state.items.length })
        : I18N.t("status.loaded", { n: OB.state.items.length }));
    } catch (e) {
      if (gen !== OB.shared.listGen) return; // 过期请求的失败不打扰当前视图
      OB.state.loadError = (e && e.message) ? e.message : String(e);
      // 失败时 state.bucket/prefix 可能刚被导航改掉（如点桶图标进全桶列表被拒），
      // 面包屑必须同步到当前实际位置，否则会显示一个并未加载成功的目录。
      OB.renderBreadcrumb();
      OB.setStatus(I18N.t("status.loadFail") + (e && e.message ? e.message : e), true);
    } finally {
      // 只清理自己这一代的状态：避免旧请求的 finally 把新请求的 loading 提前置否
      if (gen === OB.shared.listGen) {
        OB.state.loading = false;
        if (OB.shared.skelNode) OB.shared.skelNode.classList.add("hidden");
        OB.renderEmptyState();
      }
    }
  };

  // ---------- 空状态 / 加载骨架 ----------
  // 列表为空时给出可行动的引导（上传/新目录/清除过滤/重试），
  // 首屏加载时展示 shimmer 骨架，避免“白屏像挂了一样”。
  let emptyNode = null;
  OB.shared.skelNode = null;

  function ensureListExtras() {
    if (!emptyNode) {
      emptyNode = document.createElement("div");
      emptyNode.id = "listEmpty";
      emptyNode.className = "list-empty hidden";
      OB.els.list.appendChild(emptyNode);
      emptyNode.addEventListener("click", (e) => {
        const b = e.target.closest && e.target.closest("[data-eact]");
        if (!b) return;
        const act = b.getAttribute("data-eact");
        if (act === "retry") { OB.shared.lastActAt = Date.now(); OB.doRefresh(); return; }
        if (act === "clear") { OB.shared.lastActAt = Date.now(); OB.clearSearch(); return; }
        if (act === "connect") { OB.shared.lastActAt = Date.now(); OB.openConnDialog(); return; }
        if (act === "upload") { OB.shared.lastActAt = Date.now(); OB.doUpload(); return; }
        if (act === "mkdir") { OB.shared.lastActAt = Date.now(); OB.doMkdir(); return; }
      });
    }
    if (!OB.shared.skelNode) {
      OB.shared.skelNode = document.createElement("div");
      OB.shared.skelNode.id = "listSkel";
      OB.shared.skelNode.className = "list-skel hidden";
      for (let i = 0; i < 6; i++) {
        const bar = document.createElement("div");
        bar.className = "bar";
        OB.shared.skelNode.appendChild(bar);
      }
      OB.els.list.appendChild(OB.shared.skelNode);
    }
  }

  OB.clearSearch = function clearSearch() {
    OB.state.search = "";
    OB.els.searchInput.value = "";
    OB.resetPaging();
    OB.loadPage("");
  };

  OB.renderEmptyState = function renderEmptyState() {
    ensureListExtras();
    if (OB.state.items.length > 0 || !OB.state.connected) { emptyNode.classList.add("hidden"); return; }
    emptyNode.classList.remove("hidden");
    let icon = "cloudUp";
    let title = "";
    let desc = "";
    let actions = "";
    if (OB.state.loadError) {
      icon = "alert";
      title = esc(I18N.t("empty.loadFailTitle"));
      desc = esc(OB.state.loadError);
      actions = `<div class="empty-actions"><button type="button" class="empty-ghost" data-eact="retry">${svg("rotateCcw", 14)}<span>${I18N.t("empty.retry")}</span></button></div>`;
    } else if (OB.state.search) {
      icon = "file";
      title = esc(I18N.t("empty.noMatchTitle"));
      desc = esc(I18N.t("empty.noMatchDesc", { q: OB.state.search }));
      actions = `<div class="empty-actions"><button type="button" class="empty-ghost" data-eact="clear"><span>${I18N.t("empty.clear")}</span></button></div>`;
    } else if (!OB.state.bucket) {
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
  };

  // 行内展示名：去掉当前前缀与末尾斜杠
  OB.displayName = function displayName(it) {
    if (!OB.state.bucket) return it.name.replace(/\/$/, "");
    const n = it.name.startsWith(OB.state.prefix) ? it.name.slice(OB.state.prefix.length) : it.name;
    return n.replace(/\/$/, "");
  };

  OB.renderBreadcrumb = function renderBreadcrumb() {
    let html = "";
    let moreParts = null;
    if (!OB.state.bucket) {
      html = `<span class="crumb root">${I18N.t("breadcrumb.allBuckets")}</span>`;
    } else {
      // 桶名 crumb 显示的就是 oss://桶名/ 这条路径，点击语义应为「回桶根目录」，
      // 而不是跳全桶列表——受限凭证（RAM 仅授权特定桶，无 oss:ListBuckets）下
      // ListBuckets 必然 403，等于每次点桶名都撞一次报错。全桶列表入口保留在
      // 左侧桶图标上（tooltip 为「全部存储桶」）。
      html = `<span class="crumb root" data-allbuckets="" title="${esc(I18N.t("breadcrumb.allBuckets"))}">${svg("bucket", 13)}</span>`
           + `<span class="crumb root" data-bucketroot="">oss://${esc(OB.state.bucket)}/</span>`;
      const parts = OB.state.prefix ? OB.state.prefix.replace(/\/$/, "").split("/").filter(Boolean) : [];
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
    OB.els.breadcrumb.innerHTML = html;
    // 桶名 crumb：回桶根目录（清 prefix，bucket 保持不变）
    OB.els.breadcrumb.querySelectorAll(".crumb[data-bucketroot]").forEach((el) => {
      el.onclick = () => {
        OB.state.prefix = "";
        OB.state.search = "";
        OB.els.searchInput.value = "";
        OB.resetPaging();
        OB.loadPage("");
      };
    });
    // 桶图标：回「全部存储桶」列表（旧版桶名 crumb 的行为）
    OB.els.breadcrumb.querySelectorAll(".crumb[data-allbuckets]").forEach((el) => {
      el.onclick = () => {
        OB.state.bucket = "";
        OB.state.prefix = "";
        OB.state.search = "";
        OB.els.searchInput.value = "";
        OB.resetPaging();
        OB.loadPage("");
      };
    });
    OB.els.breadcrumb.querySelectorAll(".crumb[data-prefix]").forEach((el) => {
      el.onclick = () => OB.navigate(el.getAttribute("data-prefix"));
    });
    const moreEl = OB.els.breadcrumb.querySelector(".crumb.bc-more");
    if (moreEl && moreParts) moreEl.onclick = () => openCrumbMenu(moreEl, moreParts);
  };

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
    OB.shared.ctxMenuEl = m;
    m.addEventListener("click", (e) => {
      const item = e.target.closest && e.target.closest("[data-bc]");
      if (!item) return;
      closeCtxMenu();
      OB.navigate(item.getAttribute("data-bc"));
    });
    m.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  OB.navigate = function navigate(prefix) {
    if (prefix === OB.state.prefix) return;
    OB.state.prefix = prefix;
    OB.state.search = "";
    OB.els.searchInput.value = "";
    OB.resetPaging();
    OB.loadPage("");
  };

  // ---------- 列表排序 ----------
  // 排序作用于「已加载的 items」，不依赖服务端：LoadObjects 只能拿到分页的一页，
  // 服务端排序对分页外的对象无效。因此排序必须在客户端做——
  // 代价是尚未加载的下一页不会被纳入本次排序，但它们加载后会被重排，
  // 语义仍是「当前视图内按此键排序」。
  function sortItems(items) {
    const key = OB.state.sortKey;
    const dir = OB.state.sortDesc ? -1 : 1;
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
        r = OB.displayName(a).localeCompare(OB.displayName(b), undefined, { numeric: true, sensitivity: "base" });
      }
      return r * dir;
    });
  }

  // applySort 排序并重绘。排序发生在分页加载之间，故每次加载后都需调用。
  OB.applySort = function applySort() {
    OB.state.items = sortItems(OB.state.items);
  };

  // cycleSort 点击表头：先切正倒序，同一列再切回升序
  OB.toggleSort = function toggleSort(key) {
    if (OB.state.sortKey === key) {
      OB.state.sortDesc = !OB.state.sortDesc;
    } else {
      OB.state.sortKey = key;
      // 按时间/大小首次点击时直接给倒序（更有用），名称则给升序
      OB.state.sortDesc = key !== "name";
    }
    OB.applySort();
    OB.updateSortIndicators();
    OB.renderList();
  };

  OB.updateSortIndicators = function updateSortIndicators() {
    const map = { name: "colName", size: "colSize", modified: "colTime" };
    for (const key of ["name", "size", "modified"]) {
      const el = OB.els[map[key]];
      if (!el) continue;
      const active = OB.state.sortKey === key;
      el.classList.toggle("sorted", active);
      // 用伪元素显示箭头，避免在 HTML 里塞两个 span
      el.dataset.arrow = active ? (OB.state.sortDesc ? "desc" : "asc") : "";
    }
  };

  // 列表虚拟化：只渲染可视区行，避免上万条 DOM 卡死
  OB.renderList = function renderList() {
    OB.els.listContent.style.height = (OB.state.items.length * OB.shared.ROW_H) + "px";
    // 路径栏计数只表示当前已加载条数；「还有更多」仅由状态栏在真正存在下一页时提示
    OB.els.countLabel.textContent = I18N.t("status.loaded", { n: OB.state.items.length })
      + (OB.partialSort() ? I18N.t("scanAll.partialTag") : "");
    OB.updateScanAllBtn();
    OB.updateBatchUI();
    OB.renderVisible();
  };

  // ---------- 全量扫描排序（1.3，A2） ----------
  // 排序作用于「已加载的 items」（见 sortItems 注释）：点「大小/时间」排序时用户
  // 预期的是全目录排序，而分页视图只给前几页——这是静默错误结果。这里提供显式的
  // 「扫描全部并排序」：用当前分页接口把当前 prefix 的所有页拉完（不递归子目录，
  // 递归是深度搜索的语义），上限 2 万（与深度搜索一致），可取消、有进度。

  // partialSort 当前排序/筛选结果是否可能只是「部分数据」：排序键非名称（名称
  // 排序同样是局部的，但对用户决策影响小，不常驻标注避免噪音）、或过滤生效、
  // 或上次全量扫描触达上限——三者任一且数据确未拉全时，计数旁持续提示。
  OB.partialSort = function partialSort() {
    if (OB.state.scanTruncated) return true;
    if (!OB.state.hasMore) return false;
    return OB.state.sortKey !== "name" || OB.filterActive();
  };

  // updateScanAllBtn 显隐：仅排序键非名称且确实还有未加载页时出现。
  OB.updateScanAllBtn = function updateScanAllBtn() {
    const el = OB.els.scanAllBtn;
    if (!el) return;
    const show = !OB.state.scanAllRunning
      && OB.state.hasMore
      && OB.state.sortKey !== "name"
      && (OB.state.bucket || OB.state.prefix !== "");
    el.classList.toggle("hidden", !show);
  };

  // collectAllSorted 把当前前缀的所有页拉完（上限 2 万）后按当前排序键重排。
  // 复用 Scan.collect 纯逻辑；目录切换（listGen 变化）即取消并静默丢弃。
  OB.collectAllSorted = async function collectAllSorted() {
    if (OB.state.scanAllRunning) return;
    if (!OB.state.bucket && OB.state.prefix === "") return; // 根目录是桶列表，无分页
    OB.state.scanAllRunning = true;
    OB.updateScanAllBtn();
    const gen = OB.shared.listGen;
    OB.setStatus(I18N.t("scanAll.running", { n: 0 }));
    try {
      const res = await Scan.collect({
        // 扫描场景用大页（1000）减少请求数；与 loadPage 的分页大小互不影响
        fetchPage: async (marker) => {
          const r = await OB.invoke("objects/list", {
            bucket: OB.state.bucket,
            prefix: OB.state.prefix + (OB.state.search || ""),
            delimiter: "/",
            marker: marker || "",
            maxKeys: 1000,
          });
          if (gen !== OB.shared.listGen) throw new Error("stale-scan");
          return {
            items: (r.items || []).map((it) => ({
              name: it.name,
              isDir: !!it.is_dir || /\/$/.test(it.name),
              size: it.size || 0,
              mime: it.mime || "",
              modified: it.modified || "",
            })),
            isTruncated: !!r.is_truncated,
            nextMarker: r.next_marker || "",
          };
        },
        limit: 20000,
        onProgress: (n) => OB.setStatus(I18N.t("scanAll.running", { n })),
        isCancelled: () => gen !== OB.shared.listGen,
      });
      if (res.cancelled) return; // 目录已切换：静默丢弃，新目录有自己的加载流程
      // 灌入全量：先经 setItems 更新「未过滤全量快照」（core.js 访问器维护），
      // 再按既有语义写视图（目录不过滤，文件过 filterMatch），最后统一排序渲染
      OB.setItems(res.items.slice());
      OB.shared.allItems = res.items.slice();
      OB.state.items = res.items.filter((it) => it.isDir || OB.filterMatch(it));
      OB.state.isTruncated = res.truncated; // 达上限时后续不再有可靠的续页 marker
      OB.state.nextMarker = "";
      OB.state.hasMore = false;
      OB.state.scanTruncated = res.truncated;
      OB.applySort();
      OB.renderList();
      OB.setStatus(res.truncated
        ? I18N.t("scanAll.doneTruncated", { n: res.items.length })
        : I18N.t("scanAll.done", { n: res.items.length }));
    } catch (e) {
      if (String((e && e.message) || e) !== "stale-scan") {
        OB.setStatus(I18N.t("scanAll.failed", { e: OB.truncateErr ? OB.truncateErr(String((e && e.message) || e)) : String((e && e.message) || e) }), true);
      }
    } finally {
      OB.state.scanAllRunning = false;
      OB.updateScanAllBtn();
    }
  };

  if (OB.els.scanAllBtn) {
    OB.els.scanAllBtn.onclick = () => void OB.collectAllSorted();
  }

  // ---------- F3 多选批量 ----------
  // 复选框是自绘 span（非原生 input）：虚拟化重绘时状态由 state.sel 驱动，
  // 且绕开宿主 webview 对原生控件 change 事件与文档级委托冲突的问题。
  // data-ck 存完整对象 key（比行下标稳：追加翻页/重绘后仍有效）。
  function ckboxHtml(it) {
    // 根目录是桶列表，不支持批量操作；但仍须渲染占位单元格，
    // 否则 5 列网格下该行子元素整体左移一格（名称挤进 34px 窄列被截断）。
    if (!OB.state.bucket) return '<span class="cell-ck"></span>';
    const on = OB.state.sel.has(it.name);
    return `<span class="cell-ck"><span class="ckbox${on ? " on" : ""}" data-ck="${esc(it.name)}" role="checkbox" aria-checked="${on}">${svg("check", 11)}</span></span>`;
  }

  // toggleSel 多选切换。
  //
  // shift 为 true 时做「范围连选」：从上次点击的锚点（state.selAnchor）
  // 连到当前项，中间全部选中——资源管理器式的操作习惯，
  // 选 50 个文件不该点 50 次。
  //
  // 范围按当前列表下标计算（state.items 顺序）。锚点若因翻页/刷新失效
  // （下标越界），退化为单点切换，不误选。
  OB.toggleSel = function toggleSel(name, shift) {
    if (!name || !OB.state.bucket) return;
    const idx = OB.state.items.findIndex((it) => it.name === name);
    if (shift && OB.state.selAnchor >= 0 && idx >= 0 && OB.state.selAnchor !== idx) {
      const a = Math.min(OB.state.selAnchor, idx);
      const b = Math.max(OB.state.selAnchor, idx);
      for (let i = a; i <= b; i++) {
        const it = OB.state.items[i];
        if (it) OB.state.sel.add(it.name);
      }
      OB.state.selAnchor = idx; // 锚点跟到新区间的终点，便于连续扩选
    } else {
      if (OB.state.sel.has(name)) OB.state.sel.delete(name);
      else OB.state.sel.add(name);
      OB.state.selAnchor = idx;
    }
    OB.renderVisible(); // 同步勾选态与行高亮
    OB.updateBatchUI();
  };

  OB.toggleSelectAll = function toggleSelectAll() {
    if (!OB.state.bucket) return;
    const allOn = OB.state.items.length > 0 && OB.state.items.every((it) => OB.state.sel.has(it.name));
    if (allOn) OB.state.sel.clear();
    else OB.state.items.forEach((it) => OB.state.sel.add(it.name));
    OB.state.selAnchor = -1; // 全选后清锚点，避免下一次 Shift 误判
    OB.renderVisible();
    OB.updateBatchUI();
  };

  // 同步批量条显隐 / 计数 / 表头全选框三态（on / half / 空）
  OB.updateBatchUI = function updateBatchUI() {
    if (OB.els.batchBar) {
      const n = OB.state.sel.size;
      OB.els.batchBar.classList.toggle("hidden", n === 0);
      if (OB.els.batchCount) OB.els.batchCount.textContent = I18N.t("batch.count", { n });
    }
    if (OB.els.selAll) {
      OB.els.selAll.classList.toggle("hidden", !OB.state.bucket);
      const total = OB.state.items.length;
      const picked = OB.state.items.filter((it) => OB.state.sel.has(it.name)).length;
      const allOn = total > 0 && picked === total;
      const half = picked > 0 && picked < total;
      OB.els.selAll.classList.toggle("on", allOn);
      OB.els.selAll.classList.toggle("half", half);
      OB.els.selAll.innerHTML = allOn ? svg("check", 11) : (half ? svg("minus", 11) : "");
    }
  };

  OB.doBatchDelete = async function doBatchDelete() {
    if (!OB.guardWritable()) return;
    const sel = Array.from(OB.state.sel);
    if (!sel.length || !OB.state.bucket) return;
    // 目录与文件分开下发：目录项由后端递归删除其下全部对象，
    // 混在一起会让后端无法区分「删一个文件」与「删整个目录」。
    const dirs = [];
    const paths = [];
    for (const name of sel) {
      const it = OB.state.items.find((x) => x.name === name);
      if (it && it.isDir) dirs.push(name);
      else paths.push(name);
    }
    const ok = await OB.openConfirm(
      I18N.t("modal.confirmTitle"),
      I18N.t("batch.deleteTip", { n: sel.length, d: dirs.length })
    );
    if (!ok) return;
    // 分块循环 + 进度卡 + 可取消：文件按 DELETE_CHUNK 一块下发（后端逐条删），
    // 目录单独一次 invoke（内部递归删，进度粒度到目录级）。
    // 取消只在块与块之间生效——不打断单次请求，语义简单且不会留下半删状态。
    const DELETE_CHUNK = 100;
    const total = paths.length + dirs.length;
    OB.openDlCard(I18N.t("batch.deleting", { n: total }), "delete");
    let done = 0, objectsDeleted = 0, cancelled = false;
    const failed = [];
    // 汇总文案：成功数 + 目录内对象数 + 失败数（+ 取消剩余数）
    const summary = () => {
      let text = I18N.t("batch.deleted", { n: done });
      if (objectsDeleted) text += " · " + I18N.t("batch.deletedObjects", { n: objectsDeleted });
      if (failed.length) text += " · " + I18N.t("batch.failed", { n: failed.length }) + " · " + I18N.t("batch.firstErr", { e: OB.truncateErr(failed[0].error) });
      if (cancelled) text += " · " + I18N.t("batch.cancelled", { n: done, r: total - done - failed.length });
      return text;
    };
    try {
      // 1) 文件分块删除
      for (let i = 0; i < paths.length; i += DELETE_CHUNK) {
        if (OB.shared.dl.cancelled) { cancelled = true; break; }
        const chunk = paths.slice(i, i + DELETE_CHUNK);
        $("dlName").textContent = I18N.t("batch.progressFiles", { a: i + 1, b: i + chunk.length, m: total });
        OB.dlProgressItems(done + failed.length, total);
        try {
          const res = await OB.invoke(
            "objects/delete_batch",
            { bucket: OB.state.bucket, paths: chunk, dirs: [] },
            { timeoutMs: 300000 }
          );
          done += (res && res.deleted) || 0;
          objectsDeleted += (res && res.objectsDeleted) || 0;
          if (res && res.failed && res.failed.length) failed.push(...res.failed);
        } catch (e) {
          // 整块失败：逐条记入失败清单，继续后续块
          for (const p of chunk) failed.push({ path: p, error: String((e && e.message) || e) });
        }
        OB.dlProgressItems(done + failed.length, total);
      }
      // 2) 目录逐个递归删除（进度粒度到目录级）
      for (const dirName of dirs) {
        if (OB.shared.dl.cancelled) { cancelled = true; break; }
        $("dlName").textContent = I18N.t("batch.progressDir", { name: OB.displayName({ name: dirName }) });
        OB.dlProgressItems(done + failed.length, total);
        try {
          const res = await OB.invoke(
            "objects/delete_batch",
            { bucket: OB.state.bucket, paths: [], dirs: [dirName] },
            { timeoutMs: 600000 }
          );
          done += (res && res.deleted) || 0;
          objectsDeleted += (res && res.objectsDeleted) || 0;
          if (res && res.failed && res.failed.length) failed.push(...res.failed);
        } catch (e) {
          failed.push({ path: dirName, error: String((e && e.message) || e) });
        }
        OB.dlProgressItems(done + failed.length, total);
      }
      if (!cancelled && OB.shared.dl.cancelled) cancelled = true;
      // 清掉"当前项"行：结束时不再显示「正在删除第 a–b 项」这类过时文案
      $("dlName").textContent = "";
      const text = summary();
      if (failed.length && !cancelled) OB.failDlCard(text);
      else OB.finishDlCard(text, cancelled);
      OB.setStatus(text, !!failed.length);
      // 记入任务中心（B1）：删除只记录不提供重试（重复删除有副作用）
      OB.recordTask({
        type: "delete",
        bucket: OB.state.bucket,
        keys: sel,
        ok: done,
        failed: failed.map((x) => ({ key: x.path, error: x.error })),
        cancelled,
      });
    } catch (e) {
      OB.failDlCard(I18N.t("delete.fail") + (e.message || e));
    }
    // 有实际删除动作才刷新列表；取消在起点时选择集保持原样，用户可直接再操作
    if (done > 0 || failed.length) {
      OB.resetPaging();
      OB.loadPage("");
    }
  };

  // truncateErr 汇总行里的首个错误信息截断，避免一条长错误撑爆进度卡
  OB.truncateErr = function truncateErr(s) {
    s = String(s || "").split("\n")[0].trim();
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  };

  // ---------- 路径书签 / 最近访问（1.3，C4） ----------
  // 深层目录每次从根点进去太痛：书签显式收藏（上限 20），最近访问自动记录（上限 10）。
  // 都存插件 storage（几 KB 量级）；跳转复用 navigate/桶进入语义。
  const BM_KEY = "bookmarks";
  const RECENT_KEY = "recentPaths";
  const BM_MAX = 20;
  const RECENT_MAX = 10;

  function loadPathList(key) {
    const store = window.dbxPlugin && window.dbxPlugin.storage;
    if (!store || typeof store.get !== "function") return Promise.resolve([]);
    return Promise.resolve(store.get(key)).then((v) => (Array.isArray(v) ? v : [])).catch(() => []);
  }
  function savePathList(key, list) {
    const store = window.dbxPlugin && window.dbxPlugin.storage;
    if (!store || typeof store.set !== "function") return Promise.resolve();
    return Promise.resolve(store.set(key, list)).catch(() => { /* 存储不可用时仅本次会话生效 */ });
  }
  function pathLabel(p) {
    return (p.bucket || "") + "/" + (p.prefix || "");
  }

  // rememberRecent 进入新位置后记录最近访问（loadPage 首页成功后调用，fire-and-forget）。
  // 根目录（桶列表视图）不记——那里没有「路径」语义。
  OB.rememberRecent = async function rememberRecent() {
    if (!OB.state.bucket) return;
    const cur = { bucket: OB.state.bucket, prefix: OB.state.prefix, ts: Date.now() };
    const list = await loadPathList(RECENT_KEY);
    const next = [cur].concat(list.filter((p) => !(p.bucket === cur.bucket && p.prefix === cur.prefix))).slice(0, RECENT_MAX);
    await savePathList(RECENT_KEY, next);
  };

  // jumpTo 跳转到书签/最近位置。跨桶仅在当前连接不限桶（根目录可列桶）时放行——
  // 连接绑定了特定桶时，另一个桶大概率不可达，直接提示而不是让用户撞 SDK 报错。
  OB.jumpTo = function jumpTo(p) {
    if (!p) return;
    if (OB.state.bucket && p.bucket && p.bucket !== OB.state.bucket) {
      OB.setStatus(I18N.t("bookmark.crossBucket"), true);
      return;
    }
    if (p.bucket !== OB.state.bucket) OB.state.bucket = p.bucket;
    OB.state.prefix = p.prefix || "";
    OB.state.search = "";
    OB.els.searchInput.value = "";
    OB.resetPaging();
    OB.loadPage("");
  };

  OB.addBookmark = async function addBookmark() {
    if (!OB.state.bucket) { OB.setStatus(I18N.t("bookmark.needBucket"), true); return; }
    const cur = { bucket: OB.state.bucket, prefix: OB.state.prefix, ts: Date.now() };
    const list = await loadPathList(BM_KEY);
    if (list.some((p) => p.bucket === cur.bucket && p.prefix === cur.prefix)) {
      OB.setStatus(I18N.t("bookmark.exists"));
      return;
    }
    await savePathList(BM_KEY, [cur].concat(list).slice(0, BM_MAX));
    OB.setStatus(I18N.t("bookmark.added"));
  };

  async function removeBookmark(p) {
    const list = await loadPathList(BM_KEY);
    await savePathList(BM_KEY, list.filter((x) => !(x.bucket === p.bucket && x.prefix === p.prefix)));
    OB.setStatus(I18N.t("bookmark.removed"));
  }

  // openBookmarkMenu 书签/最近访问下拉（复用 .ctx-menu 样式与 closeCtxMenu 关闭逻辑）。
  // 书签项右键 = 删除该条；「添加书签」收集当前 bucket+prefix。
  OB.openBookmarkMenu = async function openBookmarkMenu(anchor) {
    closeCtxMenu();
    const results = await Promise.all([loadPathList(BM_KEY), loadPathList(RECENT_KEY)]);
    const bms = results[0];
    const recents = results[1];
    const m = document.createElement("div");
    m.id = "ctxMenu";
    m.className = "ctx-menu";
    const item = (p, icon, kind) => {
      const label = esc(pathLabel(p));
      return `<div class="ctx-item" data-bm-jump="1" data-bm-kind="${kind}" data-bucket="${esc(p.bucket)}" data-prefix="${esc(p.prefix)}" title="${label}">${ICONS.svg(icon, 14)}<span>${label}</span></div>`;
    };
    let html = "";
    if (bms.length) {
      html += `<div class="bm-group">${esc(I18N.t("bookmark.group"))}</div>`;
      for (const p of bms) html += item(p, "star", "bm");
    }
    if (recents.length) {
      html += `<div class="bm-group">${esc(I18N.t("bookmark.recentGroup"))}</div>`;
      for (const p of recents) html += item(p, "clock", "recent");
    }
    if (!bms.length && !recents.length) {
      html += `<div class="bm-empty">${esc(I18N.t("bookmark.empty"))}</div>`;
    }
    html += '<div class="ctx-sep"></div>';
    html += `<div class="ctx-item" data-bm-add="1">${ICONS.svg("star", 14)}<span>${esc(I18N.t("bookmark.add"))}</span></div>`;
    m.innerHTML = html;
    document.body.appendChild(m);
    // 弹出后按实际尺寸钳位到视口内（与 openCtxMenu 同策略），贴着锚点按钮下沿展开
    const r = m.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - r.width - 8)) + "px";
    m.style.top = Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - r.height - 8)) + "px";
    OB.shared.ctxMenuEl = m;
    m.addEventListener("click", (e) => {
      const jump = e.target.closest("[data-bm-jump]");
      if (jump) {
        closeCtxMenu();
        OB.jumpTo({ bucket: jump.getAttribute("data-bucket"), prefix: jump.getAttribute("data-prefix") });
        return;
      }
      if (e.target.closest("[data-bm-add]")) {
        closeCtxMenu();
        void OB.addBookmark();
      }
    });
    // 书签右键删除（最近访问不提供删除——滚动自然淘汰）
    m.addEventListener("contextmenu", (e) => {
      const jump = e.target.closest('[data-bm-jump][data-bm-kind="bm"]');
      if (!jump) return;
      e.preventDefault();
      closeCtxMenu();
      void removeBookmark({ bucket: jump.getAttribute("data-bucket"), prefix: jump.getAttribute("data-prefix") });
    });
  };

  const bookmarkBtn = $("bookmarkBtn");
  if (bookmarkBtn) {
    bookmarkBtn.onclick = () => {
      if (OB.shared.ctxMenuEl) { closeCtxMenu(); return; } // 再点一次关闭
      void OB.openBookmarkMenu(bookmarkBtn);
    };
  }

  // ---------- 文件类型图标 ----------
  // svg() 与图标表见 icons.js。
  const IMG_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff"];
  const CODE_EXT = ["json", "xml", "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "go", "py", "java", "c", "h", "cpp", "hpp", "cs", "css", "scss", "yml", "yaml", "sh", "bat", "ps1", "sql", "toml", "ini", "proto"];
  const TEXT_EXT = ["txt", "md", "csv", "tsv", "log", "rst"];

  // itemIcon 返回 {cls, icon}：桶/目录/按扩展名分型的文件图标
  function itemIcon(it) {
    if (it.isDir) {
      if (!OB.state.bucket) return { cls: "ico-bucket", icon: "bucket" }; // 根目录的"目录"是存储桶
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
    if (!it.isDir && OB.previewKind(it.name)) out += opBtn("preview", "eye", "op.preview");
    return out + opBtn("ctxmenu", "ellipsis", "op.more");
  }

  // 动作表：右键菜单与行内「更多」按钮共用；诸 act 走 actOnRow 现有分派。
  //
  // 只读连接（state.readOnly）下剔除全部写动作（改名/删除/新建），
  // 只保留浏览类（打开/预览/下载/复制地址）。真正的边界在后端
  // requireWritable 守卫，这里只是不把用户引到注定失败的路径上。
  function ctxActions(it) {
    const acts = [];
    const canWrite = !OB.state.readOnly;
    if (it.isDir) {
      acts.push(["open", "folderOpen", "op.open"]);
      acts.push(["detail", "info", "op.detail"]);
      if (OB.state.bucket) { // 根目录下的项是存储桶，不允许删除/重命名
        if (canWrite) {
          acts.push(["rename", "pencil", "op.rename"]);
          acts.push(["-", "", ""]);
          acts.push(["delete", "trash", "op.delete", true]);
        }
      }
    } else {
      if (OB.previewKind(it.name)) acts.push(["preview", "eye", "op.preview"]);
      acts.push(["download", "download", "op.download"]);
      acts.push(["addr", "link", "op.addr"]);
      // 公开动作标题随状态变化：已知公开 → 「取消公开」；否则「公开链接」。
      acts.push(["public", "globe", it.public ? "op.cancelPublic" : "op.public"]);
      acts.push(["name", "copy", "op.name"]);
      acts.push(["detail", "info", "op.detail"]);
      if (canWrite) {
        acts.push(["meta", "sliders", "op.meta"]);
        acts.push(["rename", "pencil", "op.rename"]);
        acts.push(["-", "", ""]);
        acts.push(["delete", "trash", "op.delete", true]);
      }
    }
    return acts;
  }

  OB.shared.ctxMenuEl = null;
  function closeCtxMenu() {
    if (OB.shared.ctxMenuEl) { OB.shared.ctxMenuEl.remove(); OB.shared.ctxMenuEl = null; }
  }

  async function copyName(it) {
    try {
      await OB.writeClipboard(OB.displayName(it));
      OB.setStatus(I18N.t("preview.copied"));
    } catch (e) {
      OB.setStatus(I18N.t("modal.copyFail"));
    }
  }

  OB.openCtxMenu = function openCtxMenu(x, y, it) {
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
    OB.shared.ctxMenuEl = m;
    m.addEventListener("click", (e) => {
      const item = e.target.closest && e.target.closest("[data-cact]");
      if (!item) return;
      const act = item.getAttribute("data-cact");
      closeCtxMenu();
      if (act === "name") { OB.shared.lastActAt = Date.now(); copyName(it); return; }
      const idx = OB.state.items.indexOf(it);
      OB.actOnRow(idx < 0 ? OB.state.selectedIndex : idx, it, act);
    });
    m.addEventListener("contextmenu", (e) => e.preventDefault());
  };

  // 右键：列表区域内拦截浏览器默认菜单，弹出动作菜单（宿主 webview 下尤其需要）；
  // 其余空白处也一并拦截（默认的「刷新/另存为/打印」菜单在 webview 插件里只会造成困惑，
  // 刷新/重连等功能工具栏都有），仅输入框/可编辑区放行，保留原生复制粘贴菜单。
  document.addEventListener("contextmenu", (e) => {
    if (OB.inFloatingLayer(e.target)) return;
    const el = e.target;
    const editable = el && el.closest && el.closest("input, textarea, select, [contenteditable]");
    if (editable) return; // 输入区保留浏览器原生的复制/粘贴菜单
    const idx = OB.rowIndexAt(e.clientX, e.clientY);
    e.preventDefault(); // 未命中行（列表空白/工具栏/状态栏）只拦截默认菜单
    if (idx < 0) return;
    const it = OB.state.items[idx];
    if (!it) return;
    OB.shared.lastActAt = Date.now();
    OB.actOnRow(idx, it, "ctxmenu", e);
  }, true);

  // 点击菜单外任意处 / Escape 关闭
  document.addEventListener("pointerdown", (e) => {
    if (OB.shared.ctxMenuEl && !(e.target.closest && e.target.closest("#ctxMenu"))) closeCtxMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCtxMenu();
  });

  // ---------- 键盘快捷键（文件管理器惯例） ----------
  // 输入框 / 弹窗 / 未连接时不响应，避免抢输入与破坏原生编辑行为。
  function shortcutGuard() {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return false;
    if (OB.inFloatingLayer(el)) return false;
    for (const id of ["connectOverlay", "modal", "copyModal", "previewOverlay", "dirTreeModal", "renameModal", "metaModal", "filterModal", "tasksOverlay"]) {
      const n = $(id);
      if (n && !n.classList.contains("hidden")) return false;
    }
    const bv = $("browserView");
    return !!(bv && !bv.classList.contains("hidden"));
  }
  // moveFocus 键盘移动高亮行（↑/↓）。extend 为 true 时（Shift+方向键）
  // 同时把锚点到新位置的区间加入勾选集——资源管理器式的连选。
  // 移动后滚动保证当前行可见（虚拟列表按 scrollTop 渲染）。
  function moveFocus(delta, extend) {
    const n = OB.state.items.length;
    if (!n) return;
    let idx = OB.state.selectedIndex;
    idx = idx < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, idx + delta));
    if (idx === OB.state.selectedIndex && !extend) return;
    if (extend) {
      const anchor = OB.state.selAnchor >= 0 ? OB.state.selAnchor : idx;
      const a = Math.min(anchor, idx);
      const b = Math.max(anchor, idx);
      for (let i = a; i <= b; i++) {
        const x = OB.state.items[i];
        if (x) OB.state.sel.add(x.name);
      }
      OB.state.selAnchor = idx;
      OB.updateBatchUI();
    }
    OB.state.selectedIndex = idx;
    const top = idx * OB.shared.ROW_H;
    const list = OB.els.list;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + OB.shared.ROW_H > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + OB.shared.ROW_H - list.clientHeight;
    }
    OB.renderVisible();
  }
  document.addEventListener("keydown", (e) => {
    if (!shortcutGuard()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      OB.toggleSelectAll();
      return;
    }
    // 搜索聚焦：Ctrl+F 或 `/`（文件管理器惯例），聚焦并全选便于覆盖输入
    if ((ctrl && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) || e.key === "/") {
      e.preventDefault();
      OB.els.searchInput.focus();
      OB.els.searchInput.select();
      return;
    }
    // 剪贴板：Ctrl+C/X 复制/剪切当前勾选（无勾选取高亮行），Ctrl+V 粘贴到当前目录
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X")) {
      e.preventDefault();
      OB.clipSelected(e.key === "x" || e.key === "X");
      return;
    }
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      OB.doPaste();
      return;
    }
    if (ctrl || e.altKey || e.metaKey) return;
    const it = OB.state.items[OB.state.selectedIndex];
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        moveFocus(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
        return;
      case " ":
        // 空格快速预览：目录进入，文件走预览（不支持的格式无动作）
        if (!it) return;
        e.preventDefault();
        if (it.isDir) OB.enterDir(it);
        else if (OB.previewKind(it.name)) OB.openPreview(it);
        return;
      case "Enter":
        if (!it) return;
        e.preventDefault();
        if (it.isDir) OB.enterDir(it);
        else if (OB.previewKind(it.name)) OB.openPreview(it);
        else OB.doDownload(it);
        return;
      case "Backspace":
        e.preventDefault();
        OB.doUp();
        return;
      case "Delete":
        if (!OB.state.bucket) return; // 根目录的项是存储桶，不允许删除
        e.preventDefault();
        if (OB.state.sel.size) OB.doBatchDelete(); // 多选批量删除
        else if (it) OB.doDelete(it);
        return;
      case "F2":
        if (!it || !OB.state.bucket) return;
        e.preventDefault();
        OB.doRename(it);
        return;
    }
  });

  OB.renderVisible = function renderVisible() {
    const scrollTop = OB.els.list.scrollTop;
    const h = OB.els.list.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / OB.shared.ROW_H) - 5);
    const end = Math.min(OB.state.items.length, Math.ceil((scrollTop + h) / OB.shared.ROW_H) + 5);
    let html = "";
    for (let i = start; i < end; i++) {
      const it = OB.state.items[i];
      const selected = i === OB.state.selectedIndex ? " selected" : "";
      const checked = OB.state.sel.has(it.name) ? " checked" : "";
      const ic = itemIcon(it);
      // 公共读徽标：仅对已确认为公共读的对象（it.public 为 true）显示。
      // it.public 既来自用户本地的开关操作（即时），也来自「公开状态」扫描
      // （objects/get_acl_batch）。目录无 ACL，不显示。
      const pubBadge = (!it.isDir && it.public) ? `<span class="pub-badge" title="${esc(I18N.t("op.publicBadge"))}">${svg("globe", 12)}<span>${esc(I18N.t("op.publicBadge"))}</span></span>` : "";
      html += `<div class="row${selected}${checked}" data-i="${i}" style="position:absolute;top:${i * OB.shared.ROW_H}px;height:${OB.shared.ROW_H}px;left:0;right:0;">` +
        ckboxHtml(it) +
        `<span class="cell-name"><span class="ico ${ic.cls}">${svg(ic.icon, 16)}</span><span class="nm ${it.isDir ? "is-dir" : ""}">${esc(OB.displayName(it))}</span>${pubBadge}</span>` +
        `<span class="sz">${it.isDir ? I18N.t("row.dir") : formatSize(it.size)}</span>` +
        `<span class="tm">${esc(fmtTime(it.modified))}</span>` +
        `<span class="fast">${rowOps(it)}</span>` +
        `</div>`;
    }
    OB.els.listContent.innerHTML = html;

    if (OB.state.hasMore && !OB.state.loading) {
      const bottom = scrollTop + h;
      const full = OB.state.items.length * OB.shared.ROW_H;
      if (full - bottom < OB.shared.ROW_H * 20) OB.loadPage(OB.state.nextMarker);
    }
  };

  OB.els.list.addEventListener("scroll", OB.renderVisible);

  OB.openDir = function openDir(it) {
    if (!OB.state.bucket) {
      // 根目录下的"目录"是存储桶
      OB.state.bucket = it.name.replace(/\/$/, "");
      OB.state.prefix = "";
      OB.state.search = "";
      OB.els.searchInput.value = "";
      OB.resetPaging();
      OB.loadPage("");
    } else {
      OB.navigate(it.name.endsWith("/") ? it.name : it.name + "/");
    }
  };

  // ---------- 列宽拖拽（大小 / 时间列；名称列 1fr 自动伸缩） ----------
  // 宽度记录在 --col-*-w 变量上（表头与行共用同一网格模板），拖完经插件存储记忆。
  let colW = { size: 150, time: 180 };

  OB.applyColWidths = function applyColWidths() {
    const bv = OB.els.browserView;
    if (!bv) return;
    bv.style.setProperty("--col-size-w", colW.size + "px");
    bv.style.setProperty("--col-time-w", colW.time + "px");
    layoutColResizers();
  };

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
        OB.applyColWidths();
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
        OB.applyColWidths();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        handle.classList.remove("dragging");
        if (moved) persistColWidths();
        OB.shared.lastActAt = Date.now(); // 抬起产生的 click 不能落进相邻表头的排序分派
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


})(window.OB);
