// rename_rule.js — 批量重命名的规则计算（1.4）。
//
// 独立成文件的原因：这是纯函数，无 DOM / 无宿主 API 依赖，
// 可用 node:test 直接跑单测（见 ui/rename_rule.test.js）。
//
// 规则作用顺序：正则替换 → 前缀 → 后缀 → 序号。
// 序号插在扩展名前："a.txt" + 序号 3 → "a_3.txt"。

(function (global) {
  "use strict";

  /**
   * 对单个文件名施加规则，返回新名字。
   * @param {string} base 原文件名（不含目录）
   * @param {{find?:string, replace?:string, prefix?:string, suffix?:string, seq?:number|null}} rule
   * @returns {string|null} 新名字；正则非法时返回 null
   */
  function renameApplyRule(base, rule) {
    let out = String(base == null ? "" : base);
    const r = rule || {};
    if (r.find) {
      let re;
      try {
        re = new RegExp(r.find, "g");
      } catch (e) {
        return null; // 正则非法
      }
      out = out.replace(re, r.replace || "");
    }
    if (r.prefix) out = r.prefix + out;
    if (r.suffix) out = out + r.suffix;
    if (r.seq !== null && r.seq !== undefined) {
      const dot = out.lastIndexOf(".");
      const hasExt = dot > 0;
      const stem = hasExt ? out.slice(0, dot) : out;
      const ext = hasExt ? out.slice(dot) : "";
      out = stem + "_" + r.seq + ext;
    }
    return out;
  }

  /**
   * 批量应用规则，seq 为自增序号起点。
   * @param {string[]} bases 文件名列表
   * @param {object} rule 同 renameApplyRule
   * @returns {{name:string, ok:boolean}[]} ok=false 表示正则非法
   */
  function renameApplyBatch(bases, rule) {
    const r = rule || {};
    const useSeq = r.seq !== null && r.seq !== undefined;
    let seq = useSeq ? r.seq : 0;
    return (bases || []).map((base) => {
      const next = renameApplyRule(base, {
        find: r.find, replace: r.replace, prefix: r.prefix, suffix: r.suffix,
        seq: useSeq ? seq++ : null,
      });
      return { name: next, ok: next !== null };
    });
  }

  global.RenameRule = { apply: renameApplyRule, applyBatch: renameApplyBatch };
})(typeof window !== "undefined" ? window : globalThis);
