/**
 * CLIS 服务的**统一探测口径**。
 *
 * ## 为什么单独抽一个模块
 *
 * 有两处必须对"CLIS 分类器可不可用"给出**同一个答案**：
 *
 * 1. `src/health.js` 的探针 —— 报"CLIS 可用 / 不可用"
 * 2. `src/tools.js` 的工具路径 —— 决定要不要走因果判断
 *
 * 它们判的不是两件事，是**同一件事**。上一版两处各写一套：
 * 探针只判 `get('clis.causalClassifier') !== undefined`（存在即可），
 * 工具路径走库的 `pick()`（要求 `typeof raw.classify === 'function'`）。
 * 于是同一个宿主上，探针说"CLIS 可用"、工具说"分类器不可用" ——
 * **探针与它监督的对象对同一件事给出相反结论**。
 *
 * ## 判据**直接用库自己的**，不抄一遍
 *
 * 库的 `resolveClisServices()` → `pick()` 判"可用"要四件事同时成立：
 * ctx 上有 `get`、`get` 不抛错、取到的是对象、**且 `typeof raw.classify === 'function'`**。
 *
 * 本模块直接调用库的 `resolveClisServices(ctx)` —— 不复刻、不抄。
 * 抄一份迟早会漂（库里改了方法名就完了），而直接调用**不可能漂**：
 * 探针与工具路径跑的是同一段代码。
 *
 * ## 但本模块比库多说一句话：为什么不可用
 *
 * 库的 `pick()` 把所有失败都压成 `undefined`，于是"没装"与"查询时抛了"
 * 无法区分。本模块保留**原因**（`probeClassifier()`），
 * 供工具如实转述 —— 排查方向完全不同：前者查安装，后者查宿主集成。
 */

import { resolveClisServices } from '@causal-layers/meta-framework';

/**
 * CLIS 分类器服务名。
 *
 * 与库的 `CLIS_SERVICE_NAMES.classifier` 同源（`clis.causalClassifier`）。
 * 这里写死是为了让本模块的**可观测**部分（原因分类）不依赖额外导出；
 * `test/clis-rule.test.js` / `test/health.test.js` 会把它钉在契约包的真实值上。
 */
export const CAUSAL_CLASSIFIER_SERVICE = 'clis.causalClassifier';

/** 分类器必须提供的方法名 —— 与库的 `pick()` 判据逐字一致。 */
export const CLASSIFIER_METHOD = 'classify';

/**
 * 分类器不可用的**具体原因**分类。
 *
 * - `available` —— 可用
 * - `absent` —— 服务不存在（没装 / 没注册）—— 查安装
 * - `malformed` —— 服务在，但形状不对（缺 `classify()`）—— 查版本
 * - `lookup-failed` —— 查询过程抛错 —— 查宿主集成
 */
export const UNAVAILABLE_KINDS = {
  available: 'available',
  absent: 'absent',
  malformed: 'malformed',
  lookupFailed: 'lookup-failed',
};

/**
 * 按**库的口径**取分类器服务。
 *
 * 判据来自库的 `resolveClisServices()` —— 不在这里复刻。
 *
 * @param ctx — 宿主上下文。
 * @returns 可用则返回服务对象，否则 undefined。
 */
export function pickClassifier(ctx) {
  if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined;
  let services;
  try {
    services = resolveClisServices(ctx);
  } catch {
    // 库的 `pick()` 本身不抛（它 catch 住 get 的异常），但防御性兜底。
    return undefined;
  }
  return services.classifier;
}

/**
 * 探测分类器，**并说明为什么不可用**。
 *
 * 可用性判据与 `pickClassifier()` 完全一致（同一个库函数），
 * 这里只多给出**原因**。
 *
 * @param ctx — 宿主上下文。
 * @returns `{available, kind, reason}`；`reason` 只在不可用时给出。
 */
export function probeClassifier(ctx) {
  if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') {
    return {
      available: false,
      kind: UNAVAILABLE_KINDS.absent,
      reason: '宿主上下文没有 get()，无法查询 CLIS 分类服务。',
    };
  }

  let raw;
  try {
    raw = ctx.get(CAUSAL_CLASSIFIER_SERVICE);
  } catch (error) {
    // **查询抛错** —— 与"没装"是两回事，排查方向不同。
    return {
      available: false,
      kind: UNAVAILABLE_KINDS.lookupFailed,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (raw === undefined || raw === null) {
    return { available: false, kind: UNAVAILABLE_KINDS.absent, reason: undefined };
  }
  if (typeof raw !== 'object') {
    return {
      available: false,
      kind: UNAVAILABLE_KINDS.malformed,
      reason: `CLIS 分类服务返回的不是对象（${typeof raw}）。`,
    };
  }
  if (typeof raw[CLASSIFIER_METHOD] !== 'function') {
    return {
      available: false,
      kind: UNAVAILABLE_KINDS.malformed,
      reason: `CLIS 分类服务缺少 ${CLASSIFIER_METHOD}() 方法，形状不符合契约。`,
    };
  }

  // 形状都对 —— 再用**库自己**的判据确认一次（唯一实现，不可能漂）。
  if (pickClassifier(ctx) === undefined) {
    return {
      available: false,
      kind: UNAVAILABLE_KINDS.malformed,
      reason: 'CLIS 分类服务形状正确，但库的服务解析认为它不可用。',
    };
  }

  return { available: true, kind: UNAVAILABLE_KINDS.available, reason: undefined };
}
