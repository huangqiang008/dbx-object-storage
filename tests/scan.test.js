// scan.test.js — scan.js（通用分页累积引擎，A2）的纯逻辑单测。
//
// scan.js 只依赖 window 全局、无 DOM 依赖，用 vm 直接加载后测核心语义：
//   1. 缺 fetchPage 报错
//   2. 单页/多页累积与 nextMarker 串联
//   3. limit 截断（truncated=true，超出上限的条目不进结果）
//   4. 取消探测（已拉到的条目原样返回）
//   5. onProgress 每页回调、抛错被吞掉
//   6. fetchPage 抛错向上传播（调用方负责展示失败）
//
// 运行：node --test tests/scan.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "ui", "scan.js"), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const Scan = sandbox.window.Scan;

function pages(defs) {
  // defs: [{ items, truncated, nextMarker }] — 按调用顺序返回
  let call = 0;
  const seen = [];
  const fetchPage = async (marker) => {
    seen.push(marker);
    const d = defs[call++];
    if (!d) throw new Error("no more pages");
    return { items: d.items, isTruncated: d.truncated, nextMarker: d.nextMarker };
  };
  return { fetchPage, seen, calls: () => call };
}

test("缺 fetchPage 报错", async () => {
  await assert.rejects(() => Scan.collect({}), /fetchPage is required/);
  await assert.rejects(() => Scan.collect({ fetchPage: "no" }), /fetchPage is required/);
});

test("单页：无截断无下一页，条目原样返回", async () => {
  const p = pages([{ items: ["a", "b"], truncated: false, nextMarker: "" }]);
  const r = await Scan.collect({ fetchPage: p.fetchPage });
  assert.deepEqual(r, { items: ["a", "b"], truncated: false, cancelled: false });
  assert.equal(p.calls(), 1);
});

test("多页：nextMarker 逐页串联", async () => {
  const p = pages([
    { items: ["a"], truncated: true, nextMarker: "m1" },
    { items: ["b", "c"], truncated: true, nextMarker: "m2" },
    { items: ["d"], truncated: false, nextMarker: "" },
  ]);
  const r = await Scan.collect({ fetchPage: p.fetchPage });
  assert.deepEqual(r.items, ["a", "b", "c", "d"]);
  assert.equal(r.truncated, false);
  assert.deepEqual(p.seen, ["", "m1", "m2"]);
});

test("limit 截断：超出上限的条目不进结果", async () => {
  const p = pages([
    { items: [1, 2, 3], truncated: true, nextMarker: "m1" },
    { items: [4, 5, 6, 7], truncated: true, nextMarker: "m2" },
  ]);
  const r = await Scan.collect({ fetchPage: p.fetchPage, limit: 5 });
  assert.deepEqual(r.items, [1, 2, 3, 4, 5]);
  assert.equal(r.truncated, true);
  // 达到上限后不再拉下一页
  assert.equal(p.calls(), 2);
});

test("limit 截断：整页跨过上限时在条目级裁剪", async () => {
  const p = pages([
    { items: [1, 2], truncated: true, nextMarker: "m1" },
    { items: [3, 4, 5], truncated: false, nextMarker: "" },
  ]);
  const r = await Scan.collect({ fetchPage: p.fetchPage, limit: 4 });
  assert.deepEqual(r.items, [1, 2, 3, 4]);
  assert.equal(r.truncated, true);
});

test("取消探测：已拉到的条目原样返回", async () => {
  let n = 0;
  const p = pages([
    { items: ["a"], truncated: true, nextMarker: "m1" },
    { items: ["b"], truncated: true, nextMarker: "m2" },
  ]);
  const r = await Scan.collect({
    fetchPage: p.fetchPage,
    isCancelled: () => (n++ > 0), // 第二轮取消
  });
  assert.deepEqual(r.items, ["a"]);
  assert.equal(r.cancelled, true);
  assert.equal(r.truncated, false);
});

test("onProgress：每页回调累计条数，抛错被吞掉", async () => {
  const seen = [];
  const p = pages([
    { items: ["a"], truncated: true, nextMarker: "m1" },
    { items: ["b", "c"], truncated: false, nextMarker: "" },
  ]);
  const r = await Scan.collect({
    fetchPage: p.fetchPage,
    onProgress: (loaded) => { seen.push(loaded); throw new Error("progress boom"); },
  });
  assert.deepEqual(seen, [1, 3]);
  assert.deepEqual(r.items, ["a", "b", "c"]);
  assert.equal(r.cancelled, false);
});

test("fetchPage 抛错向上传播", async () => {
  const fetchPage = async () => { throw new Error("rpc down"); };
  await assert.rejects(() => Scan.collect({ fetchPage }), /rpc down/);
});

test("page 缺 items / 缺 isTruncated 的宽容处理", async () => {
  // 无 isTruncated（或 falsy page）视为最后一页：不报错、把已拉到的条目返回
  let call = 0;
  const fetchPage = async () => {
    call++;
    return call === 1 ? { items: ["x"] } : {};
  };
  const r = await Scan.collect({ fetchPage });
  assert.deepEqual(r.items, ["x"]);
  assert.equal(r.truncated, false);
  // 空对象页（无 items）：等同空最后一页，结果为空但不抛错
  const r2 = await Scan.collect({ fetchPage: async () => ({}) });
  assert.deepEqual(r2.items, []);
  assert.equal(r2.truncated, false);
});
