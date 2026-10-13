// UI 国际化：仅做 zh-CN / en 两套，en 为默认兜底。
// 宿主若通过 window.dbxPlugin.context.locale 注入语言则优先采用，否则回退到 navigator.language。
(function () {
  "use strict";

  const DICT = {
    "zh-CN": {
      "toolbar.mkdir": "新建目录",
      "toolbar.upload": "上传",
      "toolbar.refresh": "刷新",
      "toolbar.connect": "连接",
      "col.name": "名称",
      "col.size": "类型 / 大小",
      "col.time": "最后修改时间",
      "col.ops": "操作",
      "search.placeholder": "按名称前缀过滤，回车确认",
      "nav.up": "向上一级",
      "dialog.title": "新建连接",
      "dialog.close": "关闭",
      "field.name": "名称",
      "field.type": "类型",
      "type.storage": "存储",
      "field.color": "颜色",
      "field.protocol": "协议",
      "field.protocol.oss": "阿里云 OSS",
      "field.provider": "存储类型",
      "provider.aliyun": "阿里云 OSS",
      "provider.s3": "S3 兼容（MinIO 等）",
      "field.region": "Region",
      "region.help": "可选。少数 S3 兼容服务需指定 Region；留空由服务端自动探测。",
      "field.pathstyle": "Path Style",
      "pathstyle.help": "以路径形式寻址（http://endpoint/bucket/key）。自建 MinIO 建议勾选。",
      "field.endpoint": "接入点",
      "field.bucket": "Bucket",
      "field.ak": "AccessKeyId",
      "field.sk": "Secret",
      "field.pageSize": "分页大小",
      "endpoint.help": "服务地址。华东1：oss-cn-hangzhou.aliyuncs.com；华北2：oss-cn-beijing.aliyuncs.com；华南1：oss-cn-shenzhen.aliyuncs.com；中国香港：oss-cn-hongkong.aliyuncs.com。内网形如 oss-cn-hangzhou-internal.aliyuncs.com。",
      "endpoint.help.aliyun": "服务地址。华东1：oss-cn-hangzhou.aliyuncs.com；华北2：oss-cn-beijing.aliyuncs.com；华南1：oss-cn-shenzhen.aliyuncs.com；中国香港：oss-cn-hongkong.aliyuncs.com。内网形如 oss-cn-hangzhou-internal.aliyuncs.com。",
      "endpoint.help.s3": "S3 兼容服务地址（含端口与协议）。自建 MinIO 形如 http://192.168.1.10:9000；AWS S3 形如 s3.amazonaws.com；Cloudflare R2 形如 https://<account>.r2.cloudflarestorage.com。",
      "bucket.help": "存储桶名称。留空则在连接根目录列出全部存储桶。",
      "ak.help": "访问密钥标识。建议使用 RAM 子账号 AK，仅授予所需的 OSS 权限。",
      "sk.help": "访问密钥。保存在本机插件存储中（明文），重开会话自动回填，无需重新输入。",
      "pageSize.help": "每页列取对象数（10–1000）。大目录将自动分页加载，不会一次性拉取全量。",
      "btn.test": "测试",
      "btn.save": "保存并连接",
      "conn.fillRequired": "请填写端点、Access Key ID 与 Secret",
      "conn.connecting": "连接中…",
      "conn.connectFail": "连接失败：",
      "conn.testFill": "请先填写端点、AK 与 Secret",
      "conn.testing": "测试中…",
      "conn.testOk": "测试成功",
      "conn.testFail": "测试失败：",
      "conn.loaded": "已载入上次连接配置，输入 Secret 后重新连接",
      "breadcrumb.allBuckets": "全部存储桶",
      "breadcrumb.notConnected": "未连接",
      "status.notConnected": "未连接——点击右上角「连接」新建或恢复连接",
      "status.loading": "加载中…",
      "status.loadingMore": "加载更多…",
      "status.loaded": "共 {n} 项",
      "status.loadedMore": "已加载 {n} 项，还有更多",
      "status.loadFail": "加载失败：",
      "row.dir": "目录",
      "op.open": "打开",
      "op.preview": "预览",
      "preview.loadFail": "预览加载失败，请尝试下载后查看",
      "preview.truncated": "文件过大，仅显示前 2MB",
      "preview.tooLarge": "文件超过预览大小上限（20MB），请下载后查看",
      "preview.unsupported": "该文件类型暂不支持预览",
      "preview.copy": "复制内容",
      "preview.copied": "已复制到剪贴板",
      
      "op.download": "下载",
      "op.addr": "获得地址",
      "op.delete": "删除",
      "modal.mkdirTitle": "新建目录",
      "modal.mkdirPlaceholder": "目录名",
      "modal.mkdirConfirm": "创建",
      "modal.confirmTitle": "删除确认",
      "modal.ok": "确定",
      "modal.cancel": "取消",
      "modal.copyTitle": "文件已下载",
      "modal.copyHint": "已复制到剪贴板",
      "modal.copyFail": "复制失败，请手动选择文本复制",
      "copy.title": "对象访问地址",
      "copy.hint": "",
      "copy.btn": "复制",
      "copy.close": "关闭",
      "download.status": "下载中：",
      "download.done": "已下载到：",
      "download.fail": "下载失败：",
      "addr.missingEndpoint": "缺少 Endpoint 信息，无法生成地址",
      "addr.copied": "已复制地址（也可在弹窗中手动复制）",
      "delete.dirTip": "确认删除目录「{name}」？\n仅删除目录标记，目录内的对象不会被删除。",
      "delete.fileTip": "确认删除文件「{name}」？",
      "delete.status": "已删除：",
      "delete.fail": "删除失败：",
      "mkdir.notConnected": "未连接",
      "mkdir.enterBucket": "请在进入某个存储桶后再创建目录",
      "mkdir.done": "目录已创建：",
      "mkdir.fail": "创建失败：",
      "upload.notConnected": "未连接",
      "upload.enterBucket": "请在进入某个存储桶后再上传",
      "upload.status": "上传中…",
      "upload.done": "上传完成：",
      "upload.fail": "上传失败：",
      "upload.title": "上传",
      "upload.cancelled": "已取消",
      "presign.title": "预签名 URL",
      "presign.placeholder": "有效期（秒）：300 / 3600 / 86400 / 604800",
      "presign.ok": "已生成预签名 URL",
      "presign.fail": "预签名失败，已回退拼接地址（仅公共读可用）：",
      "presign.fallback": "非签名地址",
      "common.notConnected": "未连接",
      "dl.saved": "已保存到您选择的位置",
      "dl.title": "下载",
      "dl.cancel": "取消",
      "dl.ok": "关闭",
      "download.cancelled": "已取消下载：",
      "download.doneName": "已下载：",
      "dl.dirTitle": "选择保存目录",
      "dl.dirPlaceholder": "目录绝对路径，例如 C:/Users/用户名/Downloads",
      "dl.dirConfirm": "开始下载",
      "sel.all": "全选 / 取消全选",
      "batch.count": "已选 {n} 项",
      "batch.delete": "批量删除",
      "batch.download": "批量下载",
      "batch.clear": "取消选择",
      "batch.deleteTip": "确认删除选中的 {n} 项？\n目录仅删除目录标记，目录内的对象不会被删除。",
      "batch.deleting": "正在删除 {n} 项…",
      "batch.deleted": "已删除 {n} 项",
      "batch.failed": "{n} 项失败",
      "batch.downloadTitle": "批量下载 {n} 项",
      "batch.noFiles": "所选内容中没有可下载的文件",
      "batch.downloadDone": "批量下载完成：成功 {n} 项",
      "batch.downloadFail": "批量下载完成：成功 {a} 项，失败 {b} 项",
      "batch.downloadDir": "保存目录："
    },
    "en": {
      "toolbar.mkdir": "New Folder",
      "toolbar.upload": "Upload",
      "toolbar.refresh": "Refresh",
      "toolbar.connect": "Connect",
      "col.name": "Name",
      "col.size": "Type / Size",
      "col.time": "Last Modified",
      "col.ops": "Actions",
      "search.placeholder": "Filter by name prefix, press Enter",
      "nav.up": "Up one level",
      "dialog.title": "New Connection",
      "dialog.close": "Close",
      "field.name": "Name",
      "field.type": "Type",
      "type.storage": "Storage",
      "field.color": "Color",
      "field.protocol": "Protocol",
      "field.protocol.oss": "Alibaba Cloud OSS",
      "field.provider": "Storage Type",
      "provider.aliyun": "Alibaba Cloud OSS",
      "provider.s3": "S3 Compatible (MinIO, etc.)",
      "field.region": "Region",
      "region.help": "Optional. A few S3-compatible services require an explicit Region; leave empty for auto-detection.",
      "field.pathstyle": "Path Style",
      "pathstyle.help": "Address objects by path (http://endpoint/bucket/key). Recommended for self-hosted MinIO.",
      "field.endpoint": "Endpoint",
      "field.bucket": "Bucket",
      "field.ak": "AccessKeyId",
      "field.sk": "Secret",
      "field.pageSize": "Page Size",
      "endpoint.help": "Service address. East China 1: oss-cn-hangzhou.aliyuncs.com; North China 2: oss-cn-beijing.aliyuncs.com; South China 1: oss-cn-shenzhen.aliyuncs.com; Hong Kong (China): oss-cn-hongkong.aliyuncs.com. Internal: oss-cn-hangzhou-internal.aliyuncs.com.",
      "endpoint.help.aliyun": "Service address. East China 1: oss-cn-hangzhou.aliyuncs.com; North China 2: oss-cn-beijing.aliyuncs.com; South China 1: oss-cn-shenzhen.aliyuncs.com; Hong Kong (China): oss-cn-hongkong.aliyuncs.com. Internal: oss-cn-hangzhou-internal.aliyuncs.com.",
      "endpoint.help.s3": "S3-compatible endpoint (with port and scheme). Self-hosted MinIO: http://192.168.1.10:9000; AWS S3: s3.amazonaws.com; Cloudflare R2: https://<account>.r2.cloudflarestorage.com.",
      "bucket.help": "Bucket name. Leave empty to list all buckets at the connection root.",
      "ak.help": "Access key ID. Recommended to use a RAM sub-account AK with only the required OSS permissions.",
      "sk.help": "Access key secret. Stored in the local plugin storage (plaintext) and auto-filled on next launch; no need to re-enter.",
      "pageSize.help": "Objects fetched per page (10–1000). Large directories are paged automatically; the full list is never pulled at once.",
      "btn.test": "Test",
      "btn.save": "Save & Connect",
      "conn.fillRequired": "Please fill in Endpoint, Access Key ID and Secret",
      "conn.connecting": "Connecting…",
      "conn.connectFail": "Connection failed: ",
      "conn.testFill": "Please fill in Endpoint, AK and Secret first",
      "conn.testing": "Testing…",
      "conn.testOk": "Test succeeded",
      "conn.testFail": "Test failed: ",
      "conn.loaded": "Last connection config loaded; enter Secret to reconnect",
      "breadcrumb.allBuckets": "All Buckets",
      "breadcrumb.notConnected": "Not connected",
      "status.notConnected": "Not connected — click “Connect” at top right to create or restore a connection",
      "status.loading": "Loading…",
      "status.loadingMore": "Loading more…",
      "status.loaded": "Total {n} items",
      "status.loadedMore": "Loaded {n} items, more available",
      "status.loadFail": "Load failed: ",
      "row.dir": "Folder",
      "op.open": "Open",
      "op.preview": "Preview",
      "preview.loadFail": "Preview failed, try downloading instead",
      "preview.truncated": "File too large, showing first 2MB",
      "preview.tooLarge": "File exceeds preview limit (20MB), please download",
      "preview.unsupported": "Preview is not supported for this file type",
      "preview.copy": "Copy contents",
      "preview.copied": "Copied to clipboard",
      
      "op.download": "Download",
      "op.addr": "Get URL",
      "op.delete": "Delete",
      "modal.mkdirTitle": "New Folder",
      "modal.mkdirPlaceholder": "Folder name",
      "modal.mkdirConfirm": "Create",
      "modal.confirmTitle": "Delete Confirmation",
      "modal.ok": "OK",
      "modal.cancel": "Cancel",
      "modal.copyTitle": "File Downloaded",
      "modal.copyHint": "Copied to clipboard",
      "modal.copyFail": "Copy failed, please select and copy the text manually",
      "copy.title": "Object URL",
      "copy.hint": "",
      "copy.btn": "Copy",
      "copy.close": "Close",
      "download.status": "Downloading: ",
      "download.done": "Downloaded to: ",
      "download.fail": "Download failed: ",
      "addr.missingEndpoint": "Missing Endpoint info, cannot generate URL",
      "addr.copied": "URL copied (or copy manually from the dialog)",
      "delete.dirTip": "Delete folder “{name}”?\nOnly the folder marker is removed; objects inside are not deleted.",
      "delete.fileTip": "Delete file “{name}”?",
      "delete.status": "Deleted: ",
      "delete.fail": "Delete failed: ",
      "mkdir.notConnected": "Not connected",
      "mkdir.enterBucket": "Enter a bucket before creating a folder",
      "mkdir.done": "Folder created: ",
      "mkdir.fail": "Create failed: ",
      "upload.notConnected": "Not connected",
      "upload.enterBucket": "Enter a bucket before uploading",
      "upload.status": "Uploading…",
      "upload.done": "Upload complete: ",
      "upload.fail": "Upload failed: ",
      "upload.title": "Upload",
      "upload.cancelled": "Cancelled",
      "presign.title": "Presigned URL",
      "presign.placeholder": "Expiry in seconds: 300 / 3600 / 86400 / 604800",
      "presign.ok": "Presigned URL generated",
      "presign.fail": "Presign failed, fallback to plain URL (public-read only): ",
      "presign.fallback": "unsigned URL",
      "common.notConnected": "Not connected",
      "dl.saved": "Saved to the location you chose",
      "dl.title": "Download",
      "dl.cancel": "Cancel",
      "dl.ok": "Close",
      "download.cancelled": "Download cancelled: ",
      "download.doneName": "Downloaded: ",
      "dl.dirTitle": "Choose save directory",
      "dl.dirPlaceholder": "Absolute directory path, e.g. C:/Users/Username/Downloads",
      "dl.dirConfirm": "Start Download",
      "sel.all": "Select all / none",
      "batch.count": "{n} selected",
      "batch.delete": "Delete Selected",
      "batch.download": "Download Selected",
      "batch.clear": "Clear Selection",
      "batch.deleteTip": "Delete {n} selected items?\nFolders only remove the folder marker; objects inside are not deleted.",
      "batch.deleting": "Deleting {n} items…",
      "batch.deleted": "Deleted {n} items",
      "batch.failed": "{n} failed",
      "batch.downloadTitle": "Downloading {n} items",
      "batch.noFiles": "No downloadable files in the selection",
      "batch.downloadDone": "Batch download finished: {n} succeeded",
      "batch.downloadFail": "Batch download finished: {a} succeeded, {b} failed",
      "batch.downloadDir": "Save directory: "
    }
  };

  // ---------- 语言探测 ----------
  // 宿主真实字段是 window.dbxPlugin.locale（getter，宿主在 init 消息里注入；
  // init 之前它是默认值，所以必须等 ready / 变更事件后再重新探测）。
  // 兼容其它可能的注入位置逐级兜底；词典只有 zh-CN / en，其它语言一律归到 en。
  function normalizeLocale(loc) {
    loc = String(loc == null ? "" : loc).toLowerCase();
    if (loc.indexOf("zh") === 0) return "zh-CN";
    return "en";
  }

  function readHostLocale() {
    const dp = window.dbxPlugin;
    if (!dp) return "";
    try {
      if (dp.locale) return dp.locale;              // 宿主标准字段（dev-runtime 的 getter）
    } catch (e) { /* ignore */ }
    const ctx = dp.context;
    if (ctx) {
      const v = ctx.locale || ctx.language || ctx.lang;
      if (v) return v;
    }
    return "";
  }

  function detect(trustHost) {
    const host = readHostLocale();
    const nav = (navigator && (navigator.language || navigator.userLanguage)) || "";
    const doc = (document.documentElement && document.documentElement.getAttribute("lang")) || "";
    // 首屏（宿主尚未 init）时宿主字段可能是默认值，先看 navigator；
    // init/env 之后宿主字段才权威，优先信任它。document.lang 仅作最后兜底
    // （index.html 里硬编码为 zh-CN，不应盖过 navigator）。
    const picked = trustHost ? (host || nav || doc) : (nav || host || doc);
    return normalizeLocale(picked || "en");
  }

  let CUR = detect(false);
  const cbs = [];

  window.I18N = {
    get locale() { return CUR; },

    // 重新探测语言并应用静态文案；返回是否发生变化。trustHost 见 detect()。
    refresh(trustHost) {
      const next = detect(!!trustHost);
      const changed = next !== CUR;
      CUR = next;
      this.apply();
      for (const cb of cbs) { try { cb(CUR, changed); } catch (e) { /* ignore */ } }
      return changed;
    },

    // 订阅“刷新后”的回调，供重新渲染由 JS 动态生成的文案。
    onChange(cb) { if (typeof cb === "function") cbs.push(cb); },

    t(key, vars) {
      let s = (DICT[CUR] && DICT[CUR][key]) || DICT["en"][key] || DICT["zh-CN"][key] || key;
      if (vars) {
        for (const k in vars) {
          s = s.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
        }
      }
      return s;
    },

    apply(root) {
      root = root || document;
      root.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = this.t(el.getAttribute("data-i18n"));
      });
      root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        el.setAttribute("placeholder", this.t(el.getAttribute("data-i18n-placeholder")));
      });
      root.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.setAttribute("title", this.t(el.getAttribute("data-i18n-title")));
      });
    }
  };

  // 静态文案在 DOM 就绪后即可填充（脚本位于 body 末尾，此时元素已存在）
  function applyNow() { window.I18N.apply(); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyNow);
  } else {
    applyNow();
  }

  // 宿主 init / 语言切换后重新探测并刷新（init 之后宿主 locale 才准确）
  (function watchLocale() {
    const dp = window.dbxPlugin;
    if (dp) {
      if (dp.ready && typeof dp.ready.then === "function") {
        dp.ready.then(() => window.I18N.refresh(true)).catch(() => {});
      }
      if (typeof dp.onContext === "function") dp.onContext(() => window.I18N.refresh(true));
      if (typeof dp.onEvent === "function") dp.onEvent(() => window.I18N.refresh(true));
    }
    // dev-runtime 还会在 document 上派发自定义事件
    document.addEventListener("dbx-plugin-init", () => window.I18N.refresh(true));
    document.addEventListener("dbx-plugin-env", () => window.I18N.refresh(true));
    document.addEventListener("dbx-plugin-context", () => window.I18N.refresh(true));
  })();
})();
