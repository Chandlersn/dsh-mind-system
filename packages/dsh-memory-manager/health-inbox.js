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
 * - 自动体检可显式传入完整稳定身份；旧投递仍按原指纹规则处理，不迁移历史。
 */
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Shared across hot-reloaded ESM module instances in this process. The queue is
// cooperative: other processes and code that bypasses it are not coordinated.
const INBOX_QUEUES = Symbol.for('dsh-memory-manager.inbox-path-queues.v1');
const inboxQueues = globalThis[INBOX_QUEUES] ??= new Map();
if (!(inboxQueues instanceof Map)) throw new Error('收件箱共享队列无效');

/** Canonicalize existing physical ancestors and retain any missing suffix. */
async function inboxPathIdentity(filePath) {
  let current = resolve(dirname(filePath));
  const suffix = [basename(filePath)];
  for (;;) {
    try {
      const physical = await realpath(current);
      if (!(await stat(physical)).isDirectory()) throw Object.assign(new Error('收件箱存储路径不是目录'), { code: 'ENOTDIR' });
      let key = join(physical, ...suffix);
      if (process.platform === 'win32') key = key.toLowerCase();
      return key;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`收件箱读取失败：${error?.message ?? String(error)}`, { cause: error });
      // A dangling link is not a missing directory; guessing its physical
      // identity could place the same inbox in two queues.
      try {
        await lstat(current);
        throw error;
      } catch (entryError) {
        if (entryError === error || entryError?.code !== 'ENOENT') throw new Error(`收件箱读取失败：${entryError?.message ?? String(entryError)}`, { cause: entryError });
      }
      const parent = dirname(current);
      if (parent === current) throw new Error('收件箱读取失败：无法解析存储路径', { cause: error });
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function withInboxPathLock(filePath, operation) {
  const key = await inboxPathIdentity(filePath);
  const prior = inboxQueues.get(key) ?? Promise.resolve();
  const run = prior.then(operation, operation);
  inboxQueues.set(key, run);
  const cleanup = () => { if (inboxQueues.get(key) === run) inboxQueues.delete(key); };
  run.then(cleanup, cleanup);
  return run;
}

/** 严重程度。 */
const SEVERITIES = ['info', 'warn', 'error'];

/** 收件箱落盘相对路径（宿主数据目录下）。 */
const INBOX_REL_PATH = join('storages', 'memory-inbox.json');

/** 收件箱文件版本。 */
const INBOX_VERSION = 1;


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
export function createHealthProbe({ runHealthCheck, resolveRoot, opts, recallLedger }) {
  return {
    async probe() {
      // 监督层反复调用 probe()，它必须只读、且**绝不抛错**：自身检查失败时
      // 抛错会让自己从监督视野里消失，而坏掉的探针恰恰最该被发现。把任何
      // 内部异常转成 severity:'error' 的 finding，code 稳定以便去重。
      try {
        const health = await runHealthCheck(resolveRoot(opts), opts);
        const findings = findingsOf(health);
        // 召回双侧账本（2026-11-09）：把最近窗口的 注入/暂缓/丢弃 汇总成一条
        // info finding，让"被放过的"在监督视野里也可见（指标须成对报）。
        // 只读 getter，探针本身不产生也不修改账本。
        if (typeof recallLedger === 'function') {
          try {
            const agg = recallLedger();
            if (agg && agg.rounds > 0) {
              findings.push({
                code: 'memory.recall-dual-side',
                severity: 'info',
                message: `召回曝光（近 ${agg.rounds} 个已注入轮次）：索引分档强档 ${agg.strong ?? '未知'} · 暂缓 ${agg.held} · 丢弃 ${agg.dropped}；最终索引/修复项 ${agg.injected}，档案 ${agg.archives ?? '未知'}，规则 ${agg.rules ?? '未知'}；可选预算省略（含展示上限）：索引/修复 ${agg.omittedRows ?? '未知'}（其中修复 ${agg.omittedRepairs ?? '未知'}）· 暂缓 ${agg.omittedHeld ?? '未知'} · 档案 ${agg.omittedArchives ?? '未知'}；可选文本峰值 ${agg.peakOptionalBytes ?? '未知'} 字节，渲染失败 ${agg.renderFailures ?? '未知'}；强档摘要估算峰值 ${agg.peakUsed}/${agg.budget}，不含完整消息`,
                hint: '仅统计已注入的曝光轮次，不含无匹配、超时或拒绝的分母；不能据此推断漏召率',
              });
            }
          } catch { /* 账本不可读不影响体检 */ }
        }
        return {
          plugin: 'dsh-memory-manager',
          status: statusOf(health.results),
          findings,
        };
      } catch (error) {
        return {
          plugin: 'dsh-memory-manager',
          status: 'failing',
          findings: [{
            code: 'memory.probe-error',
            severity: 'error',
            message: `健康探针自身执行失败：${error?.message ?? String(error)}`,
            hint: '检查记忆根是否可读、runHealthCheck 是否被正确注入',
          }],
        };
      }
    },
  };
}

// ——————————————————————————————————————————————
// 问题收件箱
// ——————————————————————————————————————————————

/**
 * Canonical identity for an explicitly scoped producer finding. Producers must
 * distinguish subtype and subject themselves; deriving either from changing
 * natural-language messages or using the rule alone would merge real issues.
 */
export function canonicalIssueIdentity(input) {
  const identity = input?.identity;
  if (identity === undefined) return undefined;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      Object.keys(identity).sort().join(',') !== 'scope,subject,subtype') {
    throw new Error('告警身份须明确提供 scope、subtype 和 subject');
  }
  const parts = [input.from, input.code, identity.scope, identity.subtype, identity.subject];
  if (parts.some((part) => typeof part !== 'string' || !part.trim() || part !== part.trim())) {
    throw new Error('告警身份的来源、规则、范围、子类型与对象均须为非空规范字符串');
  }
  return JSON.stringify(['memory-inbox-identity-v1', ...parts]);
}

/** SHA-256 is an address, not proof of identity: compare the full key as well. */
export function stableIssueFingerprint(canonicalIdentity) {
  return `i1-${createHash('sha256').update(canonicalIdentity, 'utf8').digest('hex')}`;
}

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
    // Kept outside items so existing tool/HTTP item schemas stay unchanged.
    this.identities = new Map();
    this.loaded = false;
    this.loadPromise = undefined;
    this.chain = Promise.resolve();
    this.mutationChain = Promise.resolve();
  }

  /** @returns {string} */
  filePath() {
    return this.operationFile ?? join(this.dshHome(), INBOX_REL_PATH);
  }

  /** 首次读盘共享同一个 promise；只有完整加载后才允许调用方修改。 */
  async ensureLoaded() {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        let raw;
        try {
          raw = await readFile(this.filePath(), 'utf8');
        } catch (error) {
          if (error?.code === 'ENOENT') {
            // On Windows a file in place of the parent directory may also be
            // reported as ENOENT. Do not treat that storage failure as empty.
            try {
              const parent = await stat(dirname(this.filePath()));
              if (!parent.isDirectory()) throw new Error('收件箱存储路径不是目录');
            } catch (parentError) {
              if (parentError?.code !== 'ENOENT') {
                throw new Error(`收件箱读取失败：${parentError?.message ?? String(parentError)}`, { cause: parentError });
              }
            }
            this.items = new Map();
            this.identities = new Map();
            this.loaded = true;
            return;
          }
          throw new Error(`收件箱读取失败：${error?.message ?? String(error)}`, { cause: error });
        }
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (error) { throw new Error('收件箱文件损坏：JSON 无法解析，已保留原文件', { cause: error }); }
        if (!parsed || parsed.version !== INBOX_VERSION || !parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items)) {
          throw new Error('收件箱文件格式或版本不支持，已保留原文件');
        }
        const loaded = new Map();
        for (const [key, item] of Object.entries(parsed.items)) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || item.fingerprint !== key ||
              typeof item.receivedAt !== 'string' || typeof item.lastSeenAt !== 'string' ||
              !Number.isFinite(item.times) || !['open', 'acknowledged', 'resolved'].includes(item.status)) {
            throw new Error('收件箱存在无效条目，已保留原文件');
          }
          loaded.set(key, item);
        }
        const identities = new Map();
        if (parsed.identities !== undefined) {
          if (!parsed.identities || typeof parsed.identities !== 'object' || Array.isArray(parsed.identities)) {
            throw new Error('收件箱告警身份表损坏，已保留原文件');
          }
          for (const [key, canonical] of Object.entries(parsed.identities)) {
            if (!loaded.has(key) || typeof canonical !== 'string' || !canonical || stableIssueFingerprint(canonical) !== key) {
              throw new Error('收件箱告警身份与指纹不一致，已保留原文件');
            }
            identities.set(key, canonical);
          }
        }
        this.items = loaded;
        this.identities = identities;
        this.loaded = true;
      })();
    }
    const loading = this.loadPromise;
    try { await loading; }
    finally { if (!this.loaded && this.loadPromise === loading) this.loadPromise = undefined; }
  }

  /** Refresh and serialize the complete operation across cooperating instances. */
  mutate(operation) {
    const run = this.mutationChain.catch(() => {}).then(async () => {
      const file = this.filePath();
      return withInboxPathLock(file, async () => {
        this.operationFile = file;
        try {
          // Do not trust instance-local snapshots after another instance wrote.
          // On failed reads, ensureLoaded surfaces the error and never mutates disk.
          this.loaded = false;
          this.loadPromise = undefined;
          // Atomic rename replaces a directory entry, not a symlink target or
          // other hardlink entries; refuse ambiguous aliases rather than split
          // one inbox into independently queued files.
          try {
            const entry = await lstat(file);
            if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1)) {
              throw new Error('收件箱文件不能是符号链接或多硬链接文件');
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          await this.ensureLoaded();
          const before = new Map([...this.items].map(([key, value]) => [key, { ...value }]));
          const identitiesBefore = new Map(this.identities);
          try { return await operation(); }
          catch (error) { this.items = before; this.identities = identitiesBefore; throw error; }
        } finally {
          this.operationFile = undefined;
        }
      });
    });
    this.mutationChain = run;
    return run;
  }

  /**
   * 投递一个问题。
   *
   * @param {object} input 投递内容。
   * @returns {Promise<{item: InboxItem, isNew: boolean, times: number}>}
   */
  async post(input) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const canonical = canonicalIssueIdentity(input);
      const key = canonical === undefined ? inboxFingerprint(input.from, input.code, input.message) : stableIssueFingerprint(canonical);
      const existing = this.items.get(key);
      const priorIdentity = this.identities.get(key);
      if (canonical !== undefined && ((existing !== undefined && priorIdentity !== canonical) || (priorIdentity !== undefined && priorIdentity !== canonical))) {
        throw new Error('收件箱告警身份指纹碰撞或身份缺失，拒绝合并');
      }

      if (existing !== undefined) {
        existing.times += 1;
        existing.lastSeenAt = now;
        if (canonical !== undefined) {
          // The finding is stable; the current observation is not. Keep manual
          // triage and first-seen time, but show the latest facts and severity.
          existing.message = input.message;
          existing.severity = SEVERITIES.includes(input.severity) ? input.severity : 'warn';
          if (input.location !== undefined) existing.location = input.location;
          if (input.hint !== undefined) existing.hint = input.hint;
        }
        // 已解决的又被投递 → 重新打开（问题复现）
        if (existing.status === 'resolved') existing.status = 'open';
        this.items.set(key, existing);
        await this.flush();
        return { item: { ...existing }, isNew: false, times: existing.times };
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
      if (canonical !== undefined) this.identities.set(key, canonical);
      await this.flush();
      return { item: { ...item }, isNew: true, times: 1 };
    });
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
    return this.mutate(async () => {
      const item = this.items.get(fingerprint);
      if (item === undefined) return undefined;
      item.status = status;
      item.lastSeenAt = new Date().toISOString();
      if (note !== undefined) item.note = note;
      this.items.set(fingerprint, item);
      await this.flush();
      return { ...item };
    });
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
    return this.mutate(async () => {
      const item = this.items.get(fingerprint);
      if (item === undefined) return undefined;
      this.items.delete(fingerprint);
      this.identities.delete(fingerprint);
      await this.flush();
      return { ...item };
    });
  }

  /**
   * 列出收件箱。
   *
   * @param {object} [filter] 过滤条件。
   * @returns {Promise<InboxItem[]>}
   */
  async list(filter = {}) {
    return this.mutate(async () => {
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
      // Return snapshots; callers must not mutate the internal state outside the queue.
      return items.map((item) => ({ ...item }));
    });
  }

  /** 串行刷盘（原子替换）。 */
  async flush() {
    // A failed write must reject its caller without poisoning later queued writes.
    this.chain = this.chain.catch(() => {}).then(async () => {
      let tmp;
      let created = false;
      let replacementStarted = false;
      try {
        // Historical records are never evicted automatically; storage growth
        // remains visible for an explicit retention/archival decision.
        const path = this.filePath();
        await mkdir(dirname(path), { recursive: true });
        tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(tmp, 'wx');
        created = true;
        try {
          await handle.writeFile(
            JSON.stringify({ version: INBOX_VERSION, items: Object.fromEntries(this.items), ...(this.identities.size ? { identities: Object.fromEntries(this.identities) } : {}) }, null, 2),
            'utf8',
          );
        } finally {
          await handle.close();
        }
        replacementStarted = true;
        await rename(tmp, path);
        created = false;
      } catch (error) {
        if (created) await unlink(tmp).catch(() => {});
        // A rename can take effect even if its acknowledgement is lost. Do not
        // encourage a retry that could count the same observation twice.
        const failure = new Error(replacementStarted
          ? `收件箱保存结果未知：替换可能已发生，请先重新读取磁盘核对，不要盲目重试。${error?.message ?? String(error)}`
          : `收件箱保存失败，未替换原文件：${error?.message ?? String(error)}`, { cause: error });
        failure.code = replacementStarted ? 'INBOX_COMMIT_UNKNOWN' : 'INBOX_NOT_COMMITTED';
        failure.committed = replacementStarted ? 'unknown' : false;
        throw failure;
      }
    });
    await this.chain;
  }
}
