/**
 * dsh-mind-system —— 心智系统聚合包的入口。
 *
 * ## 这个包做什么（以及不做什么）
 *
 * 它**不提供任何能力**。四家各自提供：
 *
 * | 插件 | 提供什么 | 少了会怎样 |
 * |---|---|---|
 * | `dsh-clis` | 因果结构判据（分类/策略/反馈/编排）+ 五工具 + 系统监督 | 判不了环/对偶/单向/嵌套；meta 退化为通用重定义 |
 * | `dsh-meta-framework` | 重定义→边界→选择→观测四层 + trace 落盘 | 失去"重新审视问题"这一手 |
 * | `dsh-memory-manager` | 五层记忆判据 + 写入准入 + 回读复核 | 记忆无判据，蒸馏回到"写进去就算" |
 * | `dsh-agent-mind` | 判断顺序常驻分节 + 按处境编排工具面 | 工具平铺，模型自行分辨该用谁 |
 *
 * 本包只做一件事：**给这四家一个共同的装载点与版本约束**。
 * 少装一家，那部分能力就不在 —— 是**降级**，不是报错。
 *
 * ## 为什么是聚合而不是合成
 *
 * 合成（把四家代码内联进一个插件）的问题：
 *
 * - 四家绑死，无法单独升级或单独关闭
 * - 体积大、审阅难、任一家改动都要重发全包
 * - 版本冲突无从解决（合成后没有"谁的版本"这个问题了）
 *
 * 聚合保留独立性，同时给使用者"一次装齐"的入口 —— 这正是本包存在的意义。
 *
 * ## ⭐ 成员清单是**唯一事实来源**（缺陷 4）
 *
 * 此前成员清单在**三个地方各写一遍**，三种形状：
 *
 * - 本文件导出 `MEMBERS`（8 条子路径形态）—— **零引用者**，是死代码
 * - `scripts/publish-check.mjs` 的三处字面量（4 个基本名，顺序还不同）
 * - patch YAML 里的 9 个 `name:` 条目
 *
 * 三份清单可以各自漂移而不被发现 —— 而"聚合包装载了哪些成员"正是
 * 这个包**唯一**承诺的事。
 *
 * 现在：**本文件是唯一事实来源**，`publish-check.mjs` 从这里 import。
 * patch YAML 里的顺序由测试对照本清单校验（见 `test/members.test.js`）。
 *
 * @module dsh-mind-system
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 聚合包名。 */
export const name = 'dsh-mind-system';

/** 本包不注入任何服务（它是装载点，不是能力提供者）。 */
export const inject = [];

/**
 * 心智系统的成员（**按装载顺序**，子路径形态）。
 *
 * ## 顺序的依据：服务提供者先于消费者
 *
 * | # | 成员 | 为什么在这个位置 |
 * |---|---|---|
 * | 1 | `dsh-clis/classifier` | 因果分类器 —— `dsh-clis` 工具包 inject 依赖它 |
 * | 2 | `dsh-clis/strategy` | 策略匹配服务 |
 * | 3 | `dsh-clis/feedback` | 反馈检测服务 |
 * | 4 | `dsh-clis/orchestrator` | 编排服务 |
 * | 5 | `dsh-clis` | clis 工具包（`inject` 依赖上面四个服务） |
 * | 6 | `dsh-meta-framework` | 依赖 clis 的分类器（`ctx.get` 运行时取） |
 * | 7 | `dsh-memory-manager` | 自足，放哪都行 |
 * | 8 | `dsh-agent-mind` | 需要 `tools` 与 `systemPrompt` 都已就位 |
 *
 * 注意第 5–6 条：clis 的**四个子组件**必须都在 clis 工具包**之前** ——
 * 工具包的 `inject` 含 `clis.causalClassifier` / `clis.causalStrategy` /
 * `clis.causalOrchestrator`，服务没就位时它不激活
 * （宿主只报一句 "1 entry did not activate"，极难排查）。
 *
 * `dsh-mind-system` 自己在最后收口（patch 里的最后一条 insert）。
 */
