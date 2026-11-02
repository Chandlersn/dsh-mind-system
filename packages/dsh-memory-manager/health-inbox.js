/**
 * 记忆管理的**健康探针**与**问题收件箱** —— 让记忆系统参与插件互查互治。
 *
 * 用户目标（2026-10-26）：各插件互查互治、互帮互助，整体走向正向循环，
 * 并让记忆管理成为一个专门接收各插件问题投递 / agent 报告的邮箱。
 *
 * 两个职责：
 * 1. **probe()**：实现 CLIS 定义的 HealthProbe 契约，把 memory_check 的
 *    R0–R22 规则结果翻译成统一的 HealthFinding 形状，使本插件能被
 *    `clis_probe` 自动检查。
 * 2. **收件箱**：接收来自其他插件或 agent 的问题投递，落盘为一份可分诊
 *    的清单。为什么让记忆管理收：它本来就是"全局长期记忆"的持有者，
 *    问题清单也是需要长期跟踪的状态；放在这里不必新建存储层。
 *
 * 刻意做的边界：
 * - probe 只读（不修复、不写记忆），符合契约要求；
 * - 收件箱只**记录**问题，不自动修 —— 修复是写操作，跨插件自动改数据风险高；
 * - 投递去重靠 `fingerprint`（来源+代号+摘要），避免同一问题刷屏。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 严重程度。 */
const SEVERITIES = ['info', 'warn', 'error'];

/** 收件箱落盘相对路径（宿主数据目录下）。 */
const INBOX_REL_PATH = join('storages', 'memory-inbox.json');

/** 收件箱文件版本。 */
const INBOX_VERSION = 1;

/** 收件箱容量上限，防止无限增长。 */
const MAX_INBOX_ITEMS = 200;

/**
 * 把 memory_check 的规则等级映射为健康严重度。
 *
 * 映射依据：memory_check 的 FAIL 表示记忆根结构性损坏（会导致工具失效），
 * WARN 表示质量退化（还能用但不健康）。
 *
 * @param level memory_check 的 level。
 * @returns HealthFinding 的 severity。
 */
export function severityOf(level) {
  if (level === 'FAIL') return 'error';
  if (level === 'WARN') return 'warn';
  return 'info';
}

/**
 * 从 memory_check 结果推导整体状态。
 *
 * @param results memory_check 的 results。
 * @returns 'ok' | 'degraded' | 'failing'。
 */
export function statusOf(results) {
  if (results.some((item) => item.level === 'FAIL')) return 'failing';
  if (results.some((item) => item.level === 'WARN')) return 'degraded';
  return 'ok';
}

/**
 * 为规则生成方向提示。
 *
 * 只说"往哪个方向看"，不给修复指令 —— 修复由 agent/用户决定。
 *
 * @param rule 规则代号。
 * @returns 提示或 undefined。
 */
function hintFor(rule) {
  switch (rule) {
    case 'R3':
      return '头部摘要与迭代块应成对更新：写新块时同步刷新头部，否则状态会滞后';
    case 'R14':
      return '同类规则反复超标，考虑在写入时限制篇幅，而不是事后压缩';
    case 'R9':
      return '功能文件过大，先折叠最旧块再看是否仍在增长';
    case 'R10':
      return '存在死链或越界链接：改名/移动文件后需同步改写引用';
    case 'R18':
      return '该域纠正率偏高，应重构而非继续追加';
    case 'TEMP':
      return '长期无人引用的记忆：确认是否仍需维护，或合并/折叠';
    default:
      return undefined;
  }
}

/**
 * 把 memory_check 结果翻译成 HealthProbe 的 findings。
 *
 * @param health runHealthCheck 的返回值。
 * @returns findings 数组。
 */
export function findingsOf(health) {
  return health.results.map((item) => {
    const hint = hintFor(item.rule);
    return {
      code: item.rule === undefined ? 'memory-unknown' : `memory.${item.rule}`,
      severity: severityOf(item.level),
      message: item.message,
      ...(item.rule !== undefined ? { location: `memory:${item.rule}` } : {}),
      ...(hint !== undefined ? { hint } : {}),
    };
  });
}

/**
 * 生成一个 health probe 实现。
 *
 * @param runHealthCheck memory_check 的底层实现。
 * @param resolveRoot 解析记忆根的函数。
 * @param opts 传给 runHealthCheck 的选项。
 * @returns 符合 HealthProbe 契约的对象（结构类型，不依赖 CLIS 的包）。
 */
export function createHealthProbe({ runHealthCheck, resolveRoot, opts }) {
  return {
    async probe() {
      const health = await runHealthCheck(resolveRoot(opts), opts);
      const findings = findingsOf(health);
      return {
        plugin: 'dsh-memory-manager',
        status: statusOf(health.results),
        findings,
      };
    },
  };
}

// ——————————————————————————————————————————————
// 问题收件箱
// ——————————————————————————————————————————————

/**
 * 收件箱条目。
 *
 * @typedef {object} InboxItem
 * @property {string} fingerprint 去重指纹
 * @property {string} from 投递方（插件名或 'agent' / 'user'）
 * @property {string} code 问题代号
 * @property {string} severity info|warn|error
 * @property {string} message 一句话描述
 * @property {string} [location] 位置
 * @property {string} [hint] 方向提示
 * @property {string} receivedAt 首次收到时间（ISO）
 * @property {string} lastSeenAt 最近一次收到时间
 * @property {number} times 收到次数
 * @property {'open'|'acknowledged'|'resolved'} status 处置状态
 * @property {string} [note] 处置备注
 */

