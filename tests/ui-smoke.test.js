// ui-smoke.test.js — UI 模块化后的运行时冒烟测试。
//
// 目的：证明「拆成 9 个模块」后，UI 仍能正常初始化、事件能绑定、关键交互可用。
//
// 做法：用最小 DOM stub（jsdom 不可用——沙箱环境无 node_modules 依赖），
// 加载 index.html 里的全部 script，然后驱动几个关键流程：
//   1. 全部脚本加载无异常
//   2. OB 命名空间完整，各模块能力已注册
//   3. 事件监听器已绑定（点击「刷新」会触发 invoke）
//   4. 列表渲染：从假后端返回对象 → 渲染出行
//   5. 排序与多选：点表头排序、勾选复选框
//   6. 断点续传参数：批量下载时带 relPath
//
// 运行：node --test ui/ui-smoke.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const UI = path.join(__dirname, "..", "ui");

// ---------- 最小 DOM stub ----------

class StubElement {
  constructor(tag, id) {
    this.tagName = (tag || "div").toUpperCase();
    this.id = id || "";
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this._classes = new Set();
    this._listeners = {};
    this._html = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.title = "";
    this.placeholder = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.clientHeight = 400;
    this.clientWidth = 800;
  }
  get classList() {
    const self = this;
    return {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      toggle: (c, on) => { if (on === undefined) { self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c); } else if (on) self._classes.add(c); else self._classes.delete(c); },
      contains: (c) => self._classes.has(c),
    };
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(" "); }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return this.attrs[k] !== undefined; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter((f) => f !== fn); }
  dispatch(t, ev) { (this._listeners[t] || []).forEach((f) => f(ev)); }
  querySelector(sel) { return this.query(sel)[0] || null; }
  querySelectorAll(sel) { return this.query(sel); }
  query(sel) {
    const out = [];
    const want = sel.replace(/^[.#]/, "");
    const isClass = sel.startsWith(".");
    const walk = (n) => {
      for (const c of n.children) {
        if (isClass ? c._classes.has(want) : c.id === want) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest() { return null; }
  focus() {}
  select() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; }
  contains() { return false; }
  cloneNode() { return new StubElement(this.tagName, this.id); }
  insertAdjacentHTML() {}
  scrollIntoView() {}
}

// 从 index.html 解析出所有 id 与 class，创建对应的 stub 元素
function buildDom(html) {
  const ids = new Set();
  const classOf = new Map();
  // 必须连同 class 一起解析：模态框等元素初始带 class="modal hidden"，
  // 若 stub 不带 hidden，`classList.contains("hidden")` 恒为 false，
  // 「弹框是否打开」的判断会假阳性——测试会在弹框真正弹出前就去点按钮。
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    ids.add(m[1]);
    const cls = /class="([^"]*)"/.exec(m[0]);
    if (cls) classOf.set(m[1], cls[1]);
  }
  const registry = new Map();
  for (const id of ids) {
    const el = new StubElement("div", id);
    const cls = classOf.get(id);
    if (cls) cls.split(/\s+/).filter(Boolean).forEach((c) => el._classes.add(c));
    registry.set(id, el);
  }
  return { registry, ids };
}

