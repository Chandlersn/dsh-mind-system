/**
 * 测试用的**真实 CLIS 判据**加载器。
 *
 * ## 为什么要这个文件
 *
 * 缺陷 2：`test/tools.test.js` 里的 mock 分类器**手写**了一份四问→类型的规则，
 * 而真实规则住在 `dsh-clis` 的 `chunk-2HMO3QIV.js` 里（`decide()` 函数）。
 *
 * 两份规则对不上 —— 已实测 81 种组合里 **14 种**给出不同结论。
 * 手写的那份在"2 个以上 yes"时全错（它按 Q1→Q2→Q3 短路取第一个），
 * 而真实规则是"2 个以上 yes ⇒ nested（结构冲突）"。
 *
 * 举例：`{q1: yes, q2: yes, q3: no, q4: no}`
 *   - 真实 CLIS → `nested`
 *   - 手写 mock → `cyclic`
 *
 * ## 本文件的做法
 *
 * **两份都要**：
 *
 * 1. `decideType()` —— 忠实复刻真实规则，供 mock 分类器直接调用。
 *    （不能直接 import 真实模块当 mock 用：真实 `classifyProblem` 是**校验器**，
 *    作答不合约时它会抛 `ClisContractError` —— 而 mock 的职责是"把四问映射成类型"，
 *    两者职责不同。所以复刻规则，但用真实实现做**逐条比对**。）
 *
 * 2. `loadRealClassifier()` —— 加载**真正的** `dsh-clis` 实现，
 *    供 `clis-rule.test.js` 做 81 种组合的穷举比对。
 *
 * ## 加载真实实现为什么要造假安装根
 *
 * `dsh-clis/chunk-DC3YUXV4.js` 在**模块顶层**就执行
 * `var host = loadHost("@deepseek-ai/cordis")` —— 找不到 DSH 安装目录
 * 就抛错，模块根本 import 不了。
 *
 * 而那个包的判定依据是 `<root>/node_modules/@deepseek-ai/cordis/package.json`
 * 存在。所以这里造一个**最小假安装根**（只要 cordis 的 package.json +
 * 一个导出 `Service`/`Context`/`symbols`/`Fiber`/`RegistryService`/`Inject`
 * 的 index.js），把 `DSH_INSTALL_DIR` 指过去，就能把真实现完整加载起来。
 *
 * 这个假根只满足"能被 require 到"，不提供任何功能 —— 被加载的
 * `chunk-2HMO3QIV.js` 里真正用到的只是纯函数 `classifyProblem`。
 *
 * ## 找不到兄弟包时**必须失败**，不能静默跳过
 *
 * 静默跳过 = 一个**假装绿**的闸门：跑的人以为"漂移已被守住"，其实没跑。
 * 所以这里明确抛错，并说清原因与解法。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 兄弟包 `dsh-clis` 的入口（分类器子路径）。 */
export const REAL_CLIS_MODULE = new URL('../../clis/clis-classifier.js', import.meta.url);

/** 兄弟包 `dsh-clis` 的内部 chunk（`classifyProblem` 真正住在这里）。 */
export const REAL_CLIS_CHUNK = new URL('../../clis/chunk-2HMO3QIV.js', import.meta.url);

/**
 * 契约里的四种确定类型 + unknown。
 *
 * 与 `dsh-clis` 的 `KNOWN_CAUSAL_TYPES` 一致。
 */
export const KNOWN_CAUSAL_TYPES = [
  'structural_duality',
  'cyclic',
  'unidirectional',
  'nested',
];

/** 四问在契约里的字段名 → 它 resolve 到的类型。 */
export const ANSWER_KEYS = {
  q1_simultaneous_mutual_definition: 'structural_duality',
  q2_delayed_mutual_influence: 'cyclic',
  q3_strict_irreversible_order: 'unidirectional',
  q4_coexisting_causal_structures: 'nested',
};

/** 四问的工具参数键名 → 契约字段名。 */
export const SHORT_TO_LONG = {
  q1: 'q1_simultaneous_mutual_definition',
  q2: 'q2_delayed_mutual_influence',
  q3: 'q3_strict_irreversible_order',
  q4: 'q4_coexisting_causal_structures',
};

/** 三态取值。 */
export const TRI_STATES = ['yes', 'no', 'unknown'];

/**
 * 忠实复刻真实 CLIS 的四问→类型规则。
 *
 * ## 真实规则（`dsh-clis/chunk-2HMO3QIV.js` 的 `decide()`）
 *
 * ```
 * Q4 = yes              → nested          （R1：系统内多种结构并存）
 * Q4 ≠ yes 且 Q1..Q3 恰好一个 yes → 该唯一类型（R2）
 * Q4 ≠ yes 且 Q1..Q3 两个以上 yes → nested（R3：结构冲突）
 * 没有任何 yes         → unknown         （R4：不强行归类）
 * ```
 *
 * ## 为什么"两个以上 yes"是 nested 而不是取第一个
 *
 * 旧 mock 用 `Q4 ? nested : Q2 ? cyclic : Q1 ? duality : Q3 ? unidirectional : unknown`
 * —— 短路取**第一个** yes。那在"两个 yes"时给出的是某一个具体类型，
 * 而真实规则认定那是**结构冲突**（同时符合两种结构 ⇒ 嵌套），判 `nested`。
 *
 * 这不是措辞差异 —— 它直接决定下游 `customize()` 给哪种关注点，
 * 也决定 `select()` 走哪套策略族。判错方向，诊断结论就反了。
 *
 * @param answers — 四问作答（工具参数键名 `q1`–`q4`，或契约长名）。
 * @returns 因果类型字符串。
 */
