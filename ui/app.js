// app.js — 入口模块。
//
// 启动流程与全局事件委托——唯一知道全部模块的地方。
//
// 本文件是 core.js 之后的经典 script 模块：所有对外能力挂在 OB 上，
// 跨模块调用统一走 OB.xxx。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用（模块图加载走 CORS，null origin 无法通过），
// 故必须保持经典 script + 全局命名空间。

(function (OB) {
  "use strict";

  // ---------- 启动 ----------
  OB.boot = async function boot() {
    await window.dbxPlugin.ready;
    // 宿主 init 后语言才准确：先按宿主注入的 locale 刷新一次，再渲染界面文案。
    I18N.refresh(true);
    OB.buildSwatches();

    const meta = await OB.loadMeta();
    if (meta) {
      OB.els.fName.value = meta.name || "Storage";
      OB.els.fProvider.value = meta.provider === "s3" ? "s3" : "aliyun";
      OB.els.fEndpoint.value = meta.endpoint || "";
      OB.els.fBucket.value = meta.bucket || "";
      OB.els.fAk.value = meta.accessKeyId || "";
      // 回填记住的 Secret：仅当上次确实勾选过且存有值时才填。
      // 没有勾选或没存值时留空，由用户重输（宿主托管场景走下方 context 分支）。
      const savedSk = meta.rememberSk ? (meta.accessKeySecret || "") : "";
      OB.state.rememberSk = !!savedSk;
      OB.els.fSk.value = savedSk;
      if (OB.els.fRegion) OB.els.fRegion.value = meta.region || "";
      if (OB.els.fPathStyle) OB.els.fPathStyle.checked = !!meta.pathStyle;
      if (meta.color) { OB.selectedColor = meta.color; OB.buildSwatches(); }
      if (meta.pageSize) OB.state.pageSize = meta.pageSize;
      if (OB.els.fPageSize) OB.els.fPageSize.value = OB.state.pageSize;
      OB.updateProviderUI();
    }
    OB.renderRememberCk();
    OB.renderReadOnlyCk();
    await OB.loadStorageClass(); // 恢复上次选择的存储类别（2.5）

    // 宿主托管的连接：凭据可能通过 context.connection 下发（标准生命周期形状）。
    // 优先用宿主下发的配置覆盖本地 storage 的回填值。
    let ctxConn = null;
    const ctx = (window.dbxPlugin && window.dbxPlugin.context) || {};
    if (ctx.connectionId) OB.state.connectionId = ctx.connectionId;
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
        if (ctxConn.name) OB.els.fName.value = ctxConn.name;
        OB.els.fProvider.value = provider === "s3" ? "s3" : "aliyun";
        OB.els.fEndpoint.value = endpoint;
        OB.els.fBucket.value = bucket;
        OB.els.fAk.value = ak;
        OB.els.fSk.value = sk;
        if (OB.els.fRegion) OB.els.fRegion.value = region;
        if (OB.els.fPathStyle) OB.els.fPathStyle.checked = pathStyle;
        if (OB.els.fReadOnly) OB.els.fReadOnly.checked = readOnly;
        OB.updateProviderUI();
      }
    }

    if (meta && !ctxConn) {
      // 已记住 Secret 时不必再提示重输，避免造成"没保存"的误解
      OB.msg(OB.state.rememberSk && OB.els.fSk.value
        ? I18N.t("conn.loadedSk")
        : I18N.t("conn.loaded"));
    }

    // 宿主已自动连接（凭据在 Sidecar 内存）：直接进入浏览器视图
    try {
      const st = await OB.invoke("connection/status", {});
      if (st && st.connected) {
        OB.state.connected = true;
        OB.state.provider = st.provider === "s3" ? "s3" : "aliyun";
        OB.state.endpoint = st.endpoint || "";
        OB.state.bucket = st.bucket || "";
        OB.state.prefix = "";
        // 只读状态由后端裁定（宿主 connection.read_only 已在后端解析并落地），
        // 前端据此隐藏写入口。
        OB.state.readOnly = !!st.readOnly;
        OB.updateEndpointLabel();
        OB.state.pageSize = Math.min(1000, Math.max(10, OB.state.pageSize || 200));
        OB.enterBrowser();
        return;
      }
    } catch (e) { /* 后端未就绪则回退到连接表单 */ }

    // 宿主托管连接但还未自动连：用 context 下发的凭据自动连接，免去手填 AK/Secret
    if (ctxConn && ctxConn.accessKeyId && ctxConn.accessKeySecret) {
      // 宿主 context 里若带 readOnly，同步到表单勾选框，连接后状态才一致
      if (ctxConn.readOnly && OB.els.fReadOnly) {
        OB.els.fReadOnly.checked = true;
      }
      await OB.doConnect();
      return;
    }
  };

  // 启动。所有模块已加载完毕（经典 script 按 index.html 的顺序同步执行），
  // 此时 OB 上各模块的能力都已就绪。
  OB.boot();
})(window.OB);
