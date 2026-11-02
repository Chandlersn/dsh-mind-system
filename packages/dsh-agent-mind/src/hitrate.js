/**
 * 调度命中率自测 —— 用**真实用户输入**衡量调度是否真的起作用。
 *
 * ## 为什么必须有它（2026-11-02 客观审查的结论）
 *
 * 审查发现：拿本会话 10 条真实输入实测，调度**只判对 4 条**，
 * 其余落 `unknown`（= 不做重排、走默认顺序）。
 *
 * 而当时 mind 的探针报的是 `mind.no-signal`，我把它解释成
 * "本轮无信号是正常状态，不是故障" —— **那句话站不住**：
 * 高频的 no-signal 不是正常，是失灵。这正是「绿灯不携带信息」那条道
 * 描述的病症：读数（no-signal）看着正常，掩盖了命中率低这个事实。
 *
 * 所以自测的产物不是"判对了几条"这句话，而是一个**可读的比率**，
 * 让人和探针都能看见命中率。命中率低 → 词表不行 → 去修词表，
 * 而不是"本轮恰好没信号"。
 *
 * ## 基准从哪来
 *
 * 记忆根的**每日原始层**里有「用户原话」字段 —— 那是真实指令，
 * 不是我们编的样例。用它当基准，才不会把"我们自己造的样本"当成
 * "真实使用"。
 *
 * @module src/hitrate
 */

import { explainSituation } from './dispatch.js';

/**
 * 一条基准样本。
 *
 * @typedef {object} BenchmarkSample
 * @property {string} text 输入文本。
 * @property {string} expect 期望的处境（空串表示"不预设，判什么都算命中"）。
 * @property {string} source 样本来源（哪个文件、哪一行）。
 */

/**
 * 算命中率。
 *
 * ## 判据口径
 *
 * - `expect` 非空 → 判成该处境才算命中
 * - `expect` 为空 → **只要求判出某个具体处境**（不算 unknown）。
 *   理由：真实用户原话里大量是"继续完善其他层级"这种没有单一标签的，
 *   若要求精确标签，基准会失真；但"完全没信号"仍然是明确的失败。
 *
 * @param samples 基准样本。
 * @returns 统计结果。
 */
export function hitRate(samples) {
  const total = Array.isArray(samples) ? samples.length : 0;
  let hit = 0;
  let missed = 0;
  let unknown = 0;
  const misses = [];
  const unknowns = [];

  for (const s of samples ?? []) {
    const d = explainSituation(s.text);
    if (d.unknown) {
      unknown += 1;
      unknowns.push({ text: s.text, source: s.source });
      continue;
    }
    if (s.expect === '' || d.situation === s.expect) {
      hit += 1;
    } else {
      missed += 1;
      misses.push({ text: s.text, expected: s.expect, got: d.situation, source: s.source });
    }
  }

  return {
    total,
    hit,
    missed,
    unknown,
    // 命中率只算"判出具体处境"的部分 —— unknown 是失灵，不是判错。
    rate: total === 0 ? null : hit / total,
    unknownRate: total === 0 ? null : unknown / total,
    misses,
    unknowns,
  };
}

/**
 * 从每日记录里抽用户输入作为基准样本。
 *
 * ## 为什么抽这个字段
 *
 * 每日记录里明确区分了"用户原话"与其他内容（判断、踩坑、执行流水）。
 * 只有用户原话是**真实输入**，其余是我们自己的转述 —— 用转述当基准
 * 等于自己给自己出题再自己判卷。
 *
 * ## 为什么不止一种写法
 *
 * 只认「**用户原话**」字段时，实测 11 份每日记录只抽出 **1 条** ——
 * 基准几乎不存在，命中率无从谈起。用户输入在记录里有好几种写法，
 * 都要收：
 *
 * - `**用户原话**：「…」`（显式字段）
 * - `用户原话：「…」`
 * - `用户问「…」` / `用户追问「…」`
 *
 * ## 排除项
 *
 * **任何 `「…」` 都不收** —— 实测有 58 处，但绝大多数是**我们引用自己的
 * 判据**（如「伪造不了的那一面」）。把判据当用户输入 = 自己出题自己判卷。
 *
 * ## 抽不出样本时返回空数组
 *
 * 不猜、不编：基准缺失本身是信息 —— 它说明"没有真实样本可测"。
 *
 * @param dailyText 每日记录全文（可多份拼接）。
 * @returns 基准样本（expect 一律留空：真实原话没有标准答案）。
 */
export function extractUserQuotes(dailyText) {
  const samples = [];
  const lines = String(dailyText ?? '').split('\n');
  const seen = new Set();
  // 三种明确指向用户输入的写法
  const patterns = [
    /\*\*用户原话\*\*[：:]\s*[「『"'](.+?)[」』"']/u,
    /用户原话[：:]\s*[「『"'](.+?)[」』"']/u,
    /用户(?:问|追问|说|要求|指示|指令)[：:]?\s*[「『"'](.+?)[」』"']/u,
  ];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      const text = m[1].trim();
      if (text.length < 6) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      samples.push({ text, expect: '', source: `第 ${i + 1} 行` });
      break;
    }
  }
  return samples;
}

/**
 * 把命中率结果压成一句可读的判断。
 *
 * @param r 命中率结果。
 * @param threshold 低于此值算"失灵"。
 * @returns 一行文本。
 */
export function hitRateLine(r, threshold = 0.6) {
  if (r.total === 0) return '调度基准：无真实样本可测（每日记录里没有「用户原话」字段）—— 命中率无从谈起';
  const rate = (r.rate * 100).toFixed(0);
  const unk = (r.unknownRate * 100).toFixed(0);
  const verdict = r.rate < threshold ? `低于阈值 ${(threshold * 100).toFixed(0)}% —— 调度基本失灵` : '达到阈值';
  return `调度命中率 ${rate}%（${r.hit}/${r.total}，判错 ${r.missed}，无信号 ${unk}%）—— ${verdict}`;
}
