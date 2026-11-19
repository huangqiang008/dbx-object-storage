// no-cdn.test.js — 守护「前端零外部请求」这条约束。
//
// 宿主沙箱的 CSP 不放行任何外部域名：桌面端 script-src 只有 'unsafe-inline'
// blob: 与插件自身资产源（且 default-src 'none'），开发宿主是 'self'
// 'unsafe-inline' blob:，Web 端是 'self' 'unsafe-inline'；style-src 同样只放行
// 内联与 blob。connect-src 默认 'none'，只有声明 host.network 才按 origin 放行。
// 即外部 script/style 在任何宿主形态、任何权限组合下都加载不了，写了就是死代码
//（官方文档亦明确：不要把 Vite dev server 或 CDN 的脚本地址写进发行包）。
// ui/fileviewer 与 ui/o3dv 是构建产物，README 记载其构建后必须 grep 校验零 CDN；
// 这里覆盖 ui/ 下的自有源码，避免 cdnjs 之类的回退分支被重新加回来。

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
    "发现外部 URL 引用（宿主沙箱 CSP 的 script-src/style-src 不放行外部域，加载必失败）：\n  " +
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
