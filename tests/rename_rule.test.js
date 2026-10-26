// rename_rule.test.js — 批量重命名规则的单元测试。
//
// 运行：node --test ui/rename_rule.test.js
// 用 Node 内置 test runner，零外部依赖。

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// 加载被测模块（IIFE 挂到 globalThis）
require(path.join(__dirname, "..", "ui", "rename_rule.js"));
const { apply, applyBatch } = globalThis.RenameRule;

test("前缀规则", () => {
  assert.strictEqual(apply("a.txt", { prefix: "2026_" }), "2026_a.txt");
});

test("后缀规则", () => {
  assert.strictEqual(apply("a.txt", { suffix: "_bak" }), "a.txt_bak");
});

test("正则替换", () => {
  assert.strictEqual(apply("report-2024.pdf", { find: "\\d{4}", replace: "2026" }), "report-2026.pdf");
});

test("正则无匹配时原样返回", () => {
  assert.strictEqual(apply("a.txt", { find: "zzz", replace: "x" }), "a.txt");
});

test("非法正则返回 null", () => {
  assert.strictEqual(apply("a.txt", { find: "([", replace: "x" }), null);
});

test("序号插在扩展名前", () => {
  assert.strictEqual(apply("a.txt", { seq: 3 }), "a_3.txt");
});

test("序号作用于无扩展名文件", () => {
  assert.strictEqual(apply("README", { seq: 2 }), "README_2");
});

test("规则按 正则→前缀→后缀→序号 顺序作用", () => {
  // "a.txt" → 正则 a→b → "b.txt" → 前缀 → "p_b.txt"
  //            → 后缀 → "p_b.txt_s" → 序号插在扩展名前 → "p_b_1.txt_s"
  const out = apply("a.txt", { find: "a", replace: "b", prefix: "p_", suffix: "_s", seq: 1 });
  assert.strictEqual(out, "p_b_1.txt_s");
});

test("批量应用时序号自增", () => {
  const res = applyBatch(["a.txt", "b.txt", "c.txt"], { seq: 1 });
  assert.deepStrictEqual(res.map((r) => r.name), ["a_1.txt", "b_2.txt", "c_3.txt"]);
});

test("批量应用中正则非法时该项 ok=false", () => {
  const res = applyBatch(["a.txt", "b.txt"], { find: "(", replace: "x" });
  assert.strictEqual(res[0].ok, false);
  assert.strictEqual(res[1].ok, false);
});

test("空规则返回原名", () => {
  assert.strictEqual(apply("a.txt", {}), "a.txt");
});

test("seq 为 null 时不加序号", () => {
  assert.strictEqual(apply("a.txt", { seq: null }), "a.txt");
});
