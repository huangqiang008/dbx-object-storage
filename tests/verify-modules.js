// verify-modules.js — UI 模块化重构的完整性检查。
//
// 目的：证明「拆成多文件」没有丢东西、没有把不该跨模块的东西跨了。
//
// 检查项：
//   1. 导出完备性：所有被跨模块调用的函数都在提供方模块导出，且调用方用了 OB.xxx
//   2. 引用完备性：模块内出现的 OB.xxx 都能在某个模块里找到定义
//   3. 无残留：模块里不应出现未加 OB. 前缀的跨模块函数调用
//   4. 脚本顺序：index.html 的 script 顺序满足依赖（core.js 必须在最前）
//
// 运行：node ui/verify-modules.js

const fs = require("fs");
const path = require("path");

const UI = path.join(__dirname, "..", "ui");
const MODULES = ["core", "conn", "browse", "batch", "search", "meta", "transfer", "preview", "app"];

// 各模块自行从 window 解构的纯工具（utils.js / icons.js 是纯函数包，无状态依赖）。
// 它们不是 core 的导出，因此模块内裸调用是对的——检查器必须知道这一点。
const LOCAL_TOOLS = new Set(["esc", "formatSize", "fmtTime", "base64FromArrayBuffer", "b64ToBuffer", "svg", "$"]);

let errors = 0;
let warnings = 0;
const err = (m) => { console.error("  ✗ " + m); errors++; };
const warn = (m) => { console.warn("  ! " + m); warnings++; };

// ---------- 读取所有模块 ----------
const sources = {};
for (const m of MODULES) {
  const p = path.join(UI, m + ".js");
  if (!fs.existsSync(p)) { err(`缺少模块文件 ${m}.js`); continue; }
  sources[m] = fs.readFileSync(p, "utf8");
}

// ---------- 收集定义 ----------
// 导出：OB.foo = function / OB.foo = async function
const exportsBy = {};      // mod → Set(name)
const definedAnywhere = new Set();
for (const [mod, src] of Object.entries(sources)) {
  const set = new Set();
  const re = /\bOB\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/g;
  let m;
  while ((m = re.exec(src))) { set.add(m[1]); definedAnywhere.add(m[1]); }
  // core.js 里是 OB.foo = function(...) 的形式；conn.js 里有 OB.state = {...} 这类属性
  const re2 = /\bOB\.([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  while ((m = re2.exec(src))) { set.add(m[1]); definedAnywhere.add(m[1]); }
  const re3 = /\bOB\.([A-Za-z_$][\w$]*)\s*=\s*(?:\[\]|\{|new )/g;
  while ((m = re3.exec(src))) { set.add(m[1]); definedAnywhere.add(m[1]); }
  exportsBy[mod] = set;
}

// core.js 里的属性赋值（OB.state = {...} / OB.els = {...} / OB.$ = function ...）
{
  const re = /\bOB\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(sources.core))) { exportsBy.core.add(m[1]); definedAnywhere.add(m[1]); }
}

// ---------- 1. 引用完备性 ----------
console.log("【1】引用完备性：模块里用到的 OB.xxx 都有定义");
for (const [mod, src] of Object.entries(sources)) {
  const used = new Set();
  const re = /\bOB\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) {
    // 跳过注释行（注释里的 OB.xxx 是文档说明，不是真实引用）
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineText = src.slice(lineStart, m.index);
    if (/^\s*(\/\/|\*)/.test(lineText)) continue;
    used.add(m[1]);
  }
  for (const name of used) {
    if (LOCAL_TOOLS.has(name)) continue;
    if (!definedAnywhere.has(name)) {
      err(`${mod}.js 引用了未定义的 OB.${name}`);
    }
  }
}

