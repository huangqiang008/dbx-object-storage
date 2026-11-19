// no-cdn.test.js — 守护「前端零外部请求」这条约束。
//
// 插件沙箱按 manifest.permissions 施加 CSP；本插件未声明 host.network，
// 任何对外部域的 script/style/fetch 都会被拦掉。除了必然失败之外，这类引用
// 还有供应链风险（从第三方 CDN 拉可执行 JS）。ui/fileviewer 与 ui/o3dv 是
// 构建产物，README 记载其构建后必须 grep 校验零 CDN；这里覆盖 ui/ 下的
// 自有源码，避免 cdnjs 之类的回退分支被重新加回来。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const UI = path.join(__dirname, "..", "ui");

// 只检查自有源码：vendor/、fileviewer/、o3dv/ 是第三方构建产物，单独治理
//（见 README「file-viewer 预览资源重建」）。
const OWN_FILES = fs.readdirSync(UI).filter(
  (f) => /\.(js|html|css)$/.test(f)
);

// 允许的域：连接表单里的厂商 endpoint 示例、帮助文案里的占位符与本机地址，
// 都不是运行时请求目标。
const ALLOWED_HOSTS = [
  "aliyuncs.com",
  "myqcloud.com",
  "myhuaweicloud.com",
  "amazonaws.com",
  "cloudflarestorage.com",
  "wasabisys.com",
  "backblazeb2.com",
  "example.com",
  "e.com",
  "self.signed",
  "endpoint", // 帮助文案占位符：http://endpoint/bucket/key
  "account-id", // R2 示例：https://<account-id>.r2.cloudflarestorage.com
  "127.0.0.1",
  "192.168.1.10",
  "localhost",
  "w3.org",
  "schemas.microsoft.com",
];

const URL_RE = /https?:\/\/([a-zA-Z0-9._-]+)/g;

test("ui/ 自有源码不引用外部 CDN", () => {
  assert.ok(OWN_FILES.length > 10, `应扫到 ui/ 下的自有文件，实际 ${OWN_FILES.length}`);

  const offenders = [];
  for (const f of OWN_FILES) {
    const src = fs.readFileSync(path.join(UI, f), "utf8");
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(src)) !== null) {
      const host = m[1];
      if (!ALLOWED_HOSTS.some((a) => host === a || host.endsWith("." + a))) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "发现外部 URL 引用（未声明 host.network，请求必被 CSP 拦截；且构成供应链风险）：\n  " +
      offenders.join("\n  ")
  );
});

test("markdown/高亮资产只走包内本地路径", () => {
  const src = fs.readFileSync(path.join(UI, "preview.js"), "utf8");
  const m = src.match(/MD_ASSETS\s*=\s*\{[\s\S]*?\};/);
  assert.ok(m, "应能找到 MD_ASSETS 定义");
  const block = m[0];
  for (const key of ["marked", "hljs", "hljsCss"]) {
    assert.ok(block.includes(key), `MD_ASSETS 应含 ${key}`);
  }
  assert.ok(
    !/https?:/.test(block),
    "MD_ASSETS 不应含任何绝对 URL（只能是包内相对路径）"
  );
  // 本地资产必须真实存在，否则预览会静默降级为纯文本
  for (const rel of block.match(/"([^"]+\.(?:js|css))"/g) || []) {
    const p = path.join(UI, rel.slice(1, -1));
    assert.ok(fs.existsSync(p), `包内资产应存在: ${rel.slice(1, -1)}`);
  }
});
