// scan.js — 通用分页累积引擎（1.3，A2）。
//
// 把「沿 marker 游标把一个前缀的所有页拉完」这件事抽成可注入的纯逻辑：
// 上限截断、取消探测、进度回调都在这里，调用方只提供 fetchPage。
// 使用方：browse.js 的「扫描全部并排序」（A2）；后续全量选择（B2）可复用。
//
// 本文件是经典 script 模块：挂 window.Scan 独立命名空间（与 utils.js / icons.js
// 同风格，纯逻辑无状态依赖）。宿主 UI 跑在 origin=null 的沙箱 iframe 里，
// ES Module 不可用，必须保持经典 script + 全局命名空间。

(function (global) {
  "use strict";

  const Scan = {};

  // collect 分页累积。
  //
  // opts.fetchPage(marker)  必填。返回 { items, isTruncated, nextMarker }；
  //                         items 为本页条目数组，nextMarker 为空表示没有下一页。
  // opts.limit              总条数上限，达到即停止并置 truncated（默认 20000，
  //                         与深度搜索的结果上限一致，防止失控）。
  // opts.onProgress(loaded) 每页回调（可选）。抛错只被吞掉，不影响扫描本身。
  // opts.isCancelled()      取消探测（可选）。返回 true 时立即停止，已拉到的
  //                         条目原样返回（调用方自行决定丢弃或使用）。
  //
  // 返回 { items, truncated, cancelled }：
  //   truncated = 触达 limit 上限（结果不含全部对象，调用方必须明示）；
  //   cancelled = 被取消（如目录已切换、用户中止）。
  //
  // 边界：达到上限时可能多拉了最后一页（fetchPage 的粒度是整页），
  // 超出 limit 的条目不会进入结果——用上限裁剪而不是精确匹配页大小，
  // 是为了对「每页条数」不敏感。
  Scan.collect = async function collect(opts) {
    const o = opts || {};
    if (typeof o.fetchPage !== "function") throw new Error("Scan.collect: fetchPage is required");
    const limit = Number.isFinite(o.limit) && o.limit > 0 ? Math.floor(o.limit) : 20000;
    const items = [];
    let marker = "";
    let truncated = false;
    let cancelled = false;
    while (true) {
      if (o.isCancelled && o.isCancelled()) { cancelled = true; break; }
      if (items.length >= limit) { truncated = true; break; }
      const page = await o.fetchPage(marker);
      const list = (page && page.items) || [];
      for (let i = 0; i < list.length; i++) {
        if (items.length >= limit) { truncated = true; break; }
        items.push(list[i]);
      }
      if (o.onProgress) {
        try { o.onProgress(items.length); } catch (e) { /* 进度回调不影响扫描 */ }
      }
      if (truncated) break;
      if (!page || !page.isTruncated || !page.nextMarker) break;
      marker = page.nextMarker;
    }
    return { items, truncated, cancelled };
  };

  global.Scan = Scan;
})(window);