export const MEMBERS = [
  'dsh-clis/classifier',
  'dsh-clis/strategy',
  'dsh-clis/feedback',
  'dsh-clis/orchestrator',
  'dsh-clis',
  'dsh-meta-framework',
  'dsh-memory-manager',
  'dsh-agent-mind',
];

/**
 * 四个成员包（**基本名**形态，按与 `MEMBERS` 一致的顺序）。
 *
 * ## 与 `MEMBERS` 的关系
 *
 * `MEMBERS` 是**装载点**（含 clis 的四个子组件，因为它们各自是一个装载点）；
 * 这里是**包**（一个包一个基本名）—— 用于依赖声明、目录检查、版本区间核对。
 *
 * 两者由**同一条规则**派生：`MEMBERS` 里去掉子路径（`/` 之后的部分），
 * 去重后保持原序。所以不会出现"两份清单对不上"——
 * `test/members.test.js` 有一条测试直接比对它们。
 */
export const MEMBER_PACKAGES = [...new Set(MEMBERS.map((m) => m.split('/')[0]))];

/**
 * clis 的四个子组件（装载点形态）。
 *
 * 单独列出来是因为它们有**硬约束**：四个都必须在 `dsh-clis` 工具包之前，
 * 且一个都不能少 —— 少一个，工具包的 inject 就少一个满足条件。
 */
export const CLIS_COMPONENTS = [
  'dsh-clis/classifier',
  'dsh-clis/strategy',
  'dsh-clis/feedback',
  'dsh-clis/orchestrator',
];

/**
 * 探针代号（稳定，供监督层与日志检索）。
 *
 * 与 `dsh-meta-framework` 的命名法一致（`<包名>.<状态>`）。
 */
export const PROBE_CODES = {
  /** 成员清单里有成员在磁盘上找不到 —— 装出来的聚合包是残缺的。 */
  memberMissing: 'mind-system.member-missing',
  /** 一切正常。 */
  ok: 'mind-system.ok',
};

/**
 * 本包所在目录（用于定位兄弟包）。
 *
 * @type {string}
 */
export const packageDir = dirname(fileURLToPath(import.meta.url));

/**
 * 仓库根（`packages/` 的上一级）。
 *
 * @type {string}
 */
export const repoRoot = join(packageDir, '..', '..');

/**
 * 找一个成员包在**本仓库**里的目录。
 *
 * @param packageName — 包名（如 `dsh-clis`）。
 * @returns 绝对路径；找不到则 undefined。
 */
export function memberPackageDir(packageName) {
  const dir = join(repoRoot, 'packages', packageName);
  return existsSync(join(dir, 'package.json')) ? dir : undefined;
}

/**
 * 探测成员是否**在本仓库里**。
 *
 * ## 这里能观察到什么、观察不到什么
 *
 * 能观察：成员包在磁盘上**存在**（`packages/<name>/package.json` 在）。
 * 观察不到：它在真宿主里**有没有装载成功** —— 那需要宿主上下文
 * （`ctx.loader.entries()`），而探针是**零参数**调用的，拿不到。
 *
 * 所以这个探针**只说"成员在不在"**，绝不说"成员加载好了"——
 * 后者是它观察不到的事实，说了就是假话（这正是缺陷 6 要消灭的东西）。
 *
 * @param packageName — 包名。
 * @returns `{present, dir}`。
 */
export function probeMember(packageName) {
  const dir = memberPackageDir(packageName);
  return { present: dir !== undefined, dir };
}