export function decideType(answers) {
  const read = (shortKey) => {
    const longKey = SHORT_TO_LONG[shortKey] ?? shortKey;
    const value = answers?.[shortKey] ?? answers?.[longKey];
    return value === 'yes' ? 'yes' : value === 'no' ? 'no' : 'unknown';
  };

  // R1：Q4=yes 直接判嵌套（优先级最高）
  if (read('q4') === 'yes') return 'nested';

  // Q1..Q3 里的肯定回答
  const positives = ['q1', 'q2', 'q3']
    .filter((key) => read(key) === 'yes')
    .map((key) => ANSWER_KEYS[SHORT_TO_LONG[key]]);

  // R2：恰好一个 → 那个类型
  if (positives.length === 1) return positives[0];
  // R3：两个以上 → 结构冲突，判嵌套
  if (positives.length >= 2) return 'nested';
  // R4：没有肯定 → 不强行归类
  return 'unknown';
}

/**
 * 造一个最小的"假 DSH 安装根"，让 `dsh-clis` 的 chunk 能被 import。
 *
 * 只提供 cordis 的**壳**（被 chunk 顶层解构的那几个导出），
 * 不提供任何功能 —— 真实现里用到的是纯函数。
 *
 * @returns `{ root, cleanup }`。
 */
export function makeFakeInstallRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fake-host-'));
  const cordisDir = join(root, 'node_modules', '@deepseek-ai', 'cordis');
  mkdirSync(cordisDir, { recursive: true });
  writeFileSync(
    join(cordisDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/cordis', version: '0.0.0-test', main: 'index.js' }),
    'utf8',
  );
  writeFileSync(
    join(cordisDir, 'index.js'),
    [
      'class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name; } }',
      'module.exports = {',
      '  Service,',
      '  Context: class {},',
      '  symbols: {},',
      '  Fiber: class {},',
      '  RegistryService: class {},',
      '  Inject: class {},',
      '};',
    ].join('\n'),
    'utf8',
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * 加载**真实的** `dsh-clis` 分类器实现。
 *
 * @returns `{ classifyProblem, cleanup }`；找不到兄弟包时**抛错**（不静默跳过）。
 */
export async function loadRealClassifier() {
  let chunkUrl;
  try {
    chunkUrl = REAL_CLIS_CHUNK;
    // 触一下文件系统，确认真的存在（URL 存在不代表文件存在）
    const { existsSync } = await import('node:fs');
    if (!existsSync(fileURLToPath(chunkUrl))) throw new Error('chunk 文件不存在');
  } catch (error) {
    throw new Error(
      '找不到兄弟包 dsh-clis 的实现（' +
        fileURLToPath(REAL_CLIS_CHUNK) +
        '）—— 漂移守卫无法运行。' +
        '这不是"跳过"：真实判据必须与 mock 逐条比对，否则漂移无人看守。' +
        '请在 monorepo 布局下运行本测试（packages/dsh-clis 与 packages/dsh-meta-framework 同级）。' +
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const fake = makeFakeInstallRoot();
  const previousInstallDir = process.env.DSH_INSTALL_DIR;
  process.env.DSH_INSTALL_DIR = fake.root;
  try {
    const mod = await import(pathToFileURL(fileURLToPath(chunkUrl)).href);
    if (typeof mod.classifyProblem !== 'function') {
      throw new Error('dsh-clis 的 chunk 没有导出 classifyProblem');
    }
    return {
      classifyProblem: mod.classifyProblem,
      cleanup: fake.cleanup,
    };
  } catch (error) {
    fake.cleanup();
    throw error;
  } finally {
    if (previousInstallDir === undefined) {
      delete process.env.DSH_INSTALL_DIR;
    } else {
      process.env.DSH_INSTALL_DIR = previousInstallDir;
    }
  }
}

/**
 * 穷举全部 3^4 = 81 种四问组合。
 *
 * @returns `[{ answers, short }]`；`short` 是 `q1`–`q4` 短名映射。
 */
export function allAnswerCombinations() {
  const out = [];
  for (const q1 of TRI_STATES) {
    for (const q2 of TRI_STATES) {
      for (const q3 of TRI_STATES) {
        for (const q4 of TRI_STATES) {
          out.push({ short: { q1, q2, q3, q4 }, long: {
            q1_simultaneous_mutual_definition: q1,
            q2_delayed_mutual_influence: q2,
            q3_strict_irreversible_order: q3,
            q4_coexisting_causal_structures: q4,
          } });
        }
      }
    }
  }
  return out;
}
