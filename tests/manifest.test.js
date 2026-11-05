// manifest.test.js — manifest 贡献声明的回归测试。
//
// 重点锁住 issue #8：插件要出现在 DBX「插件中心 → 设置 → 全局配置 → 显示的插件」
// 里，必须有 `command` + `menus` 的 appToolbar 摆放，且 default_visible 必须为 true。
//
// 宿主行为依据（t8y2/dbx，apps/desktop/src/lib/plugins/）：
//   - collectPluginShortcuts()：声明了 connection-provider 的插件，宿主不会自动把
//     它的 workbench 补进快捷栏（connected 集合 + bound 判定 → continue）。
//     唯一入口是 listToolbarMenuCommands() 收集到的 appToolbar / default_visible:true。
//   - PluginShortcutSettings.vue：「显示的插件」列表来自 allEntries 按 pluginId 去重。
//   - frontendPlugin.ts：appToolbar 项必须 default_visible === true 才被收集。
//   - manifest.rs：menus.group 必须在词表内；commandPalette 禁止 default_visible；
//     (location, command) 不可重复；command 引用的 workbench 必须存在。
//
// 运行：node --test tests/manifest.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const contributions = manifest.contributions || [];
const byType = (type) => contributions.filter((c) => c.type === type);
const byId = (id) => contributions.find((c) => c.id === id);

const MENU_GROUPS = ["navigation", "primary", "secondary", "destructive"];

test("声明了 connection-provider，必须靠显式 command 才能进插件快捷栏", () => {
  assert.equal(byType("connection-provider").length, 1);
  assert.equal(byType("command").length, 1, "连接型插件不会自动获得 workbench 快捷入口");
});

test("command 打开本插件已声明的 workbench，且为 tab 展示", () => {
  const cmd = byType("command")[0];
  assert.equal(cmd.action.type, "open-workbench");
  assert.equal(cmd.action.presentation, "tab");
  assert.equal(cmd.action.context && cmd.action.context.source, "shortcut",
    "快捷入口需携带 source 标记，前端据此显示连接引导横幅（A1）");
  const wb = byId(cmd.action.workbench);
  assert.ok(wb, "action.workbench 必须指向真实存在的 workbench");
  assert.equal(wb.type, "workbench");
  assert.equal(wb.id, "com.object.browser.main");
  assert.ok(manifest.entrypoints && manifest.entrypoints.ui, "command 要求插件有 UI entrypoint");
  assert.ok(fs.existsSync(path.join(ROOT, cmd.icon)), "command.icon 必须指向包内存在的资源");
});

test("menus 的 appToolbar 摆放是「显示的插件」开关的充要条件", () => {
  const menus = byType("menus");
  assert.equal(menus.length, 1);
  const toolbar = menus[0].items.find((i) => i.location === "appToolbar");
  assert.ok(toolbar, "缺 appToolbar 摆放 → 宿主不会把插件加进快捷栏");
  assert.equal(toolbar.default_visible, true, "appToolbar 默认隐藏，必须显式设 true");
  assert.equal(toolbar.command, byType("command")[0].id);
  assert.ok(MENU_GROUPS.includes(toolbar.group), "group 必须在宿主词表内");
  assert.equal(typeof toolbar.order, "number");
});

test("menus 里所有摆放引用有效、且不与宿主校验规则冲突", () => {
  const cmdId = byType("command")[0].id;
  const items = byType("menus")[0].items;
  const seen = new Set();
  for (const item of items) {
    assert.ok(["appToolbar", "appSidebar", "commandPalette"].includes(item.location));
    assert.equal(item.command, cmdId, "menus 只能引用同插件声明的 command");
    assert.ok(MENU_GROUPS.includes(item.group));
    assert.equal(typeof item.order, "number");
    if (item.location === "commandPalette") {
      assert.equal(item.default_visible, undefined, "commandPalette 不接受 default_visible");
    }
    const key = item.location + ":" + item.command;
    assert.ok(!seen.has(key), "同一 (location, command) 不可重复");
    seen.add(key);
  }
});

test("新贡献有 zh-CN 本地化", () => {
  const cmdId = byType("command")[0].id;
  const loc = manifest.localizations && manifest.localizations["zh-CN"];
  assert.ok(loc && loc.contributions && loc.contributions[cmdId], "命令名需中文，否则中文宿主显示英文");
  assert.ok(loc.contributions[cmdId].label);
});

test("engines.dbx 精确等于 0.6.21，不能抬高", () => {
  // 宿主 Rust 侧 PluginContribution 枚举在 v0.6.21 才加入 Command / Menus 变体。
  // 低于该版本：未知 contribution type → 整个 manifest 反序列化失败。
  // 高于该版本：宿主把插件判 incompatible，listContributions() 会过滤掉全部贡献，
  // 连「新建连接」对话框里的连接类型都会消失（0.6.2x 用户被误伤）。
  assert.equal(manifest.engines.dbx, ">=0.6.21");
});

test("新建连接入口不受快捷入口影响：connection-provider 完整且仍绑定 workbench", () => {
  // ConnectionDialog.vue 的插件类型列表来自 listConnectionProviders()，
  // 与 command / menus 是独立贡献链。宿主只会过滤 compatibility.compatible === false 的插件。
  const providers = byType("connection-provider");
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.id, "com.object.browser.connection");
  assert.equal(p.database_type, "oss");
  assert.equal(p.workbench, "com.object.browser.main", "连接提供者必须仍绑定工作台");
  assert.ok(byId(p.workbench), "引用的 workbench 必须存在");
  assert.deepEqual(p.capabilities, ["test", "connect", "disconnect"]);
  assert.ok(Array.isArray(p.fields) && p.fields.length > 0, "连接表单字段不能丢");
  assert.ok(p.fields.some((f) => f.key === "endpoint" && f.required), "endpoint 必填");
  assert.ok(p.fields.some((f) => f.key === "access_key_secret" && f.binding === "secret"), "Secret 必须走宿主密钥托管");
});

test("四处版本号一致（manifest / backend / UI BUILD / README 徽章）", () => {
  const oss = fs.readFileSync(path.join(ROOT, "backend", "oss.go"), "utf8");
  const core = fs.readFileSync(path.join(ROOT, "ui", "core.js"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const v = manifest.version;
  assert.match(oss, new RegExp('const pluginVersion = "' + v.replace(/\./g, "\\.") + '"'));
  assert.match(core, new RegExp('OB\\.BUILD = "' + v.replace(/\./g, "\\.") + '"'));
  assert.ok(readme.includes("badge/version-" + v + "-blue"));
});