/**
 * 聚合包的健康探针。
 *
 * ## 为什么聚合包也需要探针（缺陷 6）
 *
 * 聚合包**不提供任何能力** —— 它只是四个成员的共同装载点。
 * 但"某个成员没装上"这件事此前**完全不可见**：
 *
 * - 宿主不报错（少装一家只是降级）
 * - 聚合包自己没有 `healthProbe`，监督层报 `coverage.no-probe`
 * - `apply()` 是纯 no-op，什么都不做
 *
 * 结果是"装了个残缺的聚合包"这件事没人知道。
 *
 * ## 它只报**能观察到**的事实
 *
 * 本探针**只检查成员包在磁盘上是否存在**。它**不**声称成员已装载 ——
 * 那需要宿主上下文，而探针拿不到（与 `dsh-meta-framework` 的
 * "探针收不到 ctx" 是同一条约束）。
 *
 * 特别地：**当成员在磁盘上但不在本仓库里时**（例如只装了 npm 包、
 * 在别处部署），本探针会**如实说"未观测到"**，而不是报"缺失"——
 * 因为"磁盘上没有"不等于"没装"。
 *
 * @returns 探针结果。
 */
export function probe() {
  try {
    const findings = [];
    const missing = [];

    for (const memberName of MEMBER_PACKAGES) {
      const { present } = probeMember(memberName);
      if (!present) missing.push(memberName);
    }

    if (missing.length > 0) {
      findings.push({
        code: PROBE_CODES.memberMissing,
        severity: 'error',
        message:
          `聚合包声明的成员在仓库里找不到：${missing.join('、')}。` +
          '注意：本探针只能看到**本仓库**里的成员（探针零参数调用，拿不到宿主上下文，' +
          '无法知道真宿主里装载了谁）。若这些成员是从 npm 装的，请忽略此条。',
        hint: '在 monorepo 里检查 packages/ 下的成员目录是否齐全。',
      });
    } else {
      findings.push({
        code: PROBE_CODES.ok,
        severity: 'info',
        message:
          `聚合包声明的 ${MEMBER_PACKAGES.length} 个成员在仓库里都在：` +
          `${MEMBER_PACKAGES.join('、')}。` +
          '（本探针只看得到仓库里的成员，**不**声称它们在真宿主里已装载。）',
      });
    }

    return {
      plugin: 'dsh-mind-system',
      status: deriveStatus(findings),
      findings,
    };
  } catch (error) {
    // 探针自己抛错比没探针更糟（会让监督层一起挂）。
    return {
      plugin: 'dsh-mind-system',
      status: 'failing',
      findings: [
        {
          code: PROBE_CODES.memberMissing,
          severity: 'error',
          message: `探针自身执行异常：${error instanceof Error ? error.message : String(error)}`,
          hint: '这是探针的缺陷，不是聚合包的缺陷；请上报。',
        },
      ],
    };
  }
}

/**
 * 由 findings 推整体状态。
 *
 * 与 `dsh-meta-framework` / `dsh-clis` 用的**契约包那一支**同口径：
 * `error → failing`、`warn → degraded`、否则 `ok`。
 * （`dsh-clis` 内部 `structuralProbe()` 用的另一支是"有发现即 degraded"，
 * 那对它合适 —— 它的发现项只有 warn/error。本探针也可能产 info 级发现项，
 * 所以用契约包那一支。）
 *
 * @param findings — 发现项。
 * @returns 状态字符串。
 */
export function deriveStatus(findings) {
  if (findings.some((item) => item.severity === 'error')) return 'failing';
  if (findings.some((item) => item.severity === 'warn')) return 'degraded';
  return 'ok';
}

/** 探针对象形态（监督层接受 `ns.healthProbe` 为对象含 `probe()`）。 */
export const healthProbe = { probe };

/**
 * 装载：不做事。
 *
 * 成员由 `cordis.patch.yml` 里的 insert 行装载（宿主按名字解析已装 bundle）。
 * 这个入口存在是为了给宿主一个可识别的包根 —— 它导出 `name` 与 `inject`，
 * 宿主据此把它当作普通 bundle 处理。
 *
 * @param {unknown} ctx Cordis 上下文（本包不用它）。
 */
export function apply(ctx) {
  // 故意空实现：能力在四个成员里，本包只是它们的装载点。
}
