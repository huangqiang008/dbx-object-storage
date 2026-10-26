// conn.js — 连接管理模块。
//
// 连接对话框、已保存连接、存储类型切换、只读守卫、连接配置持久化。
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

  // ---------- 存储类型切换（aliyun / s3） ----------
  // s3 专属行（Region / PathStyle）显隐 + 接入点帮助文案/placeholder 联动。
  OB.updateProviderUI = function updateProviderUI() {
    const isS3 = OB.els.fProvider.value === "s3";
    OB.els.rowRegion.classList.toggle("hidden", !isS3);
    OB.els.rowPathStyle.classList.toggle("hidden", !isS3);
    const key = isS3 ? "endpoint.help.s3" : "endpoint.help.aliyun";
    if (OB.els.endpointHelp) OB.els.endpointHelp.textContent = I18N.t(key);
    OB.els.fEndpoint.placeholder = isS3 ? "http://192.168.1.10:9000" : "oss-cn-hangzhou.aliyuncs.com";
  };
  OB.resetPaging = function resetPaging() {
    OB.setItems([]); // 视图与全量快照一并清空（快照见 core.js OB.setItems）
    OB.state.nextMarker = "";
    OB.state.isTruncated = false;
    OB.state.hasMore = false;
    OB.state.selectedIndex = -1;
    OB.state.sel.clear();
    OB.state.selAnchor = -1; // 换目录后锚点下标失效，清掉避免 Shift 误选
    // 进入新目录/新搜索：此前已扫描的 ACL 属于别的目录，作废以便重新扫描
    OB.state.aclKnown.clear();
    // 作废在途请求：调用方紧接着会 loadPage，不作废的话旧响应会写进新列表
    OB.invalidateList();
    OB.updateBatchUI();
  };

    // ---------- 「在本机记住 Secret」勾选 ----------
  // 复用列表用的 .ckbox 自绘样式（沙箱 webview 对原生 checkbox 的 change 事件
  // 与文档级委托存在冲突，历史代码已统一避开原生控件）。
  OB.renderRememberCk = function renderRememberCk() {
    const el = OB.els.fRememberCk;
    if (!el) return;
    el.classList.toggle("on", OB.state.rememberSk);
    el.setAttribute("aria-checked", OB.state.rememberSk ? "true" : "false");
    // 图标仅在选中时可见（与列表勾选框行为一致）
    el.innerHTML = svg("check", 11);
  };

  function toggleRememberSk() {
    OB.state.rememberSk = !OB.state.rememberSk;
    OB.renderRememberCk();
  }

  // ---------- 只读守卫 ----------
  // 所有写操作的统一入口检查。UI 上写按钮已隐藏，但键盘快捷键（Delete / F2）、
  // 右键菜单等路径仍可能触发，不能只靠「藏按钮」当权限控制。
  // 后端 requireWritable 是最终边界，这里只负责给出可理解的提示。
  OB.guardWritable = function guardWritable() {
    if (!OB.state.readOnly) return true;
    OB.setStatus(I18N.t("ro.blocked"), true);
    return false;
  };

  // ---------- 「只读模式」勾选 ----------
  // 与「记住 Secret」同样复用自绘 .ckbox（沙箱 webview 避开原生 checkbox）。
  OB.renderReadOnlyCk = function renderReadOnlyCk() {
    const el = OB.els.fReadOnly;
    if (!el) return;
    el.classList.toggle("on", OB.state.readOnly);
    el.setAttribute("aria-checked", OB.state.readOnly ? "true" : "false");
    el.innerHTML = svg("check", 11);
  };

  function toggleReadOnly() {
    OB.state.readOnly = !OB.state.readOnly;
    OB.renderReadOnlyCk();
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
  OB.loadMeta = async function loadMeta() {
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (store && typeof store.get === "function") {
        return await store.get("conn");
      }
    } catch (e) { /* ignore */ }
    return null;
  };

  // ---------- 新建连接对话框 ----------
  OB.buildSwatches = function buildSwatches() {
    OB.els.swatches.innerHTML = "";
    OB.COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (c === OB.selectedColor ? " active" : "");
      b.style.background = c;
      b.onclick = () => { OB.selectedColor = c; buildSwatches(); };
      OB.els.swatches.appendChild(b);
    });
  };

  function currentCfg() {
    return {
      provider: OB.els.fProvider.value === "s3" ? "s3" : "aliyun",
      endpoint: OB.els.fEndpoint.value.trim(),
      accessKeyId: OB.els.fAk.value.trim(),
      accessKeySecret: OB.els.fSk.value,
      // STS 临时凭证令牌（2.4）。留空 = 长期密钥（行为与之前一致）。
      // 临时凭证与长期 AK 成对使用：填了 token 就必须同时有临时 AK/SK。
      sessionToken: OB.els.fStsToken ? OB.els.fStsToken.value.trim() : "",
      bucket: OB.els.fBucket.value.trim(),
      region: OB.els.fRegion ? OB.els.fRegion.value.trim() : "",
      pathStyle: !!(OB.els.fPathStyle && OB.els.fPathStyle.checked),
      // 只读模式：勾选后本连接的所有写操作（上传/新建/改名/删除）被拒绝。
      // 宿主托管的连接由宿主侧 connection.read_only 决定，此处仅对
      // 插件自带表单有效；后端 requireWritable 是最终边界。
      readOnly: !!(OB.els.fReadOnly && OB.els.fReadOnly.checked),
      // TLS：自定义 CA（优先）/ 跳过校验（逃生通道）。仅自签/内网端点使用。
      // 后端 buildTransport 据此构造传输层；caCert 优先于 skipVerifyTls。
      skipVerifyTls: !!(OB.els.fTlsSkip && OB.els.fTlsSkip.checked),
      caCert: OB.els.fCaCert ? OB.els.fCaCert.value.trim() : "",
    };
  }

  OB.doConnect = async function doConnect() {
    const cfg = currentCfg();
    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.accessKeySecret) {
      OB.msg(I18N.t("conn.fillRequired"), true);
      return;
    }
    OB.msg(I18N.t("conn.connecting"));
    try {
      await OB.invoke("connection/connect", cfg);
    } catch (e) {
      OB.msg(I18N.t("conn.connectFail") + (e.message || e), true);
      return;
    }
    OB.state.connected = true;
    OB.state.provider = cfg.provider;
    OB.state.endpoint = cfg.endpoint;
    OB.state.bucket = cfg.bucket;
    OB.state.prefix = "";
    OB.state.search = "";
    OB.state.readOnly = !!cfg.readOnly;
    OB.els.searchInput.value = "";
    // 分页大小：以对话框输入为准（10–1000），空/非法值保持原设置
    if (OB.els.fPageSize) {
      const ps = parseInt(OB.els.fPageSize.value, 10);
      if (!isNaN(ps)) OB.state.pageSize = Math.min(1000, Math.max(10, ps));
    }
    OB.state.pageSize = Math.min(1000, Math.max(10, OB.state.pageSize || 200));
    await saveMeta({
      name: OB.els.fName.value.trim() || "Storage",
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      accessKeyId: cfg.accessKeyId,
      // Secret 仅在用户显式勾选「在本机记住」时才落盘（明文，仅本插件可读）。
      // 未勾选时写入空串而非省略字段：省得下次读到残留的旧 secret 造成误判。
      accessKeySecret: OB.state.rememberSk ? cfg.accessKeySecret : "",
      region: cfg.region,
      pathStyle: cfg.pathStyle,
      color: OB.selectedColor,
      pageSize: OB.state.pageSize,
      rememberSk: OB.state.rememberSk,
    });
    OB.updateEndpointLabel();
    OB.enterBrowser();
  };

  OB.enterBrowser = function enterBrowser() {
    OB.els.overlay.classList.add("hidden");
    OB.els.browserView.classList.remove("hidden");
    applyReadOnlyUI();
    OB.applyColWidths(); // 显示后才能拿到真实表头宽度，据此放置拖拽手柄
    // 同步「公开状态」开关的视觉态（跨连接保持会话内的开关状态）
    const pb = $("pubAclBtn");
    if (pb) pb.classList.toggle("on", !!OB.state.showPublicAcl);
    // 首次进入或从连接对话框返回：作废可能在途的旧请求
    OB.invalidateList();
    OB.renderBreadcrumb();
    OB.loadPage("");
  };

  // applyReadOnlyUI 按只读状态显隐全部写入口。
  //
  // 这是体验层的第一道防线：只读连接下用户不该看到上传/新建/改名/删除。
  // 真正的边界在后端 handler 的 requireWritable（任何绕过 UI 的调用都会被拒）。
  // 两层都要有——只有 UI 限制等于没有限制，只有后端限制则体验割裂。
  function applyReadOnlyUI() {
    const ro = !!OB.state.readOnly;
    // 工具栏写按钮
    if (OB.els.mkdirBtn) OB.els.mkdirBtn.classList.toggle("hidden", ro);
    if (OB.els.uploadBtn) OB.els.uploadBtn.classList.toggle("hidden", ro);
    if (OB.els.uploadDirBtn) OB.els.uploadDirBtn.classList.toggle("hidden", ro);
    // 端点标签（含只读标记）由 updateEndpointLabel 统一渲染
    OB.updateEndpointLabel();
    // 批量条：只读时只剩「取消选择」，写操作按钮需隐藏
    const delBtn = $("batchDeleteBtn");
    if (delBtn) delBtn.classList.toggle("hidden", ro);
    const mvBtn = $("batchMoveBtn");
    if (mvBtn) mvBtn.classList.toggle("hidden", ro);
    const cpBtn = $("batchCopyBtn");
    if (cpBtn) cpBtn.classList.toggle("hidden", ro);
    const rnBtn = $("batchRenameBtn");
    if (rnBtn) rnBtn.classList.toggle("hidden", ro);
    // 存储类别下拉只影响上传，只读模式下无意义
    if (OB.els.storageClassSel) OB.els.storageClassSel.classList.toggle("hidden", ro);
    // 已选中的项在只读模式下无意义（没有可执行的批量写操作），清空避免困惑
    if (ro && OB.state.sel.size > 0) {
      OB.state.sel.clear();
      OB.updateBatchUI();
    }
    // 列表右键菜单需要重绘才能反映动作表变化
    OB.renderVisible();
  }

  OB.els.testBtn.onclick = async () => {
    const cfg = currentCfg();
    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.accessKeySecret) {
      OB.msg(I18N.t("conn.testFill"), true);
      return;
    }
    OB.msg(I18N.t("conn.testing"));
    try {
      await OB.invoke("connection/test", cfg);
      OB.msg(I18N.t("conn.testOk"));
    } catch (e) {
      OB.msg(I18N.t("conn.testFail") + (e.message || e), true);
    }
  };
  // 「公开状态」开关：开启后扫描当前目录并标出公共读对象（见 refreshAcl）。
  // 关闭则停止扫描；用户手动切换的公开/私有徽标仍会保留。
  const pubAclBtn = $("pubAclBtn");
  if (pubAclBtn) {
    pubAclBtn.onclick = () => {
      OB.state.showPublicAcl = !OB.state.showPublicAcl;
      pubAclBtn.classList.toggle("on", OB.state.showPublicAcl);
      if (OB.state.showPublicAcl) {
        // 重新扫描：清空已知集合以便把已加载对象重新纳入扫描
        OB.state.aclKnown.clear();
        OB.refreshAcl();
        OB.setStatus(I18N.t("public.scanOn"));
      } else {
        OB.setStatus(I18N.t("public.scanOff"));
      }
    };
  }
  OB.els.saveBtn.onclick = OB.doConnect;
  OB.els.fProvider.addEventListener("change", OB.updateProviderUI);

  // ---------- 已保存连接 ----------
  // 以「名称」输入框的值为键，把当前表单配置存进插件存储（明文本机，与
  // 「记住 Secret」同一信任级别）。Secret 仅在勾选「记住 Secret」时一并保存，
  // 否则回填后需手动补输——默认不落盘的安全语义不被绕过。
  const SAVED_CONN_KEY = "savedConns";
  async function loadSavedConns() {
    try {
      const store = window.dbxPlugin && window.dbxPlugin.storage;
      if (!store || typeof store.get !== "function") return [];
      const arr = await store.get(SAVED_CONN_KEY);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  async function persistSavedConns(list) {
    const store = window.dbxPlugin && window.dbxPlugin.storage;
    if (!store || typeof store.set !== "function") return;
    await store.set(SAVED_CONN_KEY, list);
  }
  async function renderSavedConnSel() {
    if (!OB.els.savedConnSel) return;
    const list = await loadSavedConns();
    const cur = OB.els.savedConnSel.value;
    OB.els.savedConnSel.innerHTML =
      `<option value="">${I18N.t("conn.savedNone")}</option>` +
      list.map((c) =>
        `<option value="${esc(c.name)}">${esc(c.name)}${c.hasSecret ? "" : " " + I18N.t("conn.noSecret")}</option>`
      ).join("");
    if (cur && list.some((c) => c.name === cur)) OB.els.savedConnSel.value = cur;
  }
  async function onSaveConn() {
    const cfg = currentCfg();
    const name = (OB.els.fName.value || "").trim();
    if (!name) { OB.msg(I18N.t("conn.nameRequired"), true); return; }
    if (!cfg.endpoint || !cfg.accessKeyId) { OB.msg(I18N.t("conn.fillRequired"), true); return; }
    const hasSecret = !!OB.state.rememberSk && !!cfg.accessKeySecret;
    const entry = {
      name,
      // STS Token 与 Secret 同属凭据：只在勾选「记住 Secret」时才落盘，
      // 否则回填后需重输（与 Secret 的安全语义一致）。
      cfg: {
        ...cfg,
        accessKeySecret: hasSecret ? cfg.accessKeySecret : "",
        sessionToken: hasSecret ? (cfg.sessionToken || "") : "",
      },
      hasSecret,
    };
    const list = await loadSavedConns();
    const idx = list.findIndex((c) => c.name === name);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    await persistSavedConns(list);
    await renderSavedConnSel();
    OB.els.savedConnSel.value = name;
    OB.msg(I18N.t("conn.savedOk") + name);
  }
  async function onDeleteConn() {
    const name = OB.els.savedConnSel.value;
    if (!name) return;
    const list = (await loadSavedConns()).filter((c) => c.name !== name);
    await persistSavedConns(list);
    await renderSavedConnSel();
    OB.msg(I18N.t("conn.deleted") + name);
  }
  async function onPickConn() {
    const name = OB.els.savedConnSel.value;
    if (!name) return;
    const list = await loadSavedConns();
    const c = list.find((x) => x.name === name);
    if (!c || !c.cfg) return;
    const cfg = c.cfg;
    OB.els.fName.value = c.name;
    OB.els.fProvider.value = cfg.provider === "s3" ? "s3" : "aliyun";
    OB.els.fEndpoint.value = cfg.endpoint || "";
    OB.els.fAk.value = cfg.accessKeyId || "";
    OB.els.fSk.value = cfg.accessKeySecret || "";
    if (OB.els.fStsToken) OB.els.fStsToken.value = cfg.sessionToken || "";
    OB.els.fBucket.value = cfg.bucket || "";
    if (OB.els.fRegion) OB.els.fRegion.value = cfg.region || "";
    if (OB.els.fPathStyle) OB.els.fPathStyle.checked = !!cfg.pathStyle;
    if (OB.els.fReadOnly) OB.els.fReadOnly.checked = !!cfg.readOnly;
    if (OB.els.fTlsSkip) OB.els.fTlsSkip.checked = !!cfg.skipVerifyTls;
    if (OB.els.fCaCert) OB.els.fCaCert.value = cfg.caCert || "";
    OB.updateProviderUI();
    OB.msg(c.hasSecret ? I18N.t("conn.loaded") : I18N.t("conn.loadedNoSecret"));
  }
  if (OB.els.connSaveBtn) OB.els.connSaveBtn.onclick = onSaveConn;
  if (OB.els.connDelBtn) OB.els.connDelBtn.onclick = onDeleteConn;
  if (OB.els.savedConnSel) OB.els.savedConnSel.addEventListener("change", onPickConn);
  renderSavedConnSel();

  // 「记住 Secret」勾选：点击整行（含文字）都生效，键盘 Space/Enter 亦可。
  // 绑定在 label 上，整行可点；ckbox 自身是 span，事件冒泡到 label 统一处理。
  if (OB.els.fRememberCk) {
    const rememberLabel = OB.els.fRememberCk.closest(".remember-line");
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
  if (OB.els.fReadOnly) {
    const roLabel = OB.els.fReadOnly.closest(".remember-line");
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
    OB.els.overlay.classList.add("hidden");
    OB.els.browserView.classList.remove("hidden");
    if (!OB.state.connected) {
      OB.els.breadcrumb.innerHTML = `<span class="crumb root">${I18N.t("breadcrumb.notConnected")}</span>`;
      OB.setStatus(I18N.t("status.notConnected"));
    }
  }
  OB.els.closeDialogBtn.onclick = closeDialog;
  // 点击遮罩空白处关闭；Esc 关闭
  OB.els.overlay.addEventListener("mousedown", (e) => {
    if (e.target === OB.els.overlay) closeDialog();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !OB.els.overlay.classList.contains("hidden")) closeDialog();
  });
  // Secret 明文切换：默认 password，点击 eye 在明/暗之间互换
  $("skEye").onclick = () => {
    const show = OB.els.fSk.type === "password";
    OB.els.fSk.type = show ? "text" : "password";
    $("skEye").innerHTML = svg(show ? "eyeOff" : "eye", 15);
    $("skEye").title = I18N.t("sk.eye");
  };
  OB.openConnDialog = function openConnDialog() {
    OB.msg("");
    OB.els.overlay.classList.remove("hidden");
    // 打开即聚焦名称并全选：中途改参/新建都是最高频的下一步
    setTimeout(() => { try { OB.els.fName.focus(); OB.els.fName.select(); } catch (e) { /* 忽略 */ } }, 30);
  };


})(window.OB);