// ---------- 2. 无残留：跨模块函数必须带 OB. 前缀 ----------
console.log("\n【2】无残留：跨模块函数调用都带 OB. 前缀");
for (const [mod, src] of Object.entries(sources)) {
  // 收集本模块顶层定义的函数名（非 OB. 赋值形式）
  const localFns = new Set();
  const reLocal = /^\s{2,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = reLocal.exec(src))) localFns.add(m[1]);

  // 找出所有裸函数调用（前面不是 . 也不是 OB.）
  // 逐行处理并跳过注释行——注释里提到的函数名不是调用
  const reCall = /(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
  const stripped = src
    .split("\n")
    .map((ln) => (/^\s*(\/\/|\*|\/\*)/.test(ln) ? "" : ln))
    .join("\n");
  while ((m = reCall.exec(stripped))) {
    const name = m[1];
    if (localFns.has(name)) continue;         // 本模块的局部函数，OK
    if (LOCAL_TOOLS.has(name)) continue;      // 各模块自解构的纯工具，OK
    if (definedAnywhere.has(name)) {
      // 这个名字是某个模块导出的函数 → 若是别的模块导出，裸调用就是残留
      const owners = MODULES.filter((mm) => exportsBy[mm] && exportsBy[mm].has(name));
      if (owners.length && !owners.includes(mod)) {
        err(`${mod}.js 中 ${name}() 是 ${owners.join("/")} 导出的，裸调用应改为 OB.${name}()`);
      }
    }
  }
}

// ---------- 3. 导出完备性：跨模块引用的函数都有导出 ----------
console.log("\n【3】导出完备性：跨模块引用的函数都已在提供方导出");
for (const [mod, src] of Object.entries(sources)) {
  const used = new Set();
  const re = /\bOB\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) used.add(m[1]);
  for (const name of used) {
    if (name in globalThis) continue;
    // 该名字应由某个模块导出（函数形式）
    const owners = MODULES.filter((mm) => exportsBy[mm] && exportsBy[mm].has(name));
    if (owners.length === 0) {
      // 可能是 core 的属性（state/els/$ 等），检查 core 是否以属性形式定义
      if (mod === "core") continue;
      const coreHas = new RegExp("\\bOB\\." + name + "\\s*=").test(sources.core || "");
      if (!coreHas) {
        err(`${mod}.js 调用 OB.${name}()，但没有模块导出它`);
      }
    }
  }
}

// ---------- 4. 脚本顺序 ----------
console.log("\n【4】脚本顺序：index.html 的 script 顺序满足依赖");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
console.log("  " + scripts.join(" → "));
const coreIdx = scripts.indexOf("core.js");
if (coreIdx < 0) {
  err("index.html 没有加载 core.js");
} else {
  // core.js 只需排在其它模块之前（utils/icons/i18n 等纯工具包可以更靠前）
  for (const m of MODULES) {
    if (m === "core") continue;
    const idx = scripts.indexOf(m + ".js");
    if (idx < 0) err(`index.html 没有加载 ${m}.js`);
    else if (idx < coreIdx) err(`${m}.js 排在 core.js 之前`);
  }
  const appIdx = scripts.indexOf("app.js");
  if (appIdx < 0) err("index.html 没有加载 app.js");
  else {
    for (const m of MODULES) {
      if (m === "app") continue;
      const idx = scripts.indexOf(m + ".js");
      if (idx > appIdx) err(`${m}.js 排在 app.js 之后（app.js 启动时会调用各模块）`);
    }
  }
}

// ---------- 5. 保留 main.js 的检查 ----------
console.log("\n【5】main.js 已下线");
if (fs.existsSync(path.join(UI, "main.js"))) {
  warn("main.js 仍然存在——确认已从 index.html 移除且不再被引用");
} else {
  console.log("  ✓ main.js 已移除");
}

// ---------- 汇总 ----------
console.log("");
if (errors) {
  console.error(`✗ ${errors} 个错误，${warnings} 个警告`);
  process.exit(1);
}
console.log(`✓ 全部检查通过（${warnings} 个警告）`);