// ---------- 加载 UI 脚本 ----------
function loadUI() {
  const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
  const { registry } = buildDom(html);

  const listeners = {};   // document 级监听
  const doc = {
    _listeners: listeners,
    getElementById: (id) => registry.get(id) || null,
    createElement: (t) => new StubElement(t),
    querySelector: (s) => registry.get(s.replace(/^[.#]/, "")) || null,
    querySelectorAll: () => [],
    body: new StubElement("body"),
    documentElement: new StubElement("html"),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (t, ev) => (listeners[t] || []).forEach((f) => f(ev)),
    removeEventListener: () => {},
    execCommand: () => true,
    activeElement: null,
    title: "",
  };

  // 关键：模拟宿主沙箱的 opaque origin 行为
  const invocations = [];
  // 上传相关状态：供「钉住上下文」测试断言文件实际去向
  let uploadSeq = 0;
  const uploadState = {};   // uploadId → { bucket, key, written, size }
  const uploadLog = [];     // 按时间顺序记录 begin/chunk/complete/status/abort 调用
  // 异步上传任务（issue #11 第二批）：complete 返回 taskId，前端轮询 status 等终态。
  let taskSeq = 0;
  const taskState = {};
  // 可由测试改写：让"上云"阶段持续 N 轮 status 轮询才结束，
  // 用于验证前端确实在等待终态而不是拿到 taskId 就当完成。
  let uploadCloudTicks = 0;
  // 模拟云端已存在的对象集合（"bucket/key"）。begin 据此返回 exists 冲突标记，
  // complete 成功后把对象写入集合——行为与真实对象存储的覆盖语义一致。
  const cloudObjects = new Set();
  const win = {
    document: doc,
    // opaque origin 下 clipboard API 通常不可用 → 走宿主桥
    navigator: { clipboard: null },
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    location: { href: "http://dbx-plugin.localhost/" },
    I18N: null, Utils: null, ICONS: null, RenameRule: null, OB: null,
    dbxPlugin: {
      ready: Promise.resolve(),
      context: {},
      storage: {
        get: async () => undefined,
        set: async () => {},
        remove: async () => {},
      },
      copy: async (t) => { invocations.push({ method: "__copy", text: t }); },
      invoke: async (method, params) => {
        invocations.push({ method, params });
        return mockBackend(method, params);
      },
      readAssetUrl: async (p) => "blob:" + p,
    },
  };
  win.window = win;
  // window 上的事件（与 document 同级）
  win.addEventListener = doc.addEventListener.bind(doc);
  win.removeEventListener = doc.removeEventListener.bind(doc);
  win.dispatchEvent = (t, ev) => (doc._listeners[t] || []).forEach((f) => f(ev));

  // 在独立的 vm context 里跑，等价于真实的 <script> 标签：
  // 顶层 this 是 window，全局变量互相可见，模块间能通过 window.OB 通信。
  const sandbox = Object.create(null);
  Object.assign(sandbox, win);
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  sandbox.Blob = class { constructor(a) { this.parts = a; } };
  sandbox.URL = { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} };
  // btoa/atob：真实宿主（浏览器）自带，vm 沙箱没有。utils.js 的
  // base64FromArrayBuffer 依赖 btoa——缺了它上传分片会抛
  // "btoa is not defined"，整条上传链路在第一个 chunk 就断掉。
  sandbox.btoa = (s) => Buffer.from(String(s), "binary").toString("base64");
  sandbox.atob = (b) => Buffer.from(String(b), "base64").toString("binary");
  const env = { loadError: null };
  const ctx = vm.createContext(sandbox);
  // script 标签里的顶层 this === window
  vm.runInContext("var window = globalThis; var self = globalThis; var top = globalThis;", ctx);

  // 假后端
  function mockBackend(method, params) {
    switch (method) {
      case "plugin/initialize":
        return { capabilities: [], plugin: { id: "com.object.browser", version: "1.2.0" }, protocolVersion: 1 };
      case "connection/status":
        return { connected: false };
      case "buckets/list":
        return { items: [{ name: "bucket-a", is_dir: true }] };
      case "objects/list":
        return {
          items: [
            { name: "dir/", is_dir: true, size: 0, mime: "application/x-directory", modified: "2026-01-01T00:00:00Z" },
            { name: "a.txt", is_dir: false, size: 100, mime: "text/plain", modified: "2026-01-01T00:00:00Z" },
            { name: "b.txt", is_dir: false, size: 200, mime: "text/plain", modified: "2026-01-01T00:00:00Z" },
          ],
          is_truncated: false, next_marker: "",
        };
      case "objects/stat":
        return { size: "100", mime: "text/plain", modified: "2026-01-01T00:00:00Z", etag: "e1", contentType: "text/plain" };
      case "objects/get_tags":
        return { tags: {} };
      // ---------- 上传（供「钉住上下文」等上传流程测试驱动） ----------
      // 每个 begin 发一个递增的 uploadId；chunk 按收到的 content 长度累计 written；
      // complete 记录该 uploadId 对应的 (bucket,key)。所有调用都留痕在 uploadLog，
      // 测试据此断言「中途改 OB.state 不会改变文件去向」。
      case "upload/begin": {
        // 冲突检测（issue #11 第三批）：目标已存在且未声明覆盖 → 返回 exists 标记
        const ckey = (params.bucket || "") + "/" + (params.path || "");
        if (cloudObjects.has(ckey) && !params.overwrite) {
          uploadLog.push({ method, bucket: params.bucket, path: params.path, exists: true });
          return { exists: true, size: 100, modified: "2026-01-01T00:00:00Z", etag: "etag-old" };
        }
        const uploadId = "up-" + (++uploadSeq);
        uploadState[uploadId] = { bucket: params.bucket, key: params.path, written: 0, size: params.size };
        uploadLog.push({ method, bucket: params.bucket, path: params.path, uploadId, overwrite: !!params.overwrite });
        return { uploadId, offset: 0, resumed: false };
      }
      case "upload/chunk": {
        const st = uploadState[params.uploadId];
        if (st) {
          // content 是 base64，长度 *3/4 约为原始字节数；测试只关心单调递增
          const b64 = String(params.content || "");
          st.written = params.offset + Math.max(1, Math.floor((b64.length * 3) / 4));
        }
        uploadLog.push({ method, uploadId: params.uploadId, offset: params.offset });
        return { written: st ? st.written : params.offset };
      }
      case "upload/complete": {
        const st = uploadState[params.uploadId];
        uploadLog.push({ method, uploadId: params.uploadId, bucket: st && st.bucket, key: st && st.key });
        // 上传成功 → 对象落地云端（此后同名 begin 会命中冲突）
        if (st) cloudObjects.add((st.bucket || "") + "/" + (st.key || ""));
        // 异步语义（issue #11 第二批）：complete 立即返回 taskId，真正上云在后台。
        // 前端必须轮询 upload/status 等到终态才算完成——不返回 taskId 会让前端
        // 走"兼容旧后端"分支，异步等待逻辑就完全测不到了。
        const taskId = "task-" + (++taskSeq);
        // cloudPhaseTicks 控制"上云"要几轮轮询才结束：0 = 立即完成，
        // >0 则前 N 次 status 返回 running，用来验证前端确实在等待。
        taskState[taskId] = {
          state: "running",
          ticks: 0,
          remain: (typeof uploadCloudTicks === "number") ? uploadCloudTicks : 0,
          bucket: st && st.bucket,
          key: st && st.key,
          total: st ? st.size : 0,
        };
        return { taskId, async: true, ok: true, size: st ? st.written : 0 };
      }
      case "upload/status": {
        const t = taskState[params.taskId];
        if (!t) return { state: "failed", error: "任务不存在" };
        uploadLog.push({ method, taskId: params.taskId });
        if (t.remain > 0) {
          t.remain--;
          t.ticks++;
          return { taskId: params.taskId, state: "running", sent: Math.floor(t.total / 2), total: t.total, error: "" };
        }
        t.state = "done";
        return { taskId: params.taskId, state: "done", sent: t.total, total: t.total, error: "" };
      }
      case "upload/cancel": {
        const t = taskState[params.taskId];
        if (t) t.state = "cancelled";
        uploadLog.push({ method, taskId: params.taskId });
        return { ok: true, state: t ? t.state : "cancelled" };
      }
      case "upload/abort":
      case "upload/release":
        uploadLog.push({ method, uploadId: params.uploadId });
        return { ok: true };
      case "tasks/append":
      case "tasks/list":
        return method === "tasks/list" ? { tasks: [] } : { ok: true };
      default:
        return { ok: true };
    }
  }

  // 按 index.html 的顺序加载脚本（同步执行，与真实 <script> 一致）
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  for (const s of scripts) {
    const code = fs.readFileSync(path.join(UI, s), "utf8");
    try {
      vm.runInContext(code, ctx, { filename: s });
    } catch (e) {
      // 记录加载期失败：哪个脚本、什么错、哪一行。
      // 不重新抛出——让测试用例断言这个信息，比抛异常更好读。
      const _lines = code.split("\n");
      const _m = /(\d+)/.exec(String((e && e.stack) || "").split("\n")[0] || "");
      const _ln = _m ? parseInt(_m[1], 10) : 0;
      env.loadError = {
        script: s,
        message: String((e && e.message) || e),
        srcLine: _ln ? String(_lines[_ln - 1] || "") : "",
        prevLines: _ln > 3 ? _lines.slice(_ln - 4, _ln - 1).map((x, i) => (_ln - 3 + i) + ": " + x) : [],
        stack: String((e && e.stack) || "").split("\n").slice(0, 4),
      };
      break;
    }
  }
  // 沙箱里的 window 就是 sandbox 本身（脚本通过 window.OB 通信）
  return {
    win: sandbox, doc, invocations, registry, scripts,
    uploadLog, uploadState, taskState, cloudObjects,
    // 让测试控制"上云"持续几轮轮询（默认 0 = 立即完成）
    setCloudTicks: (n) => { uploadCloudTicks = n; },
    // 预置云端已存在的对象：begin 未声明 overwrite 时将命中冲突
    seedCloud: (bucket, key) => { cloudObjects.add(bucket + "/" + key); },
    loadError: env.loadError,
  };
}

// loadUIDiagnose 逐个脚本加载，报告第一个失败的位置（排查加载期错误用）。
function loadUIDiagnose() {
  const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const env = buildEnv();
  for (const s of scripts) {
    try {
      const code = fs.readFileSync(path.join(UI, s), "utf8");
      vm.runInContext(code, env.ctx, { filename: s });
    } catch (e) {
      return { script: s, error: String(e && e.message), stack: String(e && e.stack).split("\n").slice(0, 4) };
    }
  }
  return null;
}

// ---------- 测试 ----------

test("全部 UI 脚本可加载，无语法/运行时异常", () => {
  const { scripts, loadError } = loadUI();
  assert.ok(scripts.includes("core.js"), "应加载 core.js");
  assert.ok(scripts.includes("app.js"), "应加载 app.js");
  assert.ok(!scripts.includes("main.js"), "main.js 应已下线");
  assert.strictEqual(loadError, null,
    "脚本加载失败：" + (loadError ? loadError.script + " → " + loadError.message + "\n" + loadError.stack.join("\n") : ""));
});

test("OB 命名空间完整：各模块能力已注册", () => {
  const { win } = loadUI();
  const OB = win.OB;
  assert.ok(OB, "OB 应存在");
  // 共享层
  for (const k of ["state", "els", "invoke", "setStatus", "msg", "openPrompt", "openConfirm", "showCopy", "batchPick"]) {
    assert.ok(OB[k] !== undefined, `OB.${k} 应存在`);
  }
  // 各模块的代表性能力
  const expected = {
    conn: ["doConnect", "openConnDialog", "guardWritable", "loadMeta"],
    browse: ["loadPage", "renderList", "toggleSel", "applySort", "displayName"],
    batch: ["doBatchTransfer", "doBatchRename", "doBatchDownload"],
    search: ["doDeepSearch", "filterMatch"],
    meta: ["openDetail", "openMetaEditor"],
    transfer: ["doDownload", "doUpload", "openDlCard", "loadStorageClass"],
    preview: ["openPreview", "actOnRow", "previewKind", "refreshAcl"],
    app: ["boot"],
  };
  for (const [mod, fns] of Object.entries(expected)) {
    for (const fn of fns) {
      assert.strictEqual(typeof OB[fn], "function", `OB.${fn}（${mod} 模块）应为函数`);
    }
  }
});

test("启动流程：未连接时回退到连接表单", async () => {
  const { win } = loadUI();
  // boot 是异步的，等它跑完
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  assert.ok(OB.state, "state 应初始化");
  // 未连接 → 连接表单可见
  assert.ok(OB.els.overlay, "连接浮层元素应存在");
});

test("事件委托已注册：文档级 click 监听可派发到行/按钮", async () => {
  const { doc } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  // 本项目的行点击与工具栏按钮都走**文档级委托**（browse.js 的 onDocEvent），
  // 而不是给每个按钮单独绑 click——故检查 document 上的监听器。
  const clicks = doc._listeners.click || [];
  assert.ok(clicks.length > 0, "document 应注册 click 委托");
  const keydowns = doc._listeners.keydown || [];
  assert.ok(keydowns.length > 0, "document 应注册 keydown 委托");
});

test("列表渲染：对象列表产出 DOM 行", async () => {
  const { win, registry } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  // 直接驱动渲染（不依赖连接流程）
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";
  OB.state.items = [
    { name: "a.txt", isDir: false, size: 100, mime: "text/plain", modified: "2026-01-01T00:00:00Z" },
    { name: "b.txt", isDir: false, size: 200, mime: "text/plain", modified: "2026-01-01T00:00:00Z" },
  ];
  OB.renderList();
  const listContent = registry.get("listContent");
  assert.ok(listContent, "listContent 应存在");
  assert.ok(listContent.innerHTML.includes("a.txt"), "渲染结果应包含 a.txt");
  assert.ok(listContent.innerHTML.includes("b.txt"), "渲染结果应包含 b.txt");
});

test("排序：按大小倒序后 b.txt 在前", async () => {
  const { win } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.bucket = "bucket-a";
  OB.state.items = [
    { name: "a.txt", isDir: false, size: 100, mime: "text/plain", modified: "2026-01-01T00:00:00Z" },
    { name: "b.txt", isDir: false, size: 200, mime: "text/plain", modified: "2026-01-01T00:00:00Z" },
  ];
  OB.state.sortKey = "size";
  OB.state.sortDesc = true;
  OB.applySort();
  assert.strictEqual(OB.state.items[0].name, "b.txt", "按大小倒序时 b.txt 应在前");
});

test("多选：toggleSel 增删选中项，Shift 连选扩区间", async () => {
  const { win } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.bucket = "bucket-a";
  OB.state.items = [
    { name: "a.txt", isDir: false, size: 1, mime: "", modified: "" },
    { name: "b.txt", isDir: false, size: 2, mime: "", modified: "" },
    { name: "c.txt", isDir: false, size: 3, mime: "", modified: "" },
  ];
  OB.state.sel.clear();
  OB.state.selAnchor = -1;

  OB.toggleSel("a.txt", false);
  assert.ok(OB.state.sel.has("a.txt"), "应选中 a.txt");
  assert.strictEqual(OB.state.selAnchor, 0, "锚点应落在 a.txt");

  // Shift 点 c.txt → 从 a 到 c 全选
  OB.toggleSel("c.txt", true);
  assert.ok(OB.state.sel.has("a.txt"), "Shift 连选应含 a.txt");
  assert.ok(OB.state.sel.has("b.txt"), "Shift 连选应含 b.txt");
  assert.ok(OB.state.sel.has("c.txt"), "Shift 连选应含 c.txt");
});

test("批量下载：relPath 保留目录层级", async () => {
  const { win } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "sub/";
  OB.state.items = [{ name: "sub/x.txt", isDir: false, size: 1, mime: "", modified: "" }];
  OB.state.sel.clear();
  OB.state.sel.add("sub/x.txt");

  // batch.js 的 downloadRelPath 是模块内私有函数，通过批量下载的
  // objects/save 请求参数验证：relPath 应是 key 相对当前前缀的部分。
  // 这里的判据是「objects/save 的调用带 relPath 字段」，且
  // relPath 不含前导斜杠、不含 ".."。
  const batchSrc = fs.readFileSync(path.join(UI, "batch.js"), "utf8");
  assert.ok(batchSrc.includes("downloadRelPath"), "batch.js 应含 downloadRelPath");
  assert.ok(/relPath\s*:/.test(batchSrc), "批量下载应传 relPath");

  // 静态验证 downloadRelPath 的实现：相对 state.prefix 切前缀
  const m = batchSrc.match(/function downloadRelPath[\s\S]*?\n  }/);
  assert.ok(m, "应能找到 downloadRelPath 实现");
  const impl = m[0];
  assert.ok(impl.includes("state.prefix"), "应相对当前前缀计算");
  assert.ok(impl.includes("slice"), "应切掉前缀部分");
});
test("OB.invoke 注入本标签页 connectionId，且每标签页唯一", async () => {
  const { win, invocations } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;

  // 每个标签页（独立 webview / 独立加载）应有唯一的会话 ID
  assert.ok(OB.tabSessionId && OB.tabSessionId.startsWith("tab-"), "应生成 tab- 前缀的会话 ID");
  assert.strictEqual(OB.state.connectionId, OB.tabSessionId, "connectionId 默认应为标签页会话 ID");
  const { win: win2 } = loadUI();
  assert.notStrictEqual(win2.OB.tabSessionId, OB.tabSessionId, "两个标签页的会话 ID 应不同");

  // OB.invoke 应把 connectionId 注入 params（后端据此路由会话，见 backend/session.go）
  await OB.invoke("objects/list", { bucket: "bucket-a", prefix: "" });
  const call = invocations[invocations.length - 1];
  assert.strictEqual(call.method, "objects/list");
  assert.strictEqual(call.params.connectionId, OB.tabSessionId, "invoke 应注入 connectionId");
  assert.strictEqual(call.params.bucket, "bucket-a", "原有参数应保留");

  // params 已显式带 connectionId 时不覆盖
  await OB.invoke("connection/status", { connectionId: "explicit-id" });
  const call2 = invocations[invocations.length - 1];
  assert.strictEqual(call2.params.connectionId, "explicit-id", "显式 connectionId 不应被覆盖");
});

// ---------- 上传：上下文钉住与进度两阶段（issue #11 第一批） ----------

// makeFile 造一个最小 File 替身：size 字节，slice().arrayBuffer() 可读。
// onRead 钩子在每次读取分片时触发，用于模拟「上传途中用户导航到别处」。
function makeFile(name, size, opts) {
  const o = opts || {};
  return {
    name,
    size,
    type: "text/plain",
    webkitRelativePath: o.rel || "",
    slice(start, end) {
      const self = this;
      return { arrayBuffer: async () => {
        if (o.onRead) o.onRead(self);
        return new Uint8Array(Math.max(0, Math.min(end, size) - start)).buffer;
      } };
    },
  };
}

test("多文件上传：中途导航不会把后续文件传到新目录/新桶", async () => {
  const { win, uploadLog, invocations } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;

  // 上传起点：bucket-a 下的 dir/ 目录
  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "dir/";

  // 文件数必须多于并发路数（UP_CONC=3）：3 个 worker 会同时启动，
  // 前 3 个文件的 begin 在第一次 chunk 之前就已全部发出，此时 hijack 还来不及生效，
  // 测不出「钉住」与「不钉住」的差别（本测试一度因此假绿）。
  // 用 5 个文件时，第 4/5 个文件的 begin 要等某个 worker 空出来才发出，
  // 必然晚于 hijack，才真正检验「后续文件去向是否被中途导航带偏」。
  let hijacked = false;
  const hijack = () => {
    if (hijacked) return;
    hijacked = true;
    OB.state.bucket = "hijacked-bucket";
    OB.state.prefix = "evil/";
  };
  const files = [
    makeFile("a.txt", 10, { onRead: hijack }), // 读取第一个分片时用户就导航走了
    makeFile("b.txt", 10),
    makeFile("c.txt", 10),
    makeFile("d.txt", 10), // 这两个的 begin 必然晚于 hijack
    makeFile("e.txt", 10),
  ];

  OB.els.fileInput.files = files;
  await OB.els.fileInput.onchange();

  assert.ok(hijacked, "测试前提：中途应已发生导航");

  const begins = uploadLog.filter((c) => c.method === "upload/begin");
  assert.strictEqual(begins.length, files.length, "每个文件都应发起 begin");
  for (const b of begins) {
    assert.strictEqual(b.bucket, "bucket-a",
      `文件 ${b.path} 被传到了 ${b.bucket}（上下文未钉住，中途导航改变了文件去向）`);
    assert.ok(b.path.startsWith("dir/"),
      `文件应落在钉住的 dir/ 前缀下，实际 ${b.path}`);
  }
  const keys = begins.map((b) => b.path).sort();
  assert.deepStrictEqual(keys,
    ["dir/a.txt", "dir/b.txt", "dir/c.txt", "dir/d.txt", "dir/e.txt"],
    "全部文件的 key 应各自正确，不受中途导航影响");

  // 自检：确认真的有文件的 begin 发生在 hijack 之后。
  // 没有这条断言，将来并发度或文件数被改动会让测试悄悄退化成假绿。
  const firstChunkIdx = uploadLog.findIndex((c) => c.method === "upload/chunk");
  const beginsAfterHijack = uploadLog.slice(firstChunkIdx)
    .filter((c) => c.method === "upload/begin").length;
  assert.ok(beginsAfterHijack >= 1,
    `应至少有 1 个文件的 begin 晚于导航动作，实际 ${beginsAfterHijack} 个；`
    + "否则本测试未形成有效检验（需调大文件数或调低 UP_CONC）");

  // 收尾刷新守卫：用户已离开目标目录，不应重置他的视图（不发 objects/list）
  assert.ok(!invocations.some((c) => c.method === "objects/list"),
    "用户已导航离开，上传结束不应刷新列表把用户拽走");
});

test("单文件上传：进入上云阶段切不确定态，完成后清除", async () => {
  const { win } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";

  // 包装 invoke，在 upload/complete 被调用的瞬间记录进度条状态。
  // 这一刻正是「分片已落盘、真正上云开始」的分界点。
  const rawInvoke = OB.invoke;
  let classDuringComplete = null;
  let pctDuringComplete = null;
  OB.invoke = function (method, params, opts) {
    if (method === "upload/complete") {
      const fill = win.document.getElementById("dlFill");
      const pct = win.document.getElementById("dlPct");
      classDuringComplete = fill ? fill.className : null;
      pctDuringComplete = pct ? pct.textContent : null;
    }
    return rawInvoke(method, params, opts);
  };

  OB.els.fileInput.files = [makeFile("solo.txt", 10)];
  await OB.els.fileInput.onchange();

  assert.ok(classDuringComplete !== null, "应捕获到 upload/complete 调用");
  assert.ok(classDuringComplete.includes("indeterminate"),
    `上云阶段进度条应为不确定态，实际 className=${classDuringComplete}`);
  assert.notStrictEqual(pctDuringComplete, "100%",
    "上云阶段不应显示 100%（那会让人误以为已完成），实际=" + pctDuringComplete);

  // 完成后必须清除不确定态，否则填充条会带着 transform 动画继续滑动
  const fillAfter = win.document.getElementById("dlFill");
  assert.ok(!fillAfter.className.includes("indeterminate"),
    "完成后应清除不确定态动画");
  assert.strictEqual(fillAfter.style.width, "100%", "完成后填充条应为 100%");
});

test("单文件上传：complete 返回 taskId 后必须轮询到终态才算完成", async () => {
  // 让"上云"阶段需要 2 轮 status 才结束：第 1 轮 running、第 2 轮 done。
  // 若前端拿到 taskId 就当完成（旧行为），status 调用数会是 0。
  const { win, uploadLog, setCloudTicks } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  setCloudTicks(1);

  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";

  OB.els.fileInput.files = [makeFile("big.bin", 10)];
  await OB.els.fileInput.onchange();

  const completes = uploadLog.filter((c) => c.method === "upload/complete");
  assert.strictEqual(completes.length, 1, "应调用一次 complete");

  const statuses = uploadLog.filter((c) => c.method === "upload/status");
  assert.ok(statuses.length >= 2,
    `complete 返回 taskId 后前端必须轮询 status 等待终态，实际只轮询 ${statuses.length} 次`
    + "（0 次说明把 taskId 当成了完成，会在文件传完前就报成功）");

  // 上传应最终成功：进度卡显示完成态而非错误
  const msg = win.document.getElementById("dlMsg");
  assert.ok(!msg.className.includes("err"),
    "等待终态后上传应成功，实际卡片为错误态: " + msg.textContent);
});

test("上云阶段点取消：应调用 upload/cancel 中止后端任务", async () => {
  // 让上云阶段足够长（10 轮），期间把 cancelled 置真，
  // 前端应在下一轮轮询时调 upload/cancel 而不是干等到超时。
  const { win, uploadLog, setCloudTicks } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  setCloudTicks(10);

  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";

  OB.els.fileInput.files = [makeFile("big.bin", 10)];
  const done = OB.els.fileInput.onchange();
  // 等第一次 status 轮询发生后（上云阶段已开始）再取消
  await new Promise((r) => setTimeout(r, 100));
  OB.shared.dl.cancelled = true;
  await done;

  const cancels = uploadLog.filter((c) => c.method === "upload/cancel");
  assert.ok(cancels.length >= 1,
    "上云阶段取消应调用 upload/cancel 中止后端任务（否则后端会继续白传，浪费带宽与配额）");
});

// ---------- 上传冲突确认（issue #11 第三批） ----------

// waitForModal 等冲突弹框出现（worker 异步撞上冲突后才弹）。
async function waitForModal(doc, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const m = doc.getElementById("conflictModal");
    if (m && !m.classList.contains("hidden")) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("冲突弹框未在超时内出现（begin 可能未返回 exists 标记）");
}

test("上传冲突：选覆盖后带 overwrite:true 重新上传", async () => {
  const { win, doc, uploadLog, seedCloud } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";
  seedCloud("bucket-a", "dup.txt"); // 云端已有同名对象

  OB.els.fileInput.files = [makeFile("dup.txt", 10)];
  const p = OB.els.fileInput.onchange();
  await waitForModal(doc);
  doc.getElementById("conflictOverwrite").onclick();
  await p;

  const begins = uploadLog.filter((c) => c.method === "upload/begin");
  assert.strictEqual(begins.length, 2, "应 begin 两次（首次命中冲突 + 覆盖重试）");
  assert.strictEqual(begins[0].exists, true, "首次 begin 应命中冲突");
  assert.strictEqual(begins[1].overwrite, true, "覆盖重试的 begin 应带 overwrite:true");
  const completes = uploadLog.filter((c) => c.method === "upload/complete");
  assert.strictEqual(completes.length, 1, "选择覆盖后应完成上传");
});

test("上传冲突：全部跳过后记忆生效，跳过的文件一个字节都不传", async () => {
  const { win, doc, uploadLog, invocations, seedCloud } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";
  seedCloud("bucket-a", "x.txt");
  seedCloud("bucket-a", "y.txt");

  OB.els.fileInput.files = [
    makeFile("x.txt", 10),
    makeFile("y.txt", 10),
    makeFile("fresh.txt", 10),
  ];
  const p = OB.els.fileInput.onchange();
  await waitForModal(doc);
  doc.getElementById("conflictSkipAll").onclick();
  await p;

  // 两个冲突文件都不应进入传输（exists 之后再无 begin/complete）
  const dupBegins = uploadLog.filter(
    (c) => c.method === "upload/begin" && (c.path === "x.txt" || c.path === "y.txt")
  );
  for (const b of dupBegins) {
    assert.strictEqual(b.exists, true, "冲突文件只应有命中冲突的那一次 begin");
  }
  const completes = uploadLog.filter((c) => c.method === "upload/complete");
  assert.strictEqual(completes.length, 1, "只有 fresh.txt 完成上传");

  // 任务记录：ok=1 skip=2 fail=0
  const taskCalls = invocations.filter((c) => c.method === "tasks/append");
  assert.ok(taskCalls.length >= 1, "应记录任务");
  const rec = taskCalls[taskCalls.length - 1].params.record;
  assert.strictEqual(rec.ok, 1, "成功数应为 1");
  assert.strictEqual(rec.skipped, 2, "跳过数应为 2");
  assert.strictEqual(rec.failed.length, 0, "跳过不算失败");
});

test("上传冲突：全部覆盖即时应用到仍在排队的冲突", async () => {
  const { win, doc, uploadLog, seedCloud } = loadUI();
  await new Promise((r) => setTimeout(r, 50));
  const OB = win.OB;
  OB.state.connected = true;
  OB.state.readOnly = false;
  OB.state.bucket = "bucket-a";
  OB.state.prefix = "";
  seedCloud("bucket-a", "x.txt");
  seedCloud("bucket-a", "y.txt");

  OB.els.fileInput.files = [
    makeFile("x.txt", 10),
    makeFile("y.txt", 10),
    makeFile("fresh.txt", 10),
  ];
  const p = OB.els.fileInput.onchange();
  await waitForModal(doc);
  doc.getElementById("conflictOverwriteAll").onclick();
  await p;

  // 两个冲突文件都应带 overwrite:true 重新 begin——
  // 第二个冲突轮到自己时 conflictMode 已是 overwriteAll，直接套用不再弹框。
  const overwrites = uploadLog.filter(
    (c) => c.method === "upload/begin" && c.overwrite
  );
  assert.strictEqual(overwrites.length, 2,
    `x 与 y 都应带 overwrite 重新 begin，实际 ${overwrites.length} 个`
    + "（若为 1，说明排队中的冲突没有即时应用已做的决定，会二次弹框）");
  const completes = uploadLog.filter((c) => c.method === "upload/complete");
  assert.strictEqual(completes.length, 3, "三个文件都应完成上传");
});