/**
 * 计算去重指纹。
 *
 * 用"来源 + 代号 + 消息前 40 字"做键：同一来源重复投递同一问题只记一条，
 * 但不同来源报同一代号仍分开记（各自的修复责任不同）。
 *
 * @param from 投递方。
 * @param code 问题代号。
 * @param message 消息。
 * @returns 指纹。
 */
export function inboxFingerprint(from, code, message) {
  const material = `${from}|${code}|${String(message).slice(0, 40)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 收件箱存储。
 */
export class MemoryInbox {
  /**
   * @param dshHome 宿主数据目录解析函数。
   */
  constructor(dshHome) {
    this.dshHome = dshHome;
    /** @type {Map<string, InboxItem>} */
    this.items = new Map();
    this.loaded = false;
    this.chain = Promise.resolve();
  }

  /** @returns {string} */
  filePath() {
    return join(this.dshHome(), INBOX_REL_PATH);
  }

  /** 从磁盘加载（首次使用时）。 */
  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === INBOX_VERSION && parsed.items && typeof parsed.items === 'object') {
        for (const [key, item] of Object.entries(parsed.items)) {
          this.items.set(key, item);
        }
      }
    } catch {
      // 缺失或损坏都从空开始；投递状态丢了最多重报一次
    }
  }

  /**
   * 投递一个问题。
   *
   * @param {object} input 投递内容。
   * @returns {Promise<{item: InboxItem, isNew: boolean, times: number}>}
   */
  async post(input) {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const key = inboxFingerprint(input.from, input.code, input.message);
    const existing = this.items.get(key);

    if (existing !== undefined) {
      existing.times += 1;
      existing.lastSeenAt = now;
      // 已解决的又被投递 → 重新打开（问题复现）
      if (existing.status === 'resolved') existing.status = 'open';
      this.items.set(key, existing);
      await this.flush();
      return { item: existing, isNew: false, times: existing.times };
    }

    /** @type {InboxItem} */
    const item = {
      fingerprint: key,
      from: input.from,
      code: input.code,
      severity: SEVERITIES.includes(input.severity) ? input.severity : 'warn',
      message: input.message,
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.hint !== undefined ? { hint: input.hint } : {}),
      receivedAt: now,
      lastSeenAt: now,
      times: 1,
      status: 'open',
    };
    this.items.set(key, item);
    await this.flush();
    return { item, isNew: true, times: 1 };
  }

  /**
   * 更新一条的处置状态。
   *
   * @param {string} fingerprint 指纹。
   * @param {'open'|'acknowledged'|'resolved'} status 新状态。
   * @param {string} [note] 备注。
   * @returns {Promise<InboxItem|undefined>}
   */
  async update(fingerprint, status, note) {
    await this.ensureLoaded();
    const item = this.items.get(fingerprint);
    if (item === undefined) return undefined;
    item.status = status;
    item.lastSeenAt = new Date().toISOString();
    if (note !== undefined) item.note = note;
    this.items.set(fingerprint, item);
    await this.flush();
    return item;
  }

  /**
   * 彻底删除一条。
   *
   * 与 `update(resolved)` 的区别，用户在面板上要能分清：
   * - **标记已解决** = 保留了记录，说明"这件事有过、已处理"；
   * - **删除** = 抹掉记录，说明"这条根本不该在收件箱里"（误报、重复投递、
   *   或已经不需要跟踪）。
   *
   * 删除是**不可逆**的，所以面板上要二次确认；这里只负责删。
   * 返回被删的条目，便于调用方回显与审计。
   *
   * @param {string} fingerprint 指纹。
   * @returns {Promise<InboxItem|undefined>} 被删的条目；不存在时 undefined。
   */
  async remove(fingerprint) {
    await this.ensureLoaded();
    const item = this.items.get(fingerprint);
    if (item === undefined) return undefined;
    this.items.delete(fingerprint);
    await this.flush();
    return item;
  }

  /**
   * 列出收件箱。
   *
   * @param {object} [filter] 过滤条件。
   * @returns {Promise<InboxItem[]>}
   */
  async list(filter = {}) {
    await this.ensureLoaded();
    let items = [...this.items.values()];
    if (filter.status !== undefined) items = items.filter((item) => item.status === filter.status);
    if (filter.from !== undefined) items = items.filter((item) => item.from === filter.from);
    if (filter.severity !== undefined) items = items.filter((item) => item.severity === filter.severity);
    // 未处理的排前面，同状态按最近收到时间倒序
    const statusRank = { open: 0, acknowledged: 1, resolved: 2 };
    items.sort((left, right) => {
      const byStatus = statusRank[left.status] - statusRank[right.status];
      if (byStatus !== 0) return byStatus;
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
    return items;
  }

  /** 串行刷盘（原子替换）。 */
  async flush() {
    this.chain = this.chain.then(async () => {
      try {
        // 超出容量时丢弃最旧的已解决条目
        if (this.items.size > MAX_INBOX_ITEMS) {
          const resolved = [...this.items.values()]
            .filter((item) => item.status === 'resolved')
            .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
          const overflow = this.items.size - MAX_INBOX_ITEMS;
          for (const item of resolved.slice(0, overflow)) {
            this.items.delete(item.fingerprint);
          }
        }
        const path = this.filePath();
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(
          tmp,
          JSON.stringify({ version: INBOX_VERSION, items: Object.fromEntries(this.items) }, null, 2),
          'utf8',
        );
        await rename(tmp, path);
      } catch {
        // 写不了就只保留内存视图
      }
    });
    await this.chain;
  }
}
