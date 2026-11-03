/**
 * dsh-mind-system — 心智系统合成包的入口。
 *
 * ## 这个包做什么（以及不做什么）
 *
 * 它**是唯一的装载点**：四家成员（clis / meta-framework / memory-manager /
 * agent-mind）的**源码物理并入本包**（clis/ mind/ meta/ memory/ 四个子目录），
 * 由 `cordis.patch.yml` 里八条 insert 行按顺序装载。
 *
 * 能力归成员，本文件只承载：
 *
 * 1. 装载清单常量（MEMBERS / MEMBER_PACKAGES / CLIS_COMPONENTS）——
 *    与 patch 的一致性由 test/members.test.js 钉住；
 * 2. 健康探针 —— 检查成员子目录在**包内**是否齐全。
 *
 * ## 与旧聚合形态的差别
 *
 * 旧形态成员是**外部包**（宿主按名字从 node_modules 解析），
 * 探针只能探"仓库里在不在"，file:/link: 装法下曾系统性误报
 * （packageDir/../.. 推不出仓库根）。合成形态成员在**包内**，
 * 探针直接看包内子目录 —— 永远不会误报。
 *
 * @module dsh-mind-system
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 合成包名（宿主据此把本包当普通 bundle 处理）。 */
export const name = 'dsh-mind-system';

/** 本包入口不注入任何服务（能力在成员子目录里）。 */
export const inject = [];

/**
 * 成员装载点（**按装载顺序**，全部是本包的 exports 子路径）。
 *
 * 顺序的依据：服务提供者先于消费者——
 * clis 四组件 → clis 工具包（inject 依赖那四服务）→
 * meta-framework（依赖 clis 分类器）→ memory-manager（自足）→
 * mind（需要 tools 与 systemPrompt 都已就位）→ 本包最后收口。
 */
export const MEMBERS = [
  'dsh-mind-system/clis-classifier',
  'dsh-mind-system/clis-strategy',
  'dsh-mind-system/clis-feedback',
  'dsh-mind-system/clis-orchestrator',
  'dsh-mind-system/clis',
  'dsh-mind-system/meta-framework',
  'dsh-mind-system/memory-manager',
  'dsh-mind-system/agent-mind',
];

/**
 * 四个成员的**子目录名**（包内，与 MEMBERS 一一对应去重）。
 * 用于探针的磁盘检查：目录在 = 源码并入完成。
 */
export const MEMBER_PACKAGES = ['clis', 'meta', 'memory', 'mind'];

/** clis 的四个子组件（装载点形态，缺一工具包不激活）。 */
export const CLIS_COMPONENTS = [
  'dsh-mind-system/clis-classifier',
  'dsh-mind-system/clis-strategy',
  'dsh-mind-system/clis-feedback',
  'dsh-mind-system/clis-orchestrator',
];

/** 探针代号（稳定，供监督层与日志检索）。 */
export const PROBE_CODES = {
  /** 成员子目录在包内找不到 —— 合成包是残缺的。 */
  memberMissing: 'mind-system.member-missing',
  /** 一切正常。 */
  ok: 'mind-system.ok',
};

/** 本包所在目录。@type {string} */
export const packageDir = dirname(fileURLToPath(import.meta.url));

/**
 * 找一个成员在**包内**的目录。
 *
 * @param {string} memberDir — 成员子目录名（clis / meta / memory / mind）。
 * @returns {string|undefined} 绝对路径；不存在则 undefined。
 */
export function memberPackageDir(memberDir) {
  const dir = join(packageDir, memberDir);
  return existsSync(join(dir, 'index.js')) || existsSync(join(dir, 'server.js')) ? dir : undefined;
}

/**
 * 探测成员是否在包内。
 *
 * @param {string} memberDir — 成员子目录名。
 * @returns `{{present: boolean, dir: string|undefined}}`。
 */
export function probeMember(memberDir) {
  const dir = memberPackageDir(memberDir);
  return { present: dir !== undefined, dir };
}

/**
 * 合成包的健康探针：只检查成员子目录在**包内**是否存在。
 *
 * 它**不**声称成员已装载——那需要宿主上下文，探针零参数拿不到。
 * 合成形态下成员随包分发，"包在 = 成员源码在"，
 * 因此本探针不再有旧聚合形态的系统性误报。
 *
 * @returns 探针结果。
 */
export function probe() {
  try {
    const findings = [];
    const missing = [];

    for (const memberDir of MEMBER_PACKAGES) {
      const { present } = probeMember(memberDir);
      if (!present) missing.push(memberDir);
    }

    if (missing.length > 0) {
      findings.push({
        code: PROBE_CODES.memberMissing,
        severity: 'error',
        message: `合成包声明的成员子目录在包内找不到：${missing.join('、')}。`,
        hint: '包分发不完整——重新安装/重新打包。',
      });
    } else {
      findings.push({
        code: PROBE_CODES.ok,
        severity: 'info',
        message:
          `合成包的 ${MEMBER_PACKAGES.length} 个成员子目录都在包内：` +
          `${MEMBER_PACKAGES.join('、')}。` +
          '（本探针只看包内文件，不声称成员在真宿主里已装载。）',
      });
    }

    return {
      plugin: 'dsh-mind-system',
      status: deriveStatus(findings),
      findings,
    };
  } catch (error) {
    return {
      plugin: 'dsh-mind-system',
      status: 'failing',
      findings: [
        {
          code: PROBE_CODES.memberMissing,
          severity: 'error',
          message: `探针自身执行异常：${error instanceof Error ? error.message : String(error)}`,
          hint: '这是探针的缺陷，不是合成包的缺陷；请上报。',
        },
      ],
    };
  }
}

/** 由 findings 推整体状态：error→failing、warn→degraded、否则 ok。 */
export function deriveStatus(findings) {
  if (findings.some((item) => item.severity === 'error')) return 'failing';
  if (findings.some((item) => item.severity === 'warn')) return 'degraded';
  return 'ok';
}

/** 探针对象形态（监督层接受 ns.healthProbe 为对象含 probe()）。 */
export const healthProbe = { probe };

/**
 * 装载：不做事。能力在四个成员子目录里，本入口只是可识别的包根。
 *
 * @param {unknown} ctx Cordis 上下文（本包不用它）。
 */
export function apply(ctx) {
  // 故意空实现。
}
