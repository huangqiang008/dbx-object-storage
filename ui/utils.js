// utils.js — 纯工具函数（无业务状态依赖）。
//
// 独立成文件的原因：这些函数只依赖标准 Web API，不触碰 main.js 里的
// state / els / invoke，因此可以零风险抽出。集中放置也让"格式化 / 转义"
// 这类横切关注点不再散落在业务代码各处以至于被误改。

(function (global) {
  "use strict";

  // esc HTML 转义。所有插入 innerHTML 的动态文本都必须过这里，
  // 否则对象名里的 < > & " 会破坏结构甚至注入脚本。
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // formatSize 人类可读字节数。边界用 1024 递进制。
  function formatSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(2) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  // fmtTime RFC3339 → 本地时间字符串；无法解析时原样返回（不丢信息）。
  function fmtTime(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d)) return s;
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // base64FromArrayBuffer ArrayBuffer → base64。
  // 分块 0x8000 是因为 String.fromCharCode.apply 一次传入的参数过多会爆栈。
  function base64FromArrayBuffer(buf) {
    let s = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  // b64ToBuffer base64 → Uint8Array（预览读回路径使用）。
  // 按长度一次分配再逐字符写入，避免多次扩容带来的中间拷贝。
  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  global.Utils = { esc, formatSize, fmtTime, base64FromArrayBuffer, b64ToBuffer };
})(window);
