import {
  classifyProblem
} from "./chunk-2HMO3QIV.js";
import {
  STRATEGY_LIBRARY,
  STRATEGY_LIBRARY_VERSION,
  executePath,
  matchPaths
} from "./chunk-OOJ2ZH5S.js";
import {
  FEEDBACK_RULES_VERSION,
  detectSignal
} from "./chunk-RDSPXR43.js";
import {
  ROLLBACK_LIMIT_DEFAULT,
  TYPE_LOCK_ROUNDS_DEFAULT,
  decide
} from "./chunk-IYFQPRCX.js";
import {
  deriveStatus,
  getCreateUserMessage,
  getDefineTool,
  initialState
} from "./chunk-DC3YUXV4.js";

// packages/clis-plugin/src/index.ts
import { join as join6 } from "node:path";

// packages/clis-plugin/src/history.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var MAX_ENTRIES_PER_FINGERPRINT = 20;
var HISTORY_FILE_VERSION = 1;
var HISTORY_REL_PATH = join("storages", "clis-history.json");
function historyFilePath() {
  const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(root, HISTORY_REL_PATH);
}
async function readHealthState() {
  try {
    const raw = await readFile(historyFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && parsed.version === HISTORY_FILE_VERSION && typeof parsed.records === "object") {
      return parsed;
    }
    return void 0;
  } catch {
    return void 0;
  }
}
function fingerprint(description, answers) {
  const material = [
    description.trim().toLowerCase().replace(/\s+/gu, " "),
    answers.q1_simultaneous_mutual_definition,
    answers.q2_delayed_mutual_influence,
    answers.q3_strict_irreversible_order,
    answers.q4_coexisting_causal_structures
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
var ClisHistoryStore = class {
  /** 权威内存视图。 */
  memory = /* @__PURE__ */ new Map();
  /** 是否已从磁盘加载过。 */
  loaded = false;
  /** 写入链：所有刷盘串行排队，避免并发 read-modify-write 丢更新。 */
  chain = Promise.resolve();
  /** 磁盘不可用时置真，此后只写内存。 */
  diskDisabled = false;
  /**
   * 首次使用时从磁盘加载。
   *
   * 文件缺失 → 空视图；JSON 损坏 → **先把坏文件挪走备份**再从空视图开始，
   * 绝不静默覆盖（覆盖会让下一轮以为上一轮真的没发生过）。
   */
  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const path = historyFilePath();
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && parsed.version === HISTORY_FILE_VERSION && typeof parsed.records === "object") {
        for (const [key, record] of Object.entries(
          parsed.records ?? {}
        )) {
          if (record !== null && typeof record === "object" && Array.isArray(record.entries)) {
            this.memory.set(key, record);
          }
        }
      }
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") return;
      await this.quarantine(path);
    }
  }
  /**
   * 把损坏的历史文件挪成备份。
   *
   * @param path 原文件路径。
   */
  async quarantine(path) {
    try {
      const backup = `${path}.corrupt-${Date.now()}`;
      await rename(path, backup);
    } catch {
    }
  }
  /**
   * 读某个问题的历史。
   *
   * @param key 问题指纹。
   * @returns 历史记录；无记录时返回 undefined。
   */
  async read(key) {
    await this.ensureLoaded();
    return this.memory.get(key);
  }
  /**
   * 追加一条历史：先更新内存，再排队刷盘。
   *
   * @param key 问题指纹。
   * @param description 问题原文。
   * @param entry 这次的记录。
   */
  async append(key, description, entry) {
    await this.ensureLoaded();
    const existing = this.memory.get(key);
    const entries = [...existing?.entries ?? [], entry].slice(-MAX_ENTRIES_PER_FINGERPRINT);
    const next = { fingerprint: key, description, entries };
    this.memory.set(key, next);
    this.chain = this.chain.then(() => this.flush());
    await this.chain;
  }
  /**
   * 全量刷盘（原子替换：写临时文件再 rename）。
   *
   * 任何失败都只关掉磁盘通道，不影响内存视图继续工作。
   */
  async flush() {
    if (this.diskDisabled) return;
    const path = historyFilePath();
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = {
        version: HISTORY_FILE_VERSION,
        records: Object.fromEntries(this.memory)
      };
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
      await rename(tmp, path);
    } catch {
      this.diskDisabled = true;
    }
  }
  /**
   * 把历史整形成反馈服务要的 `previous_signals`。
   *
   * 只回传**同一类型假设**下的信号 —— 换了类型假设，旧信号不再构成
   * "同一假设下的反复偏离"，传给 feedback 会得出错误结论。
   *
   * @param record 历史记录。
   * @param assumedType 当前类型假设。
   * @returns 该假设下的历史信号（按时间顺序）。
   */
  static signalsFor(record, assumedType) {
    if (record === void 0) return [];
    return record.entries.filter((entry) => entry.causal_type === assumedType).map((entry) => entry.signal_type);
  }
  /**
   * 数出**真实动手后**的失败次数。
   *
   * 基线记录（`baseline: true`，即"只做了判断没动手"）不算失败 ——
   * 否则第一次真实失败就会被误升级成 `type_misjudged`。
   *
   * @param record 历史记录。
   * @returns 真实失败次数。
   */
  static failures(record) {
    if (record === void 0) return 0;
    return record.entries.filter(
      (entry) => entry.baseline !== true && (entry.signal_type === "ineffective" || entry.signal_type === "type_misjudged")
    ).length;
  }
  /**
   * 同一类型假设下已判过几次误判。
   *
   * @param record 历史记录。
   * @param assumedType 当前类型假设。
   * @returns 误判次数。
   */
  static rollbacksFor(record, assumedType) {
    if (record === void 0) return 0;
    return record.entries.filter(
      (entry) => entry.causal_type === assumedType && entry.signal_type === "type_misjudged"
    ).length;
  }
};

// packages/clis-plugin/src/health-probe.ts
var ClisHealthProbe = class {
  /**
   * @param ctx 插件上下文（用于取三个因果服务）。
   * @param pluginVersion 当前运行的插件版本，便于诊断时确认跑的是哪一版。
   */
  constructor(ctx, pluginVersion) {
    this.ctx = ctx;
    this.pluginVersion = pluginVersion;
  }
  ctx;
  pluginVersion;
  /**
   * 执行自检。**只读**：不写任何业务数据。
   *
   * @returns 结构化结论。
   */
  async probe() {
    const findings = [];
    const services = [
      ["clis.causalClassifier", "\u56E0\u679C\u5206\u7C7B\u5668"],
      ["clis.causalStrategy", "\u7B56\u7565\u5339\u914D\u5668"],
      ["clis.causalFeedback", "\u53CD\u9988\u68C0\u6D4B\u5668"],
      ["clis.causalOrchestrator", "\u95ED\u73AF\u7F16\u6392\u5668"]
    ];
    for (const [serviceName, label] of services) {
      const present = this.safeGet(serviceName) !== void 0;
      if (!present) {
        findings.push({
          code: "clis.service-missing",
          severity: "error",
          message: `${label}\uFF08${serviceName}\uFF09\u4E0D\u53EF\u7528\uFF1A\u4F9D\u8D56\u5B83\u7684\u5DE5\u5177\u4F1A\u5168\u90E8\u505C\u7528`,
          location: `dsh-clis/${serviceName}`,
          hint: "\u591A\u534A\u662F\u5BF9\u5E94\u7EC4\u4EF6\u88AB\u5173\u95ED\u6216\u88C5\u8F7D\u5931\u8D25\uFF1B\u5728 Plugin Manager \u91CC\u786E\u8BA4\u5B83\u7684 fiberPhase \u662F\u5426\u4E3A active"
        });
      }
    }
    try {
      const state = await readHealthState();
      if (state === void 0) {
        findings.push({
          code: "clis.history-absent",
          severity: "info",
          message: "\u5C1A\u672A\u4EA7\u751F\u4F7F\u7528\u5386\u53F2\uFF08\u8FD8\u6CA1\u6709\u4EBA\u771F\u6B63\u7528\u8FC7 clis_run\uFF0C\u6216\u4ECE\u672A\u56DE\u586B last_outcome\uFF09",
          location: historyFilePath(),
          hint: "\u8FD9\u4E0D\u5F71\u54CD\u5224\u65AD\u80FD\u529B\uFF0C\u4F46\u8BEF\u5224\u68C0\u6D4B\u9700\u8981\u771F\u5B9E\u7ED3\u679C\u624D\u80FD\u89E6\u53D1"
        });
      } else {
        for (const [key, record] of Object.entries(state.records)) {
          const failures = record.entries.filter(
            (entry) => entry.baseline !== true && (entry.signal_type === "ineffective" || entry.signal_type === "type_misjudged")
          ).length;
          const successes = record.entries.filter((entry) => entry.signal_type === "effective").length;
          if (failures >= 3 && successes === 0) {
            findings.push({
              code: "clis.assumption-stuck",
              severity: "warn",
              message: `\u95EE\u9898\u300C${record.description.slice(0, 40)}\u300D\u5728\u540C\u4E00\u56E0\u679C\u5047\u8BBE\u4E0B\u5DF2\u5931\u8D25 ${failures} \u6B21\u3001\u4ECE\u672A\u6210\u529F`,
              location: key,
              hint: "\u8FD9\u4E0D\u662F\u6267\u884C\u95EE\u9898\u800C\u662F\u5224\u636E\u95EE\u9898\uFF1A\u8BE5\u5047\u8BBE\u5F88\u53EF\u80FD\u4ECE\u4E00\u5F00\u59CB\u5C31\u9519\u4E86\uFF0C\u6362\u4E00\u79CD\u56E0\u679C\u7C7B\u578B\u91CD\u65B0\u63D0\u95EE\u6BD4\u7EE7\u7EED\u8C03\u7B56\u7565\u6709\u6548"
            });
          }
        }
      }
    } catch (error) {
      findings.push({
        code: "clis.history-unreadable",
        severity: "error",
        message: `\u5386\u53F2\u6587\u4EF6\u8BFB\u4E0D\u51FA\u6765\uFF1A${String(error?.message ?? error).slice(0, 120)}`,
        location: historyFilePath(),
        hint: "\u8BFB\u4E0D\u51FA\u5386\u53F2\u610F\u5473\u7740\u8BEF\u5224\u68C0\u6D4B\u5931\u6548\uFF0C\u4E14\u4E0D\u4F1A\u6709\u4EFB\u4F55\u62A5\u9519\u63D0\u793A \u2014\u2014 \u68C0\u67E5\u6587\u4EF6\u6743\u9650\u6216\u662F\u5426\u88AB\u5176\u4ED6\u8FDB\u7A0B\u5360\u7528"
      });
    }
    return {
      plugin: "dsh-clis",
      status: deriveStatus(findings),
      findings
    };
  }
  /**
   * 安全读取一个服务，缺失时返回 undefined 而不抛错。
   *
   * Cordis 的 Context 代理对未 inject 的键会抛
   * `cannot get property "X" without inject`，探针不能因此崩掉 ——
   * 它在做的正是"检查这些服务在不在"。
   *
   * @param serviceName 服务名。
   * @returns 服务实例；不可用时 undefined。
   */
  safeGet(serviceName) {
    const getter = this.ctx.get;
    if (typeof getter === "function") {
      try {
        return getter.call(this.ctx, serviceName);
      } catch {
        return void 0;
      }
    }
    try {
      return this.ctx[serviceName];
    } catch {
      return void 0;
    }
  }
  /** 便于诊断时确认跑的是哪一版。 */
  version() {
    return this.pluginVersion;
  }
};

// packages/clis-plugin/src/hot-reload.ts
import { stat } from "node:fs/promises";
import { join as pathJoin } from "node:path";
var POLL_MS = 2e3;
var QUIET_MS = 2e3;
var BACKOFF_MAX_MS = 12e4;
var RELOAD_CORE_SOURCE = String.raw`
// 智能热重载内核 —— 照搬 memory-manager src/reload.js（源自 dsh-our-free-model
// 2.5.3，与内核 HMR 同一套公开原语）。详见该文件头注释。
//
// ⚠️ 改这个文件必须同时提升 CORE_VERSION（下方常量）。写入方按版本号比较，
// **版本低的不会覆盖版本高的** —— 这是"首轮自举不需要重启"的关键：
// 旧监视器想用旧内核覆盖磁盘上的新内核时会被拒绝。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

/** 内核版本：每次改动内核语义都要 +1，且必须与宿主侧 CORE_VERSION 同步。 */
export const CORE_VERSION = 2;

let inFlight = null;
const hooksKey = Symbol.for('dsh-clis.reload-hooks');
const reloadHooks = (globalThis[hooksKey] ??= new Map());

function enableFreshDependencies(packageUrl) {
	if (reloadHooks.has(packageUrl)) return;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			if (!context.parentURL?.startsWith(packageUrl) || !resolved.url.startsWith(packageUrl)) return resolved;
			const generation = new URL(context.parentURL).searchParams.get('dshclis-reload');
			if (generation === null) return resolved;
			const target = new URL(resolved.url);
			target.searchParams.set('dshclis-reload', generation);
			return { ...resolved, url: target.href };
		},
	});
	reloadHooks.set(packageUrl, hook);
}

export function purgeCaches(internal, packageUrl) {
	const backup = { esm: new Map(), cjs: new Map() };
	const cache = internal?.loadCache;
	if (cache !== null && cache !== undefined && typeof cache.keys === 'function' && typeof cache.get === 'function' && typeof cache.delete === 'function') {
		const read = (key) => { try { return Map.prototype.get.call(cache, key); } catch { try { return cache.get(key); } catch { return undefined; } } };
		const drop = (key) => {
			try { Map.prototype.delete.call(cache, key); return; } catch { /* not a real Map */ }
			try { cache.delete(key); } catch { /* best effort */ }
		};
		for (const key of packageCacheKeys(cache, packageUrl)) {
			backup.esm.set(key, read(key));
			drop(key);
		}
	}
	const req = createRequire(import.meta.url);
	for (const key of backup.esm.keys()) {
		try {
			const filePath = fileURLToPath(key);
			if (req.cache[filePath] !== undefined) {
				backup.cjs.set(filePath, req.cache[filePath]);
				delete req.cache[filePath];
			}
		} catch { /* non-file URL */ }
	}
	return backup;
}

function packageCacheKeys(cache, packageUrl) {
	const keys = [];
	for (const key of cache.keys()) {
		if (typeof key === 'string' && key.startsWith(packageUrl)) keys.push(key);
	}
	return keys;
}

export function restoreCaches(internal, backup) {
	const cache = internal?.loadCache;
	for (const [key, job] of backup.esm) {
		try { Map.prototype.set.call(cache, key, job); } catch { try { cache.set(key, job); } catch { /* best effort */ } }
	}
	const req = createRequire(import.meta.url);
	for (const [filePath, module] of backup.cjs) req.cache[filePath] = module;
}

export async function selfReload(ctx, options = {}) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		const logger = options.logger ?? console;
		const packageUrl = options.packageUrl;
		const entryUrl = options.entryUrl;
		const loader = ctx.loader;
		const registry = ctx.registry;
		if (loader === undefined || registry === undefined) {
			return { ok: false, error: '本宿主没有 loader/registry', restored: false };
		}
		const previous = ctx.fiber?.runtime?.callback;
		if (previous === undefined || previous === null) {
			return { ok: false, error: '没有可重载的 runtime', restored: false };
		}
		const runtime = registry.get(previous);
		const fibers = [...(runtime?.fibers ?? [])].map((fiber) => {
			const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined;
			const plugin = typeof previous === 'function' ? { apply: previous, inject: { ...fiber.inject }, Config: runtime.Config, name: runtime.name } : previous;
			return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config };
		});
		if (fibers.length === 0) return { ok: false, error: 'runtime 没有活纤维', restored: false };

		const internal = loader.internal;
		const backup = purgeCaches(internal, packageUrl);

		const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []));
		let replacement;
		try {
			replacement = await importFresh(entryUrl);
			if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
			if (backup.esm.size === 0 || replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
				enableFreshDependencies(packageUrl);
				const freshUrl = new URL(entryUrl);
				freshUrl.searchParams.set('dshclis-reload', String(Date.now()) + '-' + Math.random().toString(36).slice(2));
				replacement = await importFresh(freshUrl.href);
				if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
				if (replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
					throw new Error('cache invalidation 后拿到的仍是旧插件');
				}
			}
		} catch (error) {
			restoreCaches(internal, backup);
			return { ok: false, error: String(error?.message ?? error), restored: true };
		}

		try {
			registry.delete(previous);
			await Promise.allSettled(fibers.map(({ fiber }) => fiber.await()));
		} catch (error) {
			logger.warn?.('clis: hot reload dispose reported ' + String(error?.message ?? error));
		}
		try {
			const created = [];
			for (const { fiber, entry, config } of fibers) {
				const registered = fiber.parent.registry.plugin(replacement, config);
				const fresh = registered.ctx.fiber;
				if (entry !== undefined) { fresh.entry = entry; entry.fiber = fresh; }
				created.push(fresh);
			}
			await Promise.allSettled(created.map((fiber) => fiber.await()));
			return { ok: true, fibers: created.length };
		} catch (error) {
			restoreCaches(internal, backup);
			try {
				const gone = registry.delete(replacement);
				const replacementFibers = gone?.fibers ?? gone?.runtime?.fibers;
				if (replacementFibers) await Promise.allSettled([...replacementFibers].map((f) => f.await()));
			} catch { /* may never have started */ }
			try {
				const restored = [];
				for (const { fiber, entry, plugin, config } of fibers) {
					const registered = fiber.parent.registry.plugin(plugin, config);
					const fresh = registered.ctx.fiber;
					if (entry !== undefined) { fresh.entry = entry; entry.fiber = fresh; }
					restored.push(fresh);
				}
				await Promise.allSettled(restored.map((fiber) => fiber.await()));
				return { ok: false, error: String(error?.message ?? error), restored: true };
			} catch (restoreError) {
				return { ok: false, error: String(restoreError?.message ?? restoreError), restored: false };
			}
		}
	})();
	return inFlight.finally(() => { inFlight = null; });
}

/**
 * 按 entry 换装（四个组件各一条 entry，只换包根换不到它们）。
 *
 * 走 loader 自己的重启路径：entry.update({}, false, true) —— force 让它在
 * options 未变时也触发 partial-dispose → 重新 import → 按 moduleNamespace
 * 换注册。与宿主 HMR 同一条路径，比自己手搓 fiber 更不容易漏。
 *
 * 某条 entry 不存在（用户关了组件）就跳过，不算失败。
 *
 * @param ctx 插件上下文（需要 loader）。
 * @param options.packageUrl 本包目录的 file:// URL（带尾斜杠）。
 * @param options.entries [{ name, file }]：要换装的入口。
 * @param options.logger 日志。
 * @returns { ok, reloaded, error? }。
 */
export async function reloadEntries(ctx, options = {}) {
	const logger = options.logger ?? console;
	const loader = ctx.loader;
	if (loader === undefined || typeof loader.entries !== 'function') {
		return { ok: false, error: '本宿主没有 loader.entries', reloaded: 0 };
	}
	const wanted = new Set((options.entries ?? []).map((item) => item.name));
	if (wanted.size === 0) return { ok: true, reloaded: 0 };

	// 先收集目标 entry（不要边遍历边改，loader 的 entries() 是生成器）。
	const targets = [];
	for (const entry of loader.entries()) {
		const name = entry?.options?.name;
		if (typeof name === 'string' && wanted.has(name)) targets.push(entry);
	}
	if (targets.length === 0) {
		// 组件全被用户关掉了：不是错误。
		return { ok: true, reloaded: 0 };
	}

	// 清本包模块缓存 —— 不清的话 entry.init() 重新 import 拿到的还是旧模块。
	const internal = loader.internal;
	if (internal !== undefined) purgeCaches(internal, options.packageUrl);

	let reloaded = 0;
	for (const entry of targets) {
		try {
			// 为什么要 dispose 再 init，而不是 entry.update({}, false, true)：
			// force 只让 update 走到 _patchContext([])，那一步只更新 config，
			// **不会重新 import 模块** —— 实测 entry.update 之后真机行为毫无变化
			// （2026-10-30：带探针标记的组件已落盘、PID 未变，但 trace note
			// 里没有标记，证明组件模块根本没被重新求值）。
			// 必须先拆掉旧 fiber，再让 loader 走完整的 _init()（import → 换注册）。
			const previous = entry.fiber;
			if (previous !== undefined && previous !== null) {
				previous.dispose();
				try { await previous.await(); } catch { /* 卸载期错误不影响换装 */ }
			}
			await entry.init();
			reloaded += 1;
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error), reloaded };
		}
	}
	logger.info?.('clis: 已换装 ' + reloaded + ' 个组件入口');
	return { ok: true, reloaded };
}
`;
async function ensureReloadCore(installDir) {
  const target = pathJoin(installDir, "reload-core.mjs");
  let existing;
  try {
    existing = await readFile2(target);
    if (existing === RELOAD_CORE_SOURCE) return fileUrl(target);
    if (coreVersionOf(existing) > CORE_VERSION) return fileUrl(target);
  } catch {
  }
  const { writeFile: writeFile22, mkdir: mkdir4 } = await import("node:fs/promises");
  await mkdir4(installDir, { recursive: true });
  await writeFile22(target, RELOAD_CORE_SOURCE, "utf8");
  return fileUrl(target);
}
var CORE_VERSION = 2;
function coreVersionOf(source) {
  const match = /export const CORE_VERSION = (\d+)/u.exec(source);
  return match === null ? 0 : Number(match[1]);
}
async function readFile2(path) {
  const { readFile: readFile5 } = await import("node:fs/promises");
  return readFile5(path, "utf8");
}
function fileUrl(path) {
  return "file:///" + path.replace(/\\/gu, "/").replace(/^\//u, "");
}
function watchedFiles(installDir) {
  return [
    "index.js",
    "clis-classifier.js",
    "clis-strategy.js",
    "clis-feedback.js",
    "clis-orchestrator.js"
  ].map((name2) => pathJoin(installDir, name2));
}
var ENTRY_FILES = {
  "dsh-mind-system/clis": "index.js",
  "dsh-mind-system/clis-classifier": "clis-classifier.js",
  "dsh-mind-system/clis-strategy": "clis-strategy.js",
  "dsh-mind-system/clis-feedback": "clis-feedback.js",
  "dsh-mind-system/clis-orchestrator": "clis-orchestrator.js"
};
async function mtimeFingerprint(installDir) {
  const parts = [];
  for (const file of watchedFiles(installDir)) {
    try {
      const s = await stat(file);
      parts.push(`${file}:${s.mtimeMs}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join("|");
}
async function waitForStableFingerprint(installDir, maxRounds = 10) {
  let previous = await mtimeFingerprint(installDir);
  for (let round = 0; round < maxRounds; round += 1) {
    await sleep(QUIET_MS);
    const current = await mtimeFingerprint(installDir);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}
function startHotReload(ctx, installDir, logger) {
  let stopped = false;
  let timer;
  let baseline = "";
  let consecutiveFailures = 0;
  const loadCore = async () => {
    const coreUrl = await ensureReloadCore(installDir);
    const fresh = `${coreUrl}?v=${Date.now()}`;
    return await import(fresh);
  };
  const tick = async () => {
    if (stopped) return;
    try {
      const current = await mtimeFingerprint(installDir);
      if (baseline !== "" && current !== baseline) {
        const settled = await waitForStableFingerprint(installDir);
        baseline = settled;
        const core = await loadCore();
        logger?.info?.("clis: \u68C0\u6D4B\u5230\u4EE3\u7801\u53D8\u5316\uFF0C\u70ED\u91CD\u8F7D\u4E2D\u2026");
        const componentResult = await reloadComponents(core, ctx, installDir, logger);
        const rootResult = await core.selfReload(ctx, {
          packageUrl: fileUrl(installDir) + "/",
          entryUrl: fileUrl(pathJoin(installDir, "index.js")),
          logger
        });
        const ok = componentResult.ok && rootResult.ok;
        const error = componentResult.error ?? rootResult.error;
        const restored = (componentResult.restored ?? true) && (rootResult.restored ?? true);
        if (ok) {
          consecutiveFailures = 0;
          logger?.info?.(
            `clis: \u70ED\u91CD\u8F7D\u5B8C\u6210\uFF0C\u5305\u6839 ${rootResult.fibers ?? "?"} \u4E2A fiber + ${componentResult.reloaded ?? 0} \u4E2A\u7EC4\u4EF6\u5165\u53E3\u5DF2\u6362\u88C5`
          );
        } else if (restored) {
          consecutiveFailures += 1;
          const backoff = Math.min(BACKOFF_MAX_MS, 4e3 * 2 ** Math.min(consecutiveFailures, 5));
          logger?.warn?.(`clis: \u70ED\u91CD\u8F7D\u5931\u8D25\u5DF2\u56DE\u6EDA\uFF08${error ?? "unknown"}\uFF09\uFF1B${Math.round(backoff / 1e3)}s \u540E\u6062\u590D\u76D1\u89C6`);
          await sleep(backoff);
          baseline = await mtimeFingerprint(installDir);
        } else {
          consecutiveFailures += 1;
          const backoff = Math.min(BACKOFF_MAX_MS, 4e3 * 2 ** Math.min(consecutiveFailures, 5));
          logger?.warn?.(
            `clis: \u70ED\u91CD\u8F7D\u5931\u8D25\u4E14\u672A\u56DE\u6EDA\uFF08${error ?? "unknown"}\uFF09\uFF1B\u5DF2\u8FDE\u7EED\u5931\u8D25 ${consecutiveFailures} \u6B21\uFF0C${Math.round(backoff / 1e3)}s \u540E\u91CD\u8BD5\uFF08\u76D1\u89C6\u5668\u4FDD\u6301\u8FD0\u884C\uFF09`
          );
          await sleep(backoff);
          baseline = await mtimeFingerprint(installDir);
        }
      } else if (baseline === "") {
        baseline = current;
      }
    } catch (error) {
      logger?.warn?.(`clis: \u70ED\u91CD\u8F7D\u76D1\u89C6\u5F02\u5E38\uFF08${String(error?.message ?? error)}\uFF09`);
    }
    if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer !== void 0) clearTimeout(timer);
  };
}
async function reloadComponents(core, ctx, installDir, logger) {
  if (core.reloadEntries === void 0) {
    logger?.warn?.("clis: \u6362\u88C5\u5185\u6838\u7F3A\u5C11 reloadEntries \u2014\u2014 \u672C\u6B21\u53EA\u6362\u5305\u6839\uFF0C\u56DB\u4E2A\u7EC4\u4EF6\u4ECD\u662F\u65E7\u4EE3\u7801");
    return { ok: true, reloaded: 0, restored: true };
  }
  const entries = Object.entries(ENTRY_FILES).filter(([name2]) => name2 !== "dsh-mind-system/clis").map(([name2, file]) => ({ name: name2, file }));
  return core.reloadEntries(ctx, {
    packageUrl: fileUrl(installDir) + "/",
    entries,
    logger
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// packages/clis-plugin/src/intervene.ts
import { join as join3 } from "node:path";

// packages/clis-plugin/src/failure-kind.ts
var MECH_PATTERNS = [
  // 编辑锚点
  /old_string/i,
  /FS_EDIT_NOT_FOUND/i,
  /String to replace/i,
  // 前置条件：先读再改
  /file has not been read/i,
  /file changed (?:since|on disk)/i,
  // 参数形状
  /invalid arguments/i,
  /missing required property/i,
  /unknown tool/i,
  /is only valid together with/i,
  // 路径与转义（Windows 上最常见的一类）
  /Cannot find path/i,
  /ENOENT/i,
  /no such file/i,
  /does not exist/i,
  /ParserError/i,
  /Unexpected token/i,
  /is not recognized as a name of a cmdlet/i,
  /Variable reference is not valid/i,
  /missing terminator/i
];
var INFRA_PATTERNS = [
  // 宿主的 auto-review 前置审查（它自己挂了，工具体根本没执行）
  /Auto review of tool/i,
  // 工具输出形状不合宿主校验（是插件缺陷，不是任务问题）
  /returned invalid output/i,
  /is not lossless JSON/i,
  /must be one of \[/i,
  // 服务注入缺失（同样是插件缺陷）
  /without inject/i,
  /storageDomain/i,
  // 超时与网络
  /timed out after/i,
  /fetch failed/i,
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up/i,
  // 宿主中断/持久化异常
  /interrupted after it was recorded/i,
  /no result was durably recorded/i,
  /hook never ran/i,
  // 平台权限
  /SetNamedSecurityInfoW/i,
  /EPERM|EACCES|access denied/i
];
function classifyFailureKind(tool, message) {
  const haystack = `${tool}
${message}`;
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.test(haystack)) return "INFRA";
  }
  for (const pattern of MECH_PATTERNS) {
    if (pattern.test(haystack)) return "MECH";
  }
  return "SEM";
}
function worthCausalIntervention(kind) {
  return kind === "SEM";
}

// packages/clis-plugin/src/intervene-metrics.ts
import { appendFile, mkdir as mkdir2, readFile as readFile3 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
var METRICS_REL_PATH = join2("storages", "clis-interventions.jsonl");
function metricsFilePath(dshHome) {
  const root = dshHome ?? process.env.DSH_HOME ?? join2(process.env.USERPROFILE ?? "", ".dsh");
  return join2(root, METRICS_REL_PATH);
}
async function recordMetric(dshHome, entry) {
  const path = metricsFilePath(dshHome);
  try {
    await mkdir2(dirname2(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), ...entry })}
`, "utf8");
  } catch {
  }
}
var ADOPTION_WINDOW_MS = 30 * 6e4;
async function summarizeMetrics(dshHome, windowDays = 30) {
  const path = metricsFilePath(dshHome);
  let hinted = 0;
  let adopted = 0;
  let spontaneous = 0;
  let skipped = 0;
  const skippedByReason = {};
  const skippedByGate = {};
  const lastHintAt = /* @__PURE__ */ new Map();
  try {
    const raw = await readFile3(path, "utf8");
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1e3;
    let scanned = 0;
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      if (++scanned > 1e4) break;
      try {
        const e = JSON.parse(s);
        const t = Date.parse(String(e.t));
        if (!Number.isFinite(t) || t < cutoff) continue;
        const agent = typeof e.agent === "string" ? e.agent : "";
        if (e.kind === "hinted") {
          hinted += 1;
          const prior = lastHintAt.get(agent);
          if (prior === void 0 || t > prior) lastHintAt.set(agent, t);
        } else if (e.kind === "adopted") {
          const hintAt = lastHintAt.get(agent);
          if (hintAt !== void 0 && t >= hintAt && t - hintAt <= ADOPTION_WINDOW_MS) {
            adopted += 1;
            lastHintAt.delete(agent);
          } else {
            spontaneous += 1;
          }
        } else if (e.kind === "skipped") {
          skipped += 1;
          const reason = typeof e.reason === "string" && e.reason.length > 0 ? e.reason : "unknown";
          const gate = typeof e.gate === "string" && e.gate.length > 0 ? e.gate : "unknown";
          skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
          skippedByGate[gate] = (skippedByGate[gate] ?? 0) + 1;
        }
      } catch {
      }
    }
  } catch {
  }
  const byCountDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const evaluated = hinted + skipped;
  return {
    hinted,
    adopted,
    // 结构上 adopted ≤ hinted（每次采纳消费一次提示），但仍夹一次以防
    // 将来改动破坏这个不变量 —— 指标宁可保守，不可报出不可能的数值。
    adoptionRate: hinted === 0 ? null : Math.min(adopted / hinted, 1),
    spontaneous,
    skipped,
    skippedByReason: byCountDesc(skippedByReason),
    skippedByGate: byCountDesc(skippedByGate),
    evaluated,
    missRate: evaluated === 0 ? null : skipped / evaluated,
    windowDays
  };
}
async function replayHintedState(dshHome) {
  const path = metricsFilePath(dshHome);
  const hinted = /* @__PURE__ */ new Map();
  const lastIntervened = /* @__PURE__ */ new Map();
  try {
    const raw = await readFile3(path, "utf8");
    let scanned = 0;
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      if (++scanned > 1e4) break;
      try {
        const e = JSON.parse(s);
        const t = Date.parse(String(e.t));
        if (!Number.isFinite(t)) continue;
        const agent = typeof e.agent === "string" ? e.agent : "";
        if (agent.length === 0) continue;
        if (e.kind === "hinted") {
          if (typeof e.signature === "string" && e.signature.length > 0) {
            let set = hinted.get(agent);
            if (set === void 0) {
              set = /* @__PURE__ */ new Set();
              hinted.set(agent, set);
            }
            set.add(e.signature);
            const prior = lastIntervened.get(agent);
            if (prior === void 0 || t > prior) lastIntervened.set(agent, t);
          }
        } else if (e.kind === "adopted") {
          hinted.delete(agent);
          lastIntervened.delete(agent);
        }
      } catch {
      }
    }
  } catch {
  }
  return { hinted, lastIntervened };
}

// packages/clis-plugin/src/intervene.ts
var POST_EXECUTE_EVENT = "tools/post-execute";
var FAILURE_THRESHOLD = 2;
var ESCALATE_THRESHOLD = 3;
var WINDOW_MS = 10 * 6e4;
var COOLDOWN_MS = 10 * 6e4;
function hintTextFor(tone = "repeated") {
  if (tone === "escalating") {
    return [
      "\u540C\u4E00\u4E2A\u5931\u8D25\u6A21\u5F0F\u5DF2\u7ECF\u53CD\u590D\u51FA\u73B0\u591A\u8F6E\u4E86 \u2014\u2014 \u503C\u5F97\u6000\u7591\u7684\u4E0D\u662F\u8FD9\u4E00\u6B65\uFF0C\u800C\u662F**\u4F60\u5224\u65AD\u7684\u56E0\u679C\u7ED3\u6784**\u3002",
      "`clis_run` \u53EF\u4EE5\u5148\u5224\u4E00\u4E0B\uFF1A\u56DE\u8DEF\u4F1A\u8D8A\u4FEE\u8D8A\u5F39\uFF0C\u5BF9\u5076\u4F1A\u4E00\u8FB9\u4FEE\u4E00\u8FB9\u88AB\u62C9\u56DE\u53BB\uFF0C\u5355\u5411\u8981\u8FFD\u6EAF\u5230\u6700\u65E9\u7684\u56E0\u3002",
      '\u5982\u679C\u4E0A\u6B21\u5224\u8FC7\u5E76\u52A8\u624B\u4E86\uFF0C\u628A\u771F\u5B9E\u7ED3\u679C\u56DE\u586B\u5230 `last_outcome` \u2014\u2014 \u5B83\u4F1A\u5728\u53CD\u590D\u5931\u8D25\u65F6\u544A\u8BC9\u4F60"\u8FD9\u4E2A\u56E0\u679C\u5047\u8BBE\u672C\u8EAB\u53EF\u80FD\u662F\u9519\u7684"\u3002',
      "\u4E0D\u5224\u4E5F\u884C\uFF1B\u4F46\u8FD9\u6B21\u522B\u518D\u539F\u6837\u91CD\u8BD5\u4E86\u3002"
    ].join("\n");
  }
  return [
    "\u8FDE\u7EED\u7684\u540C\u7C7B\u5DE5\u5177\u5931\u8D25\u503C\u5F97\u5148\u770B\u4E00\u773C\uFF1A\u8FD9\u4E2A\u5931\u8D25\u6A21\u5F0F\u5DF2\u7ECF\u91CD\u590D\u51FA\u73B0\u3002",
    "`clis_run` \u53EF\u4EE5\u5148\u5224\u4E00\u4E0B\u5B83\u7684\u56E0\u679C\u7ED3\u6784 \u2014\u2014 \u56DE\u8DEF\u4F1A\u8D8A\u4FEE\u8D8A\u5F39\uFF0C\u5BF9\u5076\u4F1A\u4E00\u8FB9\u4FEE\u4E00\u8FB9\u88AB\u62C9\u56DE\u53BB\uFF0C",
    "\u5355\u5411\u8981\u8FFD\u6EAF\u5230\u6700\u65E9\u7684\u56E0\u800C\u4E0D\u662F\u5728\u7ED3\u679C\u5904\u4F7F\u529B\u3002",
    "\u4E0D\u5224\u4E5F\u884C\uFF1B\u4F46\u8FD9\u6B21\u522B\u518D\u539F\u6837\u91CD\u8BD5\u4E86 \u2014\u2014 \u540C\u6837\u7684\u8F93\u5165\u53EA\u4F1A\u5F97\u5230\u540C\u6837\u7684\u5931\u8D25\u3002"
  ].join("\n");
}
function createInterveneState() {
  return {
    windows: /* @__PURE__ */ new Map(),
    lastIntervened: /* @__PURE__ */ new Map(),
    hinted: /* @__PURE__ */ new Map()
  };
}
function createInjectedMessage(text) {
  try {
    return getCreateUserMessage()({
      source: { kind: "plugin:clis" },
      content: [{ type: "text", text }]
    });
  } catch {
  }
  injectedCounter += 1;
  return {
    id: `clis-hint-${Date.now().toString(36)}-${injectedCounter.toString(36)}`,
    role: "user",
    source: { kind: "plugin:clis" },
    content: [{ type: "text", text }]
  };
}
var injectedCounter = 0;
function failureSignature(tool, message) {
  const normalized = firstErrorLine(message).replace(/\d+/g, "#").replace(/\s+/gu, " ").trim().slice(0, 120);
  return `${tool}:${normalized}`;
}
function firstErrorLine(message) {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const ERROR_MARK = /error|failed|failure|not found|cannot|unable|denied|invalid|exception|traceback|✗|✖/i;
  const hit = lines.find((line) => ERROR_MARK.test(line));
  return hit ?? lines[0];
}
var SKIP_GATES = {
  "not-worth-intervening": "gate0-worth",
  "below-threshold": "gate2-window",
  "already-hinted": "gate3a-dedupe",
  cooldown: "gate3b-cooldown"
};
function evaluateIntervention(state, agentId, tool, message, now) {
  const kind = classifyFailureKind(tool, message);
  const signature = failureSignature(tool, message);
  if (!worthCausalIntervention(kind)) {
    return { evaluated: true, skipped: "not-worth-intervening", signature };
  }
  const bucket = `${agentId}\0${tool}`;
  let window = state.windows.get(bucket);
  if (window === void 0) {
    window = [];
    state.windows.set(bucket, window);
  }
  window.push({ at: now, signature });
  while (window.length > 0 && now - window[0].at > WINDOW_MS) {
    window.shift();
  }
  const sameSignature = window.filter((r) => r.signature === signature).length;
  if (sameSignature < FAILURE_THRESHOLD) {
    return { evaluated: true, skipped: "below-threshold", signature };
  }
  let hinted = state.hinted.get(agentId);
  if (hinted === void 0) {
    hinted = /* @__PURE__ */ new Set();
    state.hinted.set(agentId, hinted);
  }
  if (hinted.has(signature)) {
    return { evaluated: true, skipped: "already-hinted", signature };
  }
  const last = state.lastIntervened.get(agentId);
  if (last !== void 0 && now - last < COOLDOWN_MS) {
    return { evaluated: true, skipped: "cooldown", signature };
  }
  hinted.add(signature);
  state.lastIntervened.set(agentId, now);
  return {
    evaluated: true,
    signature,
    hint: hintTextFor(sameSignature >= ESCALATE_THRESHOLD ? "escalating" : "repeated")
  };
}
function markToolUsed(state, agentId) {
  state.lastIntervened.delete(agentId);
  state.hinted.delete(agentId);
}
function failureMessageOf(result) {
  const r = result;
  if (r?.isError !== true) return "";
  if (typeof r.error?.message === "string" && r.error.message.length > 0) {
    return r.error.message;
  }
  if (typeof r.error?.info?.message === "string") return r.error.info.message;
  const text = (r.content ?? []).find((b) => b?.type === "text" && typeof b.text === "string");
  return typeof text?.text === "string" ? text.text : "";
}
function exitCodeFailureOf(result) {
  const r = result;
  if (r?.isError !== false) return void 0;
  const exitCode = r.value?.exitCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0) {
    return void 0;
  }
  if (r.value?.signal !== void 0 && r.value?.signal !== null) return void 0;
  return `exit code ${exitCode}`;
}
function stderrDetailOf(result) {
  const r = result;
  const text = r?.value?.stderr?.text;
  if (typeof text !== "string") return void 0;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function registerIntervener(ctx, state = createInterveneState(), dshHome = process.env.DSH_HOME ?? join3(process.env.USERPROFILE ?? "", ".dsh")) {
  void replayHintedState(dshHome).then((seed) => {
    for (const [agent, signatures] of seed.hinted) {
      let live = state.hinted.get(agent);
      if (live === void 0) {
        live = /* @__PURE__ */ new Set();
        state.hinted.set(agent, live);
      }
      for (const signature of signatures) live.add(signature);
    }
    for (const [agent, at] of seed.lastIntervened) {
      if (!state.lastIntervened.has(agent)) state.lastIntervened.set(agent, at);
    }
  }).catch(() => {
  });
  const host = ctx;
  const subscribe = typeof host.on === "function" ? (event, listener2) => host.on(event, listener2) : host.tools?.on === void 0 ? void 0 : (event, listener2) => host.tools.on(event, listener2);
  if (subscribe === void 0) return void 0;
  const listener = async (exec, result, next) => {
    const decision = await next();
    const e0 = exec;
    const tool0 = typeof e0?.name === "string" ? e0.name : "";
    if (tool0 === "clis_run" || tool0 === "clis_classify") {
      const agentId0 = typeof e0?.agent?.id === "string" ? e0.agent.id : "default";
      const lastHintAt = state.lastIntervened.get(agentId0);
      markToolUsed(state, agentId0);
      void recordMetric(dshHome, {
        kind: "adopted",
        agent: agentId0,
        via: tool0,
        ...lastHintAt === void 0 ? {} : { after_hint_ms: Date.now() - lastHintAt }
      });
      return decision;
    }
    const r = result;
    const exitFailure = r?.isError === true ? void 0 : exitCodeFailureOf(result);
    if (r?.isError !== true && exitFailure === void 0) return decision;
    try {
      const e = exec;
      const tool = typeof e?.name === "string" ? e.name : "unknown";
      const agentId = typeof e?.agent?.id === "string" ? e.agent.id : "default";
      const message = exitFailure !== void 0 ? stderrDetailOf(result) ?? exitFailure : failureMessageOf(result);
      const outcome = evaluateIntervention(state, agentId, tool, message, Date.now());
      if (outcome.hint === void 0) {
        void recordMetric(dshHome, {
          kind: "skipped",
          agent: agentId,
          tool,
          signature: outcome.signature,
          reason: outcome.skipped,
          gate: outcome.skipped === void 0 ? void 0 : SKIP_GATES[outcome.skipped]
        });
        return decision;
      }
      void recordMetric(dshHome, {
        kind: "hinted",
        agent: agentId,
        tool,
        signature: outcome.signature
      });
      const context = createInjectedMessage(outcome.hint);
      return {
        ...decision,
        additionalContexts: [...decision.additionalContexts ?? [], context]
      };
    } catch {
      return decision;
    }
  };
  return subscribe(POST_EXECUTE_EVENT, listener);
}

// packages/clis-plugin/src/probe-registry.ts
var REGISTER_PROBE_EVENT = "clis/register-probe";
var ProbeRegistry = class {
  /** plugin → probe 函数。 */
  table = /* @__PURE__ */ new Map();
  /**
   * 登记一个探针。重复登记同一插件名会覆盖（以最后一次为准）。
   *
   * @param plugin 插件名。
   * @param probe 探针函数。
   * @returns 注销函数。
   */
  add(plugin, probe) {
    this.table.set(plugin, probe);
    return () => {
      if (this.table.get(plugin) === probe) this.table.delete(plugin);
    };
  }
  /**
   * 订阅广播，自动收集探针。
   *
   * @param ctx 插件上下文。
   * @returns 注销函数。
   */
  listen(ctx) {
    const host = ctx;
    if (typeof host.on !== "function") return () => {
    };
    return host.on(REGISTER_PROBE_EVENT, (payload) => {
      if (payload === null || typeof payload !== "object") return;
      const notice = payload;
      if (typeof notice.plugin !== "string" || typeof notice.probe !== "function") return;
      this.add(notice.plugin, notice.probe);
    });
  }
  /**
   * 转成 HealthSupervisor 需要的来源列表。
   *
   * @returns 探针来源。
   */
  sources() {
    return [...this.table.entries()].map(([plugin, probe]) => ({
      plugin,
      probe: async () => probe()
    }));
  }
  /** 已收集的插件名。 */
  plugins() {
    return [...this.table.keys()];
  }
  /** 当前数量。 */
  get size() {
    return this.table.size;
  }
};
var KNOWN_PROBE_KEYS = [
  "clis.healthProbe",
  "memory.healthProbe",
  // 2026-11-02: mind 也进白名单 —— 兜底路径。
  // 首选路径是 mind 主动经 `clis/register-probe` 广播登记（零配合：
  // 别人不必为 mind 改一行代码）；这里是兜底，覆盖广播事件被漏掉、
  // 或未装 CLIS 监听器的场合。
  "mind.healthProbe"
];
function scanKnownProbes(ctx, already) {
  const found = [];
  const getter = ctx.get;
  if (typeof getter !== "function") return found;
  const seen = new Set(already);
  for (const key of KNOWN_PROBE_KEYS) {
    let value;
    try {
      value = getter.call(ctx, key);
    } catch {
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const candidate = value;
    if (typeof candidate.probe !== "function") continue;
    const plugin = value.plugin;
    const name2 = typeof plugin === "string" ? plugin : key;
    if (seen.has(name2)) continue;
    seen.add(name2);
    const probeFn = candidate.probe.bind(value);
    found.push({ plugin: name2, probe: async () => probeFn() });
  }
  return found;
}

// packages/clis-plugin/src/prompt.ts
var SECTION_NAME = "clis-causal-reasoning";
var SECTION_ORDER = 2450;
var SECTION_TEXT = [
  "# \u56E0\u679C\u7ED3\u6784\u5224\u65AD",
  "",
  "\u9047\u5230\u8FD9\u4E9B\u4FE1\u53F7\u65F6\uFF0C\u5148\u5224\u65AD\u56E0\u679C\u7ED3\u6784\u518D\u52A8\u624B\uFF0C\u4E0D\u8981\u76F4\u63A5\u7ED9\u65B9\u6848\uFF1A",
  "- \u6539\u4E86\u53C2\u6570/\u7B56\u7565\u4F46\u6CA1\u6548\u679C\uFF0C\u6216\u53CD\u590D\u8C03\u6574\u53CD\u800C\u66F4\u7CDF",
  "- \u6307\u6807\u6765\u56DE\u9707\u8361\uFF0C\u538B\u4E0B\u53BB\u53C8\u5F39\u56DE\u6765",
  "- \u4E24\u4E2A\u56E0\u7D20\u4E92\u76F8\u5F71\u54CD\uFF0C\u5206\u4E0D\u6E05\u8C01\u662F\u56E0\u8C01\u662F\u679C",
  '- \u60F3\u77E5\u9053"\u8FD9\u4E2A\u63AA\u65BD\u4E3A\u4EC0\u4E48\u65E0\u6548"\uFF0C\u800C\u4E0D\u662F"\u4E0B\u4E00\u6B65\u505A\u4EC0\u4E48"',
  "",
  "`clis_run` \u4F1A\u5224\u5B9A\u662F\u5355\u5411\u56E0\u679C\u3001\u53CD\u9988\u56DE\u8DEF\u3001\u4E92\u4E3A\u5B9A\u4E49\u8FD8\u662F\u591A\u79CD\u7ED3\u6784\u5E76\u5B58\uFF0C",
  "\u5E76\u7ED9\u51FA\u4E0E\u4E4B\u5339\u914D\u7684\u5904\u7406\u8DEF\u5F84\u2014\u2014\u8FD9\u51E0\u79CD\u7ED3\u6784\u9700\u8981\u5B8C\u5168\u76F8\u53CD\u7684\u505A\u6CD5\uFF0C\u5224\u9519\u65B9\u5411\u4F1A\u8BA9\u52AA\u529B\u767D\u8D39\u3002",
  "\u53EA\u60F3\u77E5\u9053\u7ED3\u6784\u4E0D\u60F3\u770B\u65B9\u6848\u65F6\u7528 `clis_classify`\uFF1B\u53EA\u60F3\u770B\u51E0\u79CD\u505A\u6CD5\u53CA\u5176\u4EE3\u4EF7\u65F6\u7528 `clis_plan`\u3002",
  "",
  "\u52A8\u624B\u4E4B\u540E\u518D\u56DE\u6765\u8C03\u7528\u4E00\u6B21\u5E76\u56DE\u586B `last_outcome`\uFF08\u771F\u5B9E\u7ED3\u679C\uFF09\uFF0C",
  '\u53CD\u590D\u65E0\u6548\u65F6\u5B83\u4F1A\u544A\u8BC9\u4F60"\u8FD9\u4E2A\u56E0\u679C\u5047\u8BBE\u672C\u8EAB\u53EF\u80FD\u662F\u9519\u7684"\uFF0C\u800C\u4E0D\u53EA\u662F\u7EE7\u7EED\u7ED9\u65B9\u6848\u3002'
].join("\n");
function registerPromptSection(ctx) {
  const host = ctx;
  if (host.systemPrompt === void 0) return void 0;
  return host.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: SECTION_TEXT
  });
}

// packages/clis-plugin/src/tools.ts
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";

// packages/clis-plugin/src/executor.ts
var ACTION_SIDE_EFFECTS = {
  // —— 只读：观测与解析 ——
  measure_loop_delay: "read",
  measure_loop_gain: "read",
  measure_relation_parameters: "read",
  trace_upstream: "read",
  enumerate_conditions: "read",
  test_necessity: "read",
  map_feedback_loop: "read",
  rank_leverage_points: "read",
  identify_poles: "read",
  extract_definitions: "read",
  confirm_irreversibility: "read",
  probe_environment: "read",
  partition_sub_modules: "read",
  observe_response: "read",
  select_upstream_intervention: "read",
  design_overlay_cause: "read",
  accept_and_plan_around: "read",
  // —— 写：会改变系统 ——
  apply_intervention: "write",
  intervene_at_leverage_point: "write",
  apply_overlay: "write",
  apply_symmetric_adjustment: "write",
  tune_relation_parameter: "write",
  resolve_definition_conflict: "write",
  enforce_condition: "write",
  inject_damping: "write",
  limit_gain: "write",
  shift_delay: "write"
};
var PENDING_APPROVAL = "pending_approval";
function observeInstruction(invocation) {
  return {
    status: "ok",
    observationOnly: true,
    detail: `\u53EA\u8BFB\u89C2\u6D4B\uFF1A${invocation.action}\uFF08\u53C2\u6570 ${JSON.stringify(invocation.params)}\uFF09\u2014\u2014 \u9700\u91C7\u96C6\u5B9E\u9645\u6570\u636E\u540E\u56DE\u586B`
  };
}
var SemiAutoExecutor = class {
  /**
   * @param options.allowWrites 显式放行的写动作白名单；缺省为空（全部拦下）。
   */
  constructor(options = {}) {
    this.options = options;
  }
  options;
  /** 本次执行中请求过的观测动作（供回执展示）。 */
  observations = [];
  /** 被拦下的写动作。 */
  pendingWrites = [];
  /**
   * 执行一个动作：只读放行，写动作拦下等授权。
   *
   * @param invocation 动作调用。
   * @returns 动作回执。
   */
  async execute(invocation) {
    const level = ACTION_SIDE_EFFECTS[invocation.action];
    if (level === void 0) {
      this.pendingWrites.push(invocation.action);
      return {
        status: "failed",
        detail: `\u52A8\u4F5C ${invocation.action} \u672A\u5206\u7EA7\uFF0C\u4E3A\u5B89\u5168\u8D77\u89C1\u4E0D\u81EA\u52A8\u6267\u884C\uFF08\u9700\u4EBA\u5DE5\u786E\u8BA4\u662F\u5426\u53EA\u8BFB\uFF09`
      };
    }
    if (level === "read") {
      this.observations.push(invocation.action);
      return observeInstruction(invocation);
    }
    if (this.options.allowWrites?.includes(invocation.action) === true) {
      return {
        status: "ok",
        detail: `\u5DF2\u653E\u884C\u5199\u52A8\u4F5C ${invocation.action}\uFF08\u5728\u4F60\u7684\u767D\u540D\u5355\u5185\uFF09`
      };
    }
    this.pendingWrites.push(invocation.action);
    return {
      status: "failed",
      detail: `\u5199\u52A8\u4F5C ${invocation.action} \u9700\u6388\u6743\uFF1A\u5B83\u4F1A\u4EA7\u751F\u771F\u5B9E\u526F\u4F5C\u7528\uFF0C\u672C\u6B21\u672A\u6267\u884C\uFF08\u72B6\u6001 ${PENDING_APPROVAL}\uFF09`
    };
  }
};

// packages/clis-plugin/src/health-notifier.ts
var HEALTH_FINDING_EVENT = "clis/health-finding";
function deriveNotices(outcome, uncovered, persisting = []) {
  const notices = [];
  if (uncovered.length > 0) {
    notices.push({
      code: "coverage.no-probe",
      severity: "warn",
      message: `${uncovered.length} \u4E2A\u6D3B\u52A8\u63D2\u4EF6\u6CA1\u6709\u63D0\u4F9B\u5065\u5EB7\u63A2\u9488\uFF0C\u5B83\u4EEC\u7684\u5185\u90E8\u95EE\u9898\u4E0D\u4F1A\u88AB\u4EFB\u4F55\u673A\u5236\u53D1\u73B0`,
      hint: "\u8FD9\u4E0D\u662F\u8FD9\u4E9B\u63D2\u4EF6\u574F\u4E86\uFF0C\u800C\u662F\u5B83\u4EEC\u5904\u5728\u4E86\u76D1\u7763\u76F2\u533A\uFF1B\u8981\u7ED9\u5B83\u4EEC\u52A0\u4E00\u4E2A probe() \u624D\u4F1A\u88AB\u7EB3\u5165",
      plugins: uncovered,
      evidence: uncovered.map((id) => `\u672A\u8986\u76D6\uFF1A${id}`),
      targets: uncovered
    });
  }
  if (persisting.length > 0) {
    notices.push({
      code: "structure.recurring",
      severity: "warn",
      message: `${persisting.length} \u6761\u95EE\u9898\u5728\u4E0A\u4E00\u8F6E\u5DF2\u7ECF\u62A5\u8FC7\u3001\u8FD9\u4E00\u8F6E\u4ECD\u7136\u5B58\u5728\uFF1A\u4E0A\u4E00\u8F6E\u7684\u4FEE\u590D\u6CA1\u6709\u751F\u6548\uFF0C\u6216\u8005\u6839\u672C\u6CA1\u6709\u88AB\u6267\u884C`,
      hint: "\u4E0D\u8981\u7528\u540C\u6837\u7684\u65B9\u5F0F\u518D\u4FEE\u4E00\u904D\uFF1A\u5148\u786E\u8BA4\u4E0A\u4E00\u8F6E\u7684\u5224\u65AD\u662F\u5426\u6210\u7ACB\uFF0C\u6216\u8005\u6362\u4E00\u4E2A\u4F5C\u7528\u70B9",
      plugins: [...new Set(outcome.grouped.flatMap((item) => item.plugins))],
      evidence: persisting.map((code) => `\u8DE8\u8F6E\u4ECD\u5728\uFF1A${code}`),
      targets: [...new Set(outcome.grouped.flatMap((item) => item.plugins))]
    });
  }
  if (outcome.probeErrors.length > 0) {
    notices.push({
      code: "structure.probe-broken",
      severity: "error",
      message: `${outcome.probeErrors.length} \u4E2A\u63D2\u4EF6\u7684\u63A2\u9488\u81EA\u8EAB\u629B\u9519\uFF0C\u8FD9\u610F\u5473\u7740\u5B83\u4EEC\u7684\u95EE\u9898\u76EE\u524D\u5B8C\u5168\u4E0D\u53EF\u89C2\u6D4B`,
      hint: "\u5148\u4FEE\u63A2\u9488\u518D\u770B\u4E1A\u52A1\u95EE\u9898\uFF1A\u89C2\u6D4B\u574F\u4E86\u4F1A\u628A\u771F\u5B9E\u75C5\u7076\u4E00\u8D77\u76D6\u4F4F",
      plugins: outcome.probeErrors.map((item) => item.plugin),
      evidence: outcome.probeErrors.map((item) => `${item.plugin}: ${item.error}`),
      targets: outcome.probeErrors.map((item) => item.plugin)
    });
  }
  const analysis = outcome.analysis;
  if (analysis !== void 0 && outcome.grouped.length > 1) {
    const evidence = outcome.grouped.map(
      (item) => `${item.code} \xD7${item.count}\uFF08${item.plugins.join("\u3001")}\uFF09`
    );
    notices.push({
      code: `structure.${analysis.causalType}`,
      severity: analysis.confidence >= 0.7 ? "warn" : "info",
      message: analysis.summary,
      ...analysis.direction !== void 0 ? { hint: analysis.direction } : {},
      plugins: [...new Set(outcome.grouped.flatMap((item) => item.plugins))],
      evidence,
      targets: [...new Set(outcome.grouped.flatMap((item) => item.plugins))]
    });
  }
  return notices;
}
var HealthNotifier = class {
  /**
   * @param ctx 插件上下文（用于 emit 事件）。
   * @param origin 本插件名。
   */
  constructor(ctx, origin = "dsh-clis") {
    this.ctx = ctx;
    this.origin = origin;
  }
  ctx;
  origin;
  /**
   * 投递结构诊断。
   *
   * @param notices 结构诊断。
   * @returns 通报结果。
   */
  notify(notices) {
    let notifiedPlugins = 0;
    for (const notice of notices) {
      try {
        this.ctx.emit(
          HEALTH_FINDING_EVENT,
          {
            from: this.origin,
            kind: notice.code.startsWith("structure.") ? "structural-diagnosis" : "coverage-gap",
            code: notice.code,
            severity: notice.severity,
            message: notice.message,
            ...notice.hint !== void 0 ? { hint: notice.hint } : {},
            plugins: notice.plugins,
            evidence: notice.evidence,
            targets: notice.targets
          }
        );
        notifiedPlugins += 1;
      } catch {
      }
    }
    return { notifiedPlugins, forUser: notices };
  }
};
function shapeForAgent(outcome, grouped) {
  const structural = outcome.forUser.filter((item) => item.code.startsWith("structure."));
  const coverage = outcome.forUser.filter((item) => item.code.startsWith("coverage."));
  const parts = [];
  if (structural.length > 0) parts.push(`${structural.length} \u6761\u7ED3\u6784\u8BCA\u65AD`);
  if (coverage.length > 0) parts.push(`${coverage.length} \u6761\u8986\u76D6\u7F3A\u53E3`);
  if (parts.length === 0) parts.push("\u65E0\u7ED3\u6784\u6027\u95EE\u9898");
  return {
    structural_count: structural.length,
    coverage_gap_count: coverage.length,
    // 原始警告数只作为规模参考 —— 它们**不在** items 里，
    // 因为那是对方自查的产物，不是 CLIS 的发现。
    raw_finding_count: grouped.reduce((sum, item) => sum + item.count, 0),
    notified_plugins: outcome.notifiedPlugins,
    items: outcome.forUser,
    summary: parts.join("\uFF1B"),
    note: "items \u91CC\u53EA\u6709\u7ED3\u6784\u6027\u5224\u65AD\u3002\u5BF9\u65B9\u81EA\u67E5\u51FA\u7684\u9010\u6761\u95EE\u9898\u4E0D\u5728\u6B64\u5217\u51FA\u2014\u2014\u90A3\u4E9B\u5728\u5404\u81EA\u63D2\u4EF6\u7684\u9762\u677F\u91CC\u5DF2\u6709\u663E\u793A\uFF0C\u91CD\u590D\u642C\u8FD0\u53EA\u4F1A\u9020\u6210\u566A\u97F3\u3002"
  };
}

// packages/clis-plugin/src/health-seen.ts
import { mkdir as mkdir3, readFile as readFile4, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";
var SEEN_VERSION = 1;
var SEEN_REL_PATH = join4("storages", "clis-health-seen.json");
function seenFilePath() {
  const root = process.env.DSH_HOME ?? join4(homedir2(), ".dsh");
  return join4(root, SEEN_REL_PATH);
}
async function readSeenState() {
  try {
    const raw = await readFile4(seenFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && parsed.version === SEEN_VERSION && typeof parsed.findings === "object") {
      return parsed;
    }
  } catch {
  }
  return { version: SEEN_VERSION, findings: {} };
}
async function writeSeenState(state) {
  const path = seenFilePath();
  try {
    await mkdir3(dirname3(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile2(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename2(tmp, path);
  } catch {
  }
}
function reconcileFindings(groupedCodes, previous, escalateAfter = 2, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const dispositions = [];
  const nextFindings = {};
  const seenCodes = /* @__PURE__ */ new Set();
  for (const item of groupedCodes) {
    seenCodes.add(item.code);
    const prior = previous.findings[item.code];
    if (prior === void 0) {
      dispositions.push({
        ...item,
        disposition: "new",
        roundsUnresolved: 1,
        alreadyEscalated: false
      });
      nextFindings[item.code] = {
        code: item.code,
        firstSeenAt: now,
        lastSeenAt: now,
        roundsUnresolved: 1,
        escalated: false
      };
      continue;
    }
    const rounds = prior.roundsUnresolved + 1;
    const shouldEscalate = rounds >= escalateAfter && !prior.escalated;
    dispositions.push({
      ...item,
      disposition: shouldEscalate ? "escalate" : "unresolved",
      roundsUnresolved: rounds,
      alreadyEscalated: prior.escalated
    });
    nextFindings[item.code] = {
      code: item.code,
      firstSeenAt: prior.firstSeenAt,
      lastSeenAt: now,
      roundsUnresolved: rounds,
      escalated: prior.escalated || shouldEscalate
    };
  }
  for (const code of Object.keys(previous.findings)) {
    if (seenCodes.has(code)) continue;
    dispositions.push({
      code,
      severity: "info",
      message: `\u6B64\u524D\u7684 ${code} \u95EE\u9898\u5DF2\u6D88\u5931`,
      plugins: [],
      count: 0,
      disposition: "resolved",
      roundsUnresolved: 0,
      alreadyEscalated: previous.findings[code]?.escalated ?? false
    });
  }
  return { dispositions, next: { version: SEEN_VERSION, findings: nextFindings } };
}

// packages/clis-plugin/src/plugin-scope.ts
var BUILTIN_SEGMENTS = [
  "ui-",
  "session",
  "storage",
  "llm",
  "agent",
  "tool",
  "tools",
  "web",
  "skill",
  "goal",
  "jobs",
  "sandbox",
  "approval",
  "permission",
  "connection",
  "workspace",
  "config",
  "settings",
  "authorization",
  "credential",
  "account",
  "spill",
  "subagent",
  "timeout",
  "image-",
  "repeat-",
  "otel",
  "telemetry",
  "locale",
  "shortcuts",
  "resources",
  "modules",
  "preset",
  "mcp",
  "file-",
  "fs-",
  "shell-",
  "command",
  "terminal",
  "schedule",
  "message-",
  "token-",
  "workflow",
  "trajectory",
  "plan",
  "attachment",
  "remote",
  "typert",
  "cordis",
  "web-startup",
  "webserver",
  "harness-",
  "client-",
  "plugin-",
  "include",
  "timer",
  "hmr"
];
var BUILTIN_SUBSTRINGS = [
  "deepseek-",
  "llm-",
  "session-",
  "subagent-",
  "sandbox",
  "storage-",
  "projection",
  "transcript",
  "isolation",
  "permission",
  "approval",
  "credential",
  "authorization",
  "attachment",
  "telemetry",
  "diagnostic",
  "checkpoint",
  "compaction",
  "serialization",
  "user-questions",
  "working-directory",
  "subprocess",
  "system-prompt",
  "open-in-app",
  "directory-picker",
  "job-controller",
  "api-remotes",
  "office-to-pdf",
  "pwsh-",
  "ptc-",
  "experimental-",
  "turn-",
  "usage-",
  "cancel-",
  "shutdown-",
  "startup-",
  "lifecycle",
  "registry",
  "inventory"
];
function isBuiltin(id) {
  if (id.startsWith("@deepseek-ai/")) return true;
  if (id.startsWith("@")) return true;
  if (/^[0-9a-f]{8}$/u.test(id)) return true;
  if (id.startsWith("dsh-")) return false;
  for (const seg of BUILTIN_SEGMENTS) {
    if (id === seg || id.startsWith(seg)) return true;
  }
  for (const part of BUILTIN_SUBSTRINGS) {
    if (id.includes(part)) return true;
  }
  return false;
}
function findProbeExport(namespace) {
  if (namespace === null || namespace === void 0 || typeof namespace !== "object") return void 0;
  const ns = namespace;
  const candidate = ns["healthProbe"] ?? ns["probe"];
  if (candidate === null || candidate === void 0) return void 0;
  if (typeof candidate === "object") {
    return typeof candidate.probe === "function" ? candidate : void 0;
  }
  if (typeof candidate === "function") return candidate;
  return void 0;
}
function normalizeInject(raw) {
  if (raw === null || raw === void 0) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item) => typeof item === "string");
  }
  if (typeof raw === "object") return Object.keys(raw);
  return [];
}
function listPlugins(ctx) {
  const loader = ctx.loader;
  if (loader === void 0 || typeof loader.entries !== "function") return [];
  const found = [];
  try {
    for (const entry of loader.entries()) {
      const rawId = entry.options?.id ?? entry.options?.name;
      if (typeof rawId !== "string" || rawId.length === 0) continue;
      const state = typeof entry.fiber?.state === "number" ? entry.fiber.state : 0;
      let disabled = false;
      try {
        disabled = entry.disabled === true;
      } catch {
      }
      found.push({
        id: rawId,
        state,
        external: !isBuiltin(rawId),
        disabled,
        declaredInject: normalizeInject(entry.options?.inject),
        probeExport: findProbeExport(entry.moduleNamespace),
        moduleLoaded: entry.moduleNamespace !== void 0,
        exportForm: detectExportForm(entry.moduleNamespace),
        isGroup: Boolean(entry.options?.group),
        importing: entry._initTask !== void 0,
        live: entry
      });
    }
  } catch {
    return [];
  }
  return found;
}
function detectExportForm(namespace) {
  if (namespace === null || namespace === void 0) return "unknown";
  if (typeof namespace !== "object") {
    return typeof namespace === "function" ? "default" : "invalid";
  }
  const ns = namespace;
  if (typeof ns["default"] === "function") return "default";
  if (typeof ns["apply"] === "function") return "apply";
  return "invalid";
}
function liveState(plugin) {
  try {
    const entry = plugin.live;
    return typeof entry?.fiber?.state === "number" ? entry.fiber.state : plugin.state;
  } catch {
    return plugin.state;
  }
}
function serviceAvailable(ctx, name2) {
  const getter = ctx.get;
  if (typeof getter !== "function") return true;
  try {
    return getter.call(ctx, name2) !== void 0;
  } catch {
    return false;
  }
}
function structuralProbe(ctx, plugin) {
  return {
    plugin: plugin.id,
    probe: async () => {
      const findings = [];
      const state = liveState(plugin);
      if (!plugin.disabled && !plugin.isGroup && !plugin.importing && !plugin.moduleLoaded) {
        findings.push({
          code: "auto.import-failed",
          severity: "warn",
          message: `${plugin.id} \u7684\u6A21\u5757\u6CA1\u6709\u5BFC\u5165\u6210\u529F\uFF1A\u5B83\u4E0D\u4F1A\u63D0\u4F9B\u4EFB\u4F55\u529F\u80FD`,
          hint: '\u6700\u5E38\u89C1\u6210\u56E0\u662F package.json \u7F3A exports["."]\uFF08Loader \u4F1A\u9759\u9ED8\u8DF3\u8FC7\u6574\u4E2A\u5305\uFF0Cpatch \u884C\u5168 absent\uFF09\uFF1B\u5176\u6B21\u662F\u6A21\u5757\u5728\u5BFC\u5165\u671F\u629B\u9519 \u2014\u2014 \u4E24\u8005\u90FD\u4F1A\u5728\u5BBF\u4E3B\u65E5\u5FD7\u7559\u4E00\u6761 error'
        });
      }
      if (plugin.moduleLoaded && plugin.exportForm === "invalid") {
        findings.push({
          code: "auto.export-form-invalid",
          severity: "error",
          message: `${plugin.id} \u7684\u5BFC\u51FA\u5F62\u6001\u4E0D\u7B26\u5408\u63D2\u4EF6\u6807\u51C6\uFF1A\u65E2\u6CA1\u6709\u53EF\u7528\u7684 default\uFF0C\u4E5F\u6CA1\u6709\u5177\u540D apply`,
          hint: "\u6807\u51C6\u53EA\u63A5\u53D7\u4E24\u79CD\u5F62\u6001\uFF08\u4E0D\u53EF\u6DF7\u7528\uFF09\uFF1Aexport function apply(ctx, config)\uFF0C\u6216 default \u5BFC\u51FA Service \u7C7B\uFF1B\u636E\u6B64\u6539\u63D2\u4EF6\u5165\u53E3"
        });
      }
      if (state === 1) {
        findings.push({
          code: "auto.fiber-loading",
          severity: "warn",
          message: `${plugin.id} \u4E00\u76F4\u5904\u4E8E\u88C5\u8F7D\u4E2D\uFF08fiber state=1\uFF09\uFF1A\u53EF\u80FD\u4F9D\u8D56\u672A\u6EE1\u8DB3\u6216\u521D\u59CB\u5316\u672A\u5B8C\u6210`,
          hint: "\u88C5\u8F7D\u4E2D\u7684\u63D2\u4EF6\u4E0D\u63D0\u4F9B\u4EFB\u4F55\u529F\u80FD\uFF0C\u4F46\u901A\u5E38\u4E0D\u62A5\u9519\uFF1B\u67E5\u5B83\u58F0\u660E\u7684 inject \u662F\u5426\u90FD\u80FD\u6EE1\u8DB3"
        });
      }
      if (state === 0 && !plugin.disabled) {
        findings.push({
          code: "auto.fiber-inactive",
          severity: "warn",
          message: `${plugin.id} \u672A\u88AB\u5173\u95ED\u5374\u5904\u4E8E\u672A\u6FC0\u6D3B\uFF08fiber state=0\uFF09\uFF1A\u88C5\u8F7D\u53EF\u80FD\u5DF2\u5931\u8D25`,
          hint: "\u672A\u6FC0\u6D3B\u7684\u63D2\u4EF6\u4E0D\u63D0\u4F9B\u4EFB\u4F55\u529F\u80FD\uFF0C\u4E5F\u901A\u5E38\u4E0D\u51FA\u73B0\u5728\u9519\u8BEF\u65E5\u5FD7\u91CC\uFF1B\u68C0\u67E5\u5B83\u7684\u88C5\u8F7D\u62A5\u9519"
        });
      }
      const missing = plugin.declaredInject.filter((name2) => !serviceAvailable(ctx, name2));
      if (missing.length > 0) {
        findings.push({
          code: "auto.missing-dependency",
          severity: "error",
          message: `${plugin.id} \u58F0\u660E\u7684\u4F9D\u8D56\u4E2D\u6709 ${missing.length} \u4E2A\u670D\u52A1\u4E0D\u5B58\u5728\uFF1A${missing.join("\u3001")}`,
          hint: "\u4F9D\u8D56\u672A\u6EE1\u8DB3\u4F1A\u8BA9\u63D2\u4EF6\u9759\u9ED8\u505C\u7559\u5728\u7B49\u5F85\u72B6\u6001\u3001\u529F\u80FD\u5B8C\u5168\u4E0D\u53EF\u7528\uFF1B\u786E\u8BA4\u63D0\u4F9B\u8BE5\u670D\u52A1\u7684\u63D2\u4EF6\u662F\u5426\u5DF2\u88C5\u8F7D"
        });
      }
      const status = findings.some((f) => f.severity === "error") ? "failing" : findings.length > 0 ? "degraded" : "ok";
      return { plugin: plugin.id, status, findings };
    }
  };
}
function wrapExportedProbe(pluginId, exported) {
  return {
    plugin: pluginId,
    probe: async () => {
      try {
        let raw;
        if (typeof exported === "function") {
          const first = await exported();
          raw = first !== null && typeof first === "object" && typeof first.probe === "function" ? await first.probe() : first;
        } else {
          raw = await exported.probe();
        }
        const report = raw;
        const findings = Array.isArray(report?.findings) ? report.findings : [];
        const status = report?.status === "ok" || report?.status === "degraded" || report?.status === "failing" ? report.status : findings.length > 0 ? "degraded" : "ok";
        return { plugin: pluginId, status, findings };
      } catch (error) {
        return {
          plugin: pluginId,
          status: "failing",
          findings: [
            {
              code: "auto.probe-broken",
              severity: "error",
              message: `${pluginId} \u5BFC\u51FA\u7684\u63A2\u9488\u81EA\u8EAB\u629B\u9519\uFF1A${String(error?.message ?? error).slice(0, 160)}`,
              hint: "\u63A2\u9488\u574F\u4E86\u4F1A\u8BA9\u8BE5\u63D2\u4EF6\u7684\u95EE\u9898\u5B8C\u5168\u4E0D\u53EF\u89C2\u6D4B\uFF0C\u6BD4\u5B83\u539F\u672C\u8981\u62A5\u7684\u95EE\u9898\u66F4\u8BE5\u5148\u4FEE"
            }
          ]
        };
      }
    }
  };
}
function autoSources(ctx, plugins, explicit = []) {
  const norm = (name2) => name2.replace(/^dsh-/u, "").toLowerCase();
  const explicitIds = new Set(explicit.map((item) => norm(item.plugin)));
  const sources = [...explicit];
  const domainCovered = [...new Set(explicit.map((item) => item.plugin))];
  const structuralOnly = [];
  const candidates = plugins.filter((item) => item.external && !item.disabled);
  const seen = /* @__PURE__ */ new Set();
  for (const plugin of candidates) {
    const key = norm(plugin.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (explicitIds.has(key)) continue;
    if (plugin.probeExport !== void 0) {
      sources.push(wrapExportedProbe(plugin.id, plugin.probeExport));
      domainCovered.push(plugin.id);
      continue;
    }
    sources.push(structuralProbe(ctx, plugin));
    structuralOnly.push(plugin.id);
  }
  return { sources, total: candidates.length, domainCovered, structuralOnly };
}
function buildScope(plugins, sources) {
  const active = plugins.filter((item) => item.state === 2);
  const external = active.filter((item) => item.external && !item.disabled);
  const externalIds = external.map((item) => item.id);
  const probedIds = sources.map((item) => item.plugin);
  const uncovered = externalIds.filter(
    (id) => !probedIds.some((probed) => probed === id || id.endsWith(probed) || probed.endsWith(id))
  );
  return {
    scope: { plugins: [...probedIds], sources: [...sources] },
    activeTotal: active.length,
    externalTotal: external.length,
    uncovered
  };
}

// packages/clis-plugin/src/health-supervisor.ts
var HealthSupervisor = class {
  /**
   * @param ctx 插件上下文（用于取分类器与各探针）。
   * @param sources 探针来源列表。
   */
  constructor(ctx, sources) {
    this.ctx = ctx;
    this.sources = sources;
  }
  ctx;
  sources;
  /**
   * 跑一次互查。
   *
   * @returns 汇总结论与结构分析。
   */
  async run() {
    const reports = [];
    const probeErrors = [];
    for (const source of this.sources) {
      try {
        reports.push(await source.probe());
      } catch (error) {
        probeErrors.push({
          plugin: source.plugin,
          error: String(error?.message ?? error).slice(0, 200)
        });
      }
    }
    const grouped = groupFindings(reports);
    const status = overallStatus(reports, probeErrors);
    const analysis = await this.analyse(grouped, probeErrors);
    return { reports, grouped, status, probeErrors, ...analysis !== void 0 ? { analysis } : {} };
  }
  /**
   * 让分类器判断这些问题的因果结构。
   *
   * 判据是**从聚合结果推断**的，不是人工写死的：
   * - 同一 code 反复出现（count>1）⇒ 有反馈环：出现→修补→再出现
   * - 多个 code 指向同一 location ⇒ 互为定义/同一根因
   * - 探针自身抛错 ⇒ 需要先修观测能力，不是业务问题
   *
   * @param grouped 聚合后的发现。
   * @param probeErrors 探针失败记录。
   * @returns 结构分析；无法判断时 undefined。
   */
  async analyse(grouped, probeErrors) {
    if (grouped.length === 0 && probeErrors.length === 0) return void 0;
    const getter = this.ctx.get;
    const classifier = typeof getter === "function" ? getter.call(this.ctx, "clis.causalClassifier") : void 0;
    if (classifier === void 0) return void 0;
    const errorCount = grouped.filter((item) => item.severity === "error").length;
    const hasProbeFailure = probeErrors.length > 0;
    const hasSameOrigin = grouped.length > 1 && sameLocation(grouped);
    const isSinglePoint = grouped.length === 1 && !hasProbeFailure;
    const questions = {
      q1_simultaneous_mutual_definition: !hasProbeFailure && hasSameOrigin ? "yes" : "no",
      // 见规则二：回路只能由跨轮数据判定，此处不作断言
      q2_delayed_mutual_influence: "no",
      q3_strict_irreversible_order: isSinglePoint ? "yes" : "no",
      // Q4 多结构并存：既有探针故障又有业务问题
      q4_coexisting_causal_structures: probeErrors.length > 0 && grouped.length > 0 ? "yes" : "no"
    };
    try {
      const result = await classifier.classify({
        description: `\u63D2\u4EF6\u4F53\u68C0\u53D1\u73B0 ${grouped.length} \u7C7B\u95EE\u9898\uFF08${errorCount} \u4E2A error\uFF09`,
        answers: questions
      });
      return {
        causalType: result.causal_type,
        confidence: result.confidence,
        questions,
        summary: summarise(result.causal_type, grouped, probeErrors),
        ...directionFor(result.causal_type) !== void 0 ? { direction: directionFor(result.causal_type) } : {}
      };
    } catch {
      return void 0;
    }
  }
};
function sameLocation(grouped) {
  const locations = new Set(grouped.map((item) => item.plugins.join(",")));
  return locations.size === 1;
}
function groupFindings(reports) {
  const table = /* @__PURE__ */ new Map();
  for (const report of reports) {
    for (const finding of report.findings) {
      const slot = table.get(finding.code) ?? { findings: [], plugins: /* @__PURE__ */ new Set() };
      slot.findings.push(finding);
      slot.plugins.add(report.plugin);
      table.set(finding.code, slot);
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return [...table.entries()].map(([code, slot]) => {
    const worst = slot.findings.reduce(
      (current, item) => rank[item.severity] < rank[current] ? item.severity : current,
      "info"
    );
    return {
      code,
      severity: worst,
      count: slot.findings.length,
      plugins: [...slot.plugins],
      message: slot.findings[0]?.message ?? "",
      hints: [...new Set(slot.findings.map((item) => item.hint).filter((hint) => hint !== void 0))]
    };
  }).sort((left, right) => rank[left.severity] - rank[right.severity]);
}
function overallStatus(reports, probeErrors) {
  if (probeErrors.length > 0) return "failing";
  if (reports.some((item) => item.status === "failing")) return "failing";
  if (reports.some((item) => item.status === "degraded")) return "degraded";
  return "ok";
}
function summarise(causalType, grouped, probeErrors) {
  switch (causalType) {
    // 注意：这里不再声称"反复出现" —— 轮内数据判不出回路（见 analyse 的
    // 规则二）。回路由 deriveNotices 用跨轮数据单独报 `structure.recurring`。
    case "cyclic":
      return `\u8FD9 ${grouped.length} \u7C7B\u95EE\u9898\u53EF\u80FD\u76F8\u4E92\u7275\u52A8\uFF0C\u9010\u6761\u4FEE\u672A\u5FC5\u6709\u6548`;
    case "structural_duality":
      return `\u8FD9 ${grouped.length} \u7C7B\u95EE\u9898\u540C\u5C5E\u4E00\u4E2A\u63D2\u4EF6\u6216\u4E00\u5904\u4F4D\u7F6E\uFF0C\u53EF\u80FD\u662F\u540C\u4E00\u4E2A\u4EA7\u751F\u73AF\u8282\u7684\u4E0D\u540C\u8868\u73B0`;
    case "nested":
      return `\u5B58\u5728\u591A\u79CD\u7ED3\u6784\u5E76\u5B58${probeErrors.length > 0 ? "\uFF08\u542B\u63A2\u9488\u81EA\u8EAB\u6545\u969C\uFF09" : ""}\uFF1A\u9700\u62C6\u5F00\u5206\u522B\u5904\u7406\uFF0C\u5148\u4FEE\u89C2\u6D4B\u80FD\u529B\u518D\u770B\u4E1A\u52A1\u95EE\u9898`;
    case "unidirectional":
      return "\u8FD9\u662F\u5355\u70B9\u95EE\u9898\uFF0C\u76F4\u63A5\u5904\u7406\u5373\u53EF";
    default:
      return `\u53D1\u73B0 ${grouped.length} \u7C7B\u95EE\u9898\uFF0C\u4F46\u4FE1\u606F\u4E0D\u8DB3\u4EE5\u5224\u65AD\u7ED3\u6784`;
  }
}
function directionFor(causalType) {
  switch (causalType) {
    case "cyclic":
      return "\u8FD9\u4E9B\u95EE\u9898\u53EF\u80FD\u76F8\u4E92\u7275\u52A8\uFF0C\u9010\u6761\u4FEE\u672A\u5FC5\u6709\u6548\uFF1B\u5148\u770B\u5B83\u4EEC\u662F\u5426\u5171\u4EAB\u540C\u4E00\u4E2A\u4EA7\u751F\u73AF\u8282";
    case "structural_duality":
      return "\u5148\u786E\u8BA4\u8FD9\u51E0\u7C7B\u95EE\u9898\u662F\u5426\u51FA\u81EA\u540C\u4E00\u4E2A\u4EA7\u751F\u73AF\u8282\uFF1A\u82E5\u540C\u6E90\uFF0C\u53EA\u6539\u5176\u4E2D\u4E00\u7C7B\u5269\u4E0B\u7684\u4ECD\u5728";
    case "nested":
      return "\u5148\u4FEE\u63A2\u9488/\u89C2\u6D4B\u80FD\u529B\uFF0C\u518D\u5904\u7406\u4E1A\u52A1\u95EE\u9898\uFF1A\u89C2\u6D4B\u574F\u4E86\u4F1A\u63A9\u76D6\u771F\u5B9E\u75C5\u7076";
    case "unidirectional":
      return "\u5B9A\u4F4D\u6700\u65E9\u53EF\u5E72\u9884\u7684\u90A3\u4E2A\u56E0\uFF0C\u4E00\u6B21\u6539\u5230";
    default:
      return void 0;
  }
}

// packages/clis-plugin/src/tool-json.ts
function toToolJson(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== void 0).map((item) => toToolJson(item));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === void 0) continue;
      result[key] = toToolJson(item);
    }
    return result;
  }
  return value;
}

// packages/clis-plugin/src/tools.ts
function toolRuntime(ctx) {
  return ctx.tools;
}
var SERVICE_CLASSIFIER = "clis.causalClassifier";
var SERVICE_STRATEGY = "clis.causalStrategy";
var SERVICE_ORCHESTRATOR = "clis.causalOrchestrator";
var FOUR_QUESTION_PROPS = {
  q1: "Q1\uFF1AA \u4E0E B \u662F\u5426\u540C\u65F6\u6210\u7ACB\u3001\u5F7C\u6B64\u5B9A\u4E49\u3001\u4E14\u65E0\u65F6\u95F4\u5148\u540E\uFF1F",
  q2: "Q2\uFF1A\u662F\u5426\u5B58\u5728\u5E26\u65F6\u95F4\u5EF6\u8FDF\u7684\u76F8\u4E92\u5F71\u54CD\uFF08A\u2192B\u2192A\uFF0C\u53EF\u80FD\u632F\u8361\uFF09\uFF1F",
  q3: "Q3\uFF1A\u662F\u5426 A\u2192B \u4E25\u683C\u5148\u540E\u4E14\u4E0D\u53EF\u9006\uFF1F",
  q4: "Q4\uFF1A\u7CFB\u7EDF\u4E2D\u662F\u5426\u540C\u65F6\u5B58\u5728\u591A\u79CD\u56E0\u679C\u7ED3\u6784\uFF08\u9700\u62C6\u5B50\u6A21\u5757\uFF09\uFF1F"
};
function toProblem(raw) {
  const args = raw;
  const answers = {
    q1_simultaneous_mutual_definition: args.q1,
    q2_delayed_mutual_influence: args.q2,
    q3_strict_irreversible_order: args.q3,
    q4_coexisting_causal_structures: args.q4
  };
  return { description: args.description, answers };
}
function toBoundary(raw) {
  const forbidden = raw.forbidden_actions;
  return { forbidden_actions: forbidden ?? [] };
}
function questionParams() {
  const params = {};
  for (const [key, text] of Object.entries(FOUR_QUESTION_PROPS)) {
    params[key] = {
      type: "string",
      required: true,
      enum: ["yes", "no", "unknown"],
      description: text
    };
  }
  return params;
}
function registerTools(ctx, healthSources = () => []) {
  const defineTool = getDefineTool();
  const history = new ClisHistoryStore();
  toolRuntime(ctx).register(
    defineTool({
      name: "clis_run",
      description: '\u5F53\u6539\u52A8\u53CD\u590D\u65E0\u6548\u3001\u8D8A\u8C03\u8D8A\u7CDF\u3001\u6307\u6807\u6765\u56DE\u9707\u8361\uFF0C\u6216\u4E24\u4E2A\u56E0\u7D20\u5206\u4E0D\u6E05\u8C01\u56E0\u8C01\u679C\u65F6\uFF0C\u5148\u5224\u65AD\u56E0\u679C\u7ED3\u6784\u518D\u52A8\u624B\u3002\u56E0\u4E3A"\u5355\u5411\u56E0\u679C"\u548C"\u53CD\u9988\u56DE\u8DEF"\u9700\u8981\u5B8C\u5168\u76F8\u53CD\u7684\u5904\u7406\uFF1A\u524D\u8005\u8BE5\u6EAF\u6E90\u5230\u6700\u65E9\u53EF\u5E72\u9884\u7684\u56E0\uFF0C\u540E\u8005\u5728\u73AF\u4E0A\u786C\u63A8\u4F1A\u52A0\u5267\u9707\u8361\u3002\u8FD4\u56DE\u56E0\u679C\u7C7B\u578B\u3001\u5224\u65AD\u4F9D\u636E\uFF0C\u4EE5\u53CA\u6309\u8BE5\u7C7B\u578B\u6392\u5E8F\u7684\u7B56\u7565\u8DEF\u5F84\u3002\u628A\u4E0A\u6B21\u52A8\u624B\u7684\u771F\u5B9E\u7ED3\u679C\u56DE\u586B\u5230 last_outcome\uFF0C\u53CD\u590D\u65E0\u6548\u65F6\u5B83\u4F1A\u5224\u5B9A\u7C7B\u578B\u5047\u8BBE\u6709\u8BEF\u5E76\u5EFA\u8BAE\u6362\u4E00\u79CD\u56E0\u679C\u89E3\u91CA\u3002',
      parameters: {
        description: {
          type: "string",
          required: true,
          description: '\u4E00\u53E5\u8BDD\u8BF4\u6E05 A \u4E0E B \u7684\u5173\u7CFB\uFF0C\u4EE5\u53CA\u4F60\u89C2\u5BDF\u5230\u7684\u73B0\u8C61\uFF08\u5982"\u8C03\u9AD8\u4EF7\u683C\u60F3\u6291\u5236\u9700\u6C42\uFF0C\u9700\u6C42\u77ED\u6682\u4E0B\u964D\u540E\u53C8\u53CD\u5F39"\uFF09\u3002'
        },
        ...questionParams(),
        forbidden_actions: {
          type: "array",
          description: "\u53EF\u9009\uFF1A\u7981\u6B62\u6267\u884C\u7684\u52A8\u4F5C\u540D\u5217\u8868\uFF0C\u7B56\u7565\u4E0D\u4F1A\u628A\u5B83\u4EEC\u6392\u8FDB\u8DEF\u5F84\u3002",
          items: { type: "string" }
        },
        last_outcome: {
          type: "string",
          enum: ["achieved", "failed", "not_tried"],
          description: "\u53EF\u9009\uFF1A\u4E0A\u4E00\u6B21\u6309\u672C\u5DE5\u5177\u5EFA\u8BAE\u52A8\u624B\u540E\u7684\u771F\u5B9E\u7ED3\u679C\u3002achieved=\u95EE\u9898\u89E3\u51B3/\u6307\u6807\u6539\u5584\uFF1Bfailed=\u505A\u4E86\u4F46\u6CA1\u6548\u679C\u6216\u66F4\u7CDF\uFF1Bnot_tried=\u8FD8\u6CA1\u52A8\u624B\uFF08\u9996\u6B21\u5206\u6790\u65F6\u7528\uFF09\u3002\u4E0D\u586B\u89C6\u4E3A\u672A\u8BB0\u5F55\uFF0C\u53CD\u9988\u5C06\u65E0\u6CD5\u5224\u5B9A\u7C7B\u578B\u8BEF\u5224\u3002"
        },
        last_detail: {
          type: "string",
          description: "\u53EF\u9009\uFF1A\u4E0A\u4E00\u8F6E\u5B9E\u9645\u53D1\u751F\u4E86\u4EC0\u4E48\uFF08\u4E00\u53E5\u8BDD\uFF09\u3002\u4F1A\u968F\u7740\u7ED3\u679C\u4E00\u8D77\u5F52\u6863\uFF0C\u4F9B\u4E0B\u6B21\u5224\u65AD\u65F6\u56DE\u770B\u3002"
        },
        allow_writes: {
          type: "array",
          description: "\u53EF\u9009\uFF1A\u663E\u5F0F\u653E\u884C\u7684**\u5199\u52A8\u4F5C**\u767D\u540D\u5355\u3002\u6267\u884C\u5668\u9ED8\u8BA4\u53EA\u81EA\u52A8\u6267\u884C\u53EA\u8BFB\u52A8\u4F5C\uFF08\u6D4B\u91CF/\u8FFD\u6EAF/\u679A\u4E3E/\u5B9A\u4F4D\uFF09\uFF1B\u5199\u52A8\u4F5C\uFF08\u65BD\u52A0\u5E72\u9884/\u8C03\u53C2/\u6CE8\u5165\u963B\u5C3C/\u6539\u5EF6\u8FDF/\u8986\u76D6\u65E7\u56E0\uFF09\u4E00\u5F8B\u62E6\u4E0B\u3002\u53EA\u6709\u4F60\u660E\u786E\u5217\u51FA\u67D0\u4E2A\u5199\u52A8\u4F5C\uFF0C\u5B83\u624D\u4F1A\u88AB\u6267\u884C\u3002",
          items: { type: "string" }
        }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      async execute(rawArgs) {
        const orchestrator = ctx[SERVICE_ORCHESTRATOR];
        if (orchestrator === void 0) {
          throw new Error("CLIS \u672A\u5C31\u7EEA\uFF1Aclis.causalOrchestrator \u670D\u52A1\u4E0D\u53EF\u7528");
        }
        const problem = toProblem(rawArgs);
        const key = fingerprint(problem.description, problem.answers);
        const prior = await history.read(key);
        const lastOutcome = rawArgs.last_outcome;
        if (lastOutcome !== void 0 && lastOutcome !== "not_tried" && prior !== void 0) {
          const previousType = prior.entries.at(-1)?.causal_type ?? "unknown";
          const priorFailures = prior.entries.filter(
            (entry) => entry.baseline !== true && (entry.signal_type === "ineffective" || entry.signal_type === "type_misjudged")
          ).length;
          const signalOnFailure = priorFailures > 0 ? "type_misjudged" : "ineffective";
          await history.append(key, problem.description, {
            causal_type: previousType === "unknown" ? "unknown" : previousType,
            signal_type: lastOutcome === "achieved" ? "effective" : signalOnFailure,
            achieved: lastOutcome === "achieved",
            detail: rawArgs.last_detail ?? `\u56DE\u586B\u7ED3\u679C\uFF1A${lastOutcome}`,
            at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        const preClassified = await ctx[SERVICE_CLASSIFIER]?.classify(problem);
        const priorSignals = ClisHistoryStore.signalsFor(
          prior,
          preClassified?.causal_type ?? "unknown"
        );
        const priorRollbacks = ClisHistoryStore.rollbacksFor(
          prior,
          preClassified?.causal_type ?? "unknown"
        );
        const allowWrites = rawArgs.allow_writes;
        const executor = new SemiAutoExecutor({ allowWrites });
        const result = await orchestrator.run(problem, {
          boundary: toBoundary(rawArgs),
          executor,
          ...priorSignals.length > 0 || priorRollbacks > 0 ? {
            history: {
              previous_signals: priorSignals,
              ...priorRollbacks > 0 ? { rollback_count: priorRollbacks } : {}
            }
          } : {}
        });
        if (prior === void 0) {
          await history.append(key, problem.description, {
            causal_type: result.classification?.causal_type ?? "unknown",
            signal_type: "ineffective",
            achieved: false,
            baseline: true,
            detail: "\u672C\u8F6E\u4EC5\u505A\u5224\u65AD\u4E0E\u89C4\u5212\uFF0C\u5C1A\u672A\u52A8\u624B",
            at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        const priorSignalsAfter = ClisHistoryStore.signalsFor(
          await history.read(key),
          result.classification?.causal_type ?? "unknown"
        );
        const afterRecord = await history.read(key);
        const priorRollbacksAfter = ClisHistoryStore.rollbacksFor(
          afterRecord,
          result.classification?.causal_type ?? "unknown"
        );
        const priorFailuresAfter = ClisHistoryStore.failures(afterRecord);
        return toToolJson({
          problem_key: key,
          outcome: result.outcome,
          causal_type: result.classification?.causal_type,
          confidence: result.classification?.confidence,
          needs_exploration: result.classification?.needs_exploration,
          judgment_basis: (result.classification?.judgment_basis ?? []).filter((item) => item.fired).map((item) => `${item.rule_id}: ${item.effect ?? item.description}`),
          evidence: (result.classification?.evidence ?? []).map((item) => item.statement),
          signal_type: result.signal?.signal_type,
          signal_reason: result.signal?.reason,
          suggested_rollback: result.signal?.suggested_rollback,
          decision: result.decision,
          traces: result.state.traces,
          summary: result.reason,
          // 半自动执行器的实际动作：只读放行了哪些、写动作被拦下哪些。
          // 这是"半自动"的可见凭据 —— 你能看到它做了什么、没做什么。
          actions: {
            observed: executor.observations,
            blocked_writes: executor.pendingWrites,
            note: executor.pendingWrites.length > 0 ? `\u6709 ${executor.pendingWrites.length} \u4E2A\u5199\u52A8\u4F5C\u56E0\u672A\u6388\u6743\u800C\u672A\u6267\u884C\u3002\u5982\u9700\u6267\u884C\uFF0C\u8BF7\u5728 allow_writes \u91CC\u663E\u5F0F\u5217\u51FA\u52A8\u4F5C\u540D\u3002` : "\u672C\u8F6E\u65E0\u5199\u52A8\u4F5C\uFF0C\u6216\u5DF2\u5728 allow_writes \u4E2D\u653E\u884C\u3002"
          },
          // 关键区分：`signal_type` 判的是**本轮规划**（桩执行器恒 ok ⇒ 恒 effective），
          // 而 `last_outcome` 是**你实际动手**的结果。历史里累计多次失败时，
          // 单看 effective 会误以为问题解决了 —— 这里显式点明，并给出该做什么。
          guidance: priorFailuresAfter === 0 ? "\u672C\u8F6E\u4EC5\u7ED9\u51FA\u89C4\u5212\uFF1B\u52A8\u624B\u540E\u8BF7\u56DE\u586B last_outcome\uFF0C\u7CFB\u7EDF\u624D\u80FD\u5224\u65AD\u8FD9\u6B21\u5047\u8BBE\u662F\u5426\u6210\u7ACB" : priorFailuresAfter >= 2 ? `\u540C\u4E00\u5047\u8BBE\u5DF2\u7D2F\u8BA1 ${priorFailuresAfter} \u6B21\u5931\u8D25\uFF1A\u4E0D\u8981\u518D\u6CBF\u8FD9\u6761\u5047\u8BBE\u52A0\u7801\uFF0C\u6362\u4E00\u79CD\u56E0\u679C\u7C7B\u578B\u91CD\u65B0\u63D0\u95EE\uFF08\u4F8B\u5982 q2 \u82E5\u5176\u5B9E\u662F yes\uFF0C\u90A3\u5C31\u662F\u56DE\u8DEF\u800C\u975E\u5355\u5411\uFF09` : "\u4E0A\u4E00\u6B21\u5931\u8D25\u4E86\uFF1A\u8FD9\u6B21\u52A8\u624B\u540E\u52A1\u5FC5\u56DE\u586B last_outcome\uFF0C\u7B2C\u4E8C\u6B21\u5931\u8D25\u5C31\u8DB3\u4EE5\u5224\u5B9A\u7C7B\u578B\u5047\u8BBE\u6709\u8BEF",
          history: {
            times_seen: (await history.read(key))?.entries.length ?? 0,
            prior_signals: priorSignalsAfter,
            prior_rollbacks: priorRollbacksAfter,
            prior_failures: priorFailuresAfter,
            plan_outcome_note: "\u6CE8\u610F outcome/signal_type \u53CD\u6620\u7684\u662F\u300C\u672C\u8F6E\u89C4\u5212\u662F\u5426\u987A\u5229\u6267\u884C\u300D\uFF0C\u4E0D\u4EE3\u8868\u73B0\u5B9E\u95EE\u9898\u5DF2\u89E3\u51B3\uFF1B\u73B0\u5B9E\u7ED3\u679C\u53D6\u51B3\u4E8E\u4F60\u56DE\u586B\u7684 last_outcome",
            hint: priorRollbacksAfter > 0 ? "\u6B64\u524D\u8BE5\u7C7B\u578B\u5047\u8BBE\u5DF2\u5224\u8FC7\u8BEF\u5224\uFF0C\u8003\u8651\u6362\u4E00\u79CD\u56E0\u679C\u5047\u8BBE\u91CD\u65B0\u63D0\u95EE" : "\u4E0B\u6B21\u52A8\u624B\u540E\u8BF7\u56DE\u586B last_outcome\uFF0C\u8FD9\u6837\u7CFB\u7EDF\u624D\u80FD\u5224\u65AD\u8FD9\u6B21\u5047\u8BBE\u662F\u5426\u6210\u7ACB"
          }
        });
      }
    })
  );
  toolRuntime(ctx).register(
    defineTool({
      name: "clis_classify",
      description: '\u53EA\u56DE\u7B54"\u8FD9\u662F\u4EC0\u4E48\u56E0\u679C\u7ED3\u6784"\uFF0C\u4E0D\u7ED9\u5EFA\u8BAE\u4E5F\u4E0D\u52A8\u624B\u3002\u7528\u4E8E\u4F60\u60F3\u5148\u786E\u8BA4\u7ED3\u6784\u518D\u51B3\u5B9A\u600E\u4E48\u5904\u7406\u3001\u6216\u9700\u8981\u5411\u7528\u6237\u89E3\u91CA"\u4E3A\u4EC0\u4E48\u8FD9\u91CC\u4E0D\u80FD\u7528\u5E38\u89C4\u529E\u6CD5"\u3002\u56DB\u79CD\u7ED3\u679C\uFF1Astructural_duality\uFF08\u4E24\u8005\u540C\u65F6\u6210\u7ACB\u3001\u5F7C\u6B64\u5B9A\u4E49\uFF09\u3001cyclic\uFF08\u6709\u5EF6\u8FDF\u7684\u76F8\u4E92\u5F71\u54CD\uFF0C\u4F1A\u9707\u8361\uFF09\u3001unidirectional\uFF08\u4E25\u683C\u5148\u540E\u4E14\u4E0D\u53EF\u9006\uFF09\u3001nested\uFF08\u591A\u79CD\u7ED3\u6784\u5E76\u5B58\uFF09\uFF1B\u4FE1\u606F\u4E0D\u8DB3\u65F6\u8FD4\u56DE unknown \u5E76\u5217\u51FA\u5019\u9009\u5047\u8BBE\uFF0C\u4E0D\u786C\u731C\u3002',
      parameters: {
        description: { type: "string", required: true, description: "\u4E00\u53E5\u8BDD\u8BF4\u6E05 A \u4E0E B \u7684\u5173\u7CFB\u3002" },
        ...questionParams()
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      async execute(args) {
        const classifier = ctx[SERVICE_CLASSIFIER];
        if (classifier === void 0) {
          throw new Error("CLIS \u672A\u5C31\u7EEA\uFF1Aclis.causalClassifier \u670D\u52A1\u4E0D\u53EF\u7528");
        }
        const result = await classifier.classify(toProblem(args));
        return toToolJson({
          causal_type: result.causal_type,
          confidence: result.confidence,
          needs_exploration: result.needs_exploration,
          exploration_reason: result.exploration_reason,
          judgment_basis: (result.judgment_basis ?? []).filter((item) => item.fired).map((item) => `${item.rule_id}: ${item.effect ?? item.description}`),
          evidence: (result.evidence ?? []).map((item) => item.statement),
          candidate_hypotheses: result.candidate_hypotheses,
          sub_modules: result.sub_modules?.map((sub) => ({
            name: sub.name,
            causal_type: sub.classification.causal_type
          }))
        });
      }
    })
  );
  toolRuntime(ctx).register(
    defineTool({
      name: "clis_plan",
      description: '\u53EA\u5217"\u8FD9\u79CD\u4E8B\u6709\u54EA\u51E0\u79CD\u505A\u6CD5\u3001\u5404\u81EA\u4EE3\u4EF7\u5982\u4F55"\uFF0C\u4E0D\u6267\u884C\u4E5F\u4E0D\u63A8\u8350\u552F\u4E00\u7B54\u6848\u3002\u7528\u4E8E\u4F60\u60F3\u7ED9\u7528\u6237\u51E0\u4E2A\u6709\u4F9D\u636E\u7684\u9009\u9879\u3001\u6216\u60F3\u5148\u770B\u6E05\u4EE3\u4EF7\u518D\u51B3\u5B9A\u3002\u6309\u7C7B\u578B\u5339\u914D\u5EA6\u3001\u9884\u671F\u6548\u679C\u3001\u526F\u4F5C\u7528\u98CE\u9669\u3001\u6267\u884C\u6210\u672C\u56DB\u9879\u52A0\u6743\u6392\u5E8F\uFF1B\u53EF\u6307\u5B9A\u7981\u6B62\u4F7F\u7528\u7684\u52A8\u4F5C\uFF0C\u5B83\u4EEC\u4E0D\u4F1A\u51FA\u73B0\u5728\u4EFB\u4F55\u8DEF\u5F84\u91CC\u3002',
      parameters: {
        description: { type: "string", required: true, description: "\u4E00\u53E5\u8BDD\u8BF4\u6E05 A \u4E0E B \u7684\u5173\u7CFB\u3002" },
        ...questionParams(),
        forbidden_actions: {
          type: "array",
          description: "\u53EF\u9009\uFF1A\u7981\u6B62\u6267\u884C\u7684\u52A8\u4F5C\u540D\u5217\u8868\u3002",
          items: { type: "string" }
        }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      async execute(args) {
        const classifier = ctx[SERVICE_CLASSIFIER];
        const strategy = ctx[SERVICE_STRATEGY];
        if (classifier === void 0 || strategy === void 0) {
          throw new Error("CLIS \u672A\u5C31\u7EEA\uFF1A\u5206\u7C7B\u5668\u6216\u7B56\u7565\u670D\u52A1\u4E0D\u53EF\u7528");
        }
        const classification = await classifier.classify(toProblem(args));
        const paths = await strategy.match(classification, toBoundary(args));
        return toToolJson({
          causal_type: classification.causal_type,
          confidence: classification.confidence,
          paths: paths.map((path) => ({
            rank: path.rank,
            path_id: path.path_id,
            variant: path.variant,
            family: path.family,
            score: path.score,
            executable: path.executable,
            summary: path.summary,
            steps: path.steps.map((step) => ({ action: step.action, params: step.params })),
            blocked_actions: path.blocked_actions,
            sub_paths: path.sub_paths?.map((sub) => ({
              path_id: sub.path_id,
              causal_type: sub.causal_type,
              variant: sub.variant
            }))
          }))
        });
      }
    })
  );
  toolRuntime(ctx).register(
    defineTool({
      name: "clis_probe",
      description: '\u7CFB\u7EDF\u7EA7\u63D2\u4EF6\u76D1\u7763\uFF1A\u679A\u4E3E\u5BBF\u4E3B\u5168\u90E8\u63D2\u4EF6\uFF0C\u6536\u96C6\u5404\u81EA\u5065\u5EB7\u63A2\u9488\u7684\u539F\u59CB\u4FE1\u53F7\uFF0C\u7528\u56E0\u679C\u7ED3\u6784\u5206\u6790\u5224\u65AD"\u8FD9\u4E9B\u6563\u4E71\u95EE\u9898\u4E4B\u95F4\u662F\u4EC0\u4E48\u5173\u7CFB"\uFF0C\u5E76\u53EA\u6295\u9012\u5BF9\u65B9\u81EA\u67E5\u62A5\u4E0D\u51FA\u6765\u7684\u7ED3\u8BBA\uFF08\u7ED3\u6784\u8BCA\u65AD + \u8986\u76D6\u7F3A\u53E3\uFF09\u3002**\u4E0D\u8F6C\u53D1\u5BF9\u65B9\u81EA\u5DF1\u5DF2\u7ECF\u663E\u793A\u7684\u9010\u6761\u8B66\u544A** \u2014\u2014 \u90A3\u4E9B\u5728\u5404\u81EA\u9762\u677F\u91CC\u5DF2\u6709\uFF0C\u91CD\u590D\u642C\u8FD0\u53EA\u662F\u566A\u97F3\u3002\u7528\u4E8E\u56DE\u7B54"\u67D0\u4E2A\u63D2\u4EF6\u53CD\u590D\u51FA\u95EE\u9898\u3001\u4FEE\u4E86\u53C8\u56DE\u6765\uFF0C\u5230\u5E95\u662F\u51E0\u4E2A\u95EE\u9898\u8FD8\u662F\u4E00\u4E2A\u73AF"\u8FD9\u7C7B\u8DE8\u95EE\u9898\u5224\u65AD\u3002',
      parameters: {
        only: {
          type: "array",
          description: "\u53EF\u9009\uFF1A\u53EA\u76D1\u7763\u8FD9\u4E9B\u63D2\u4EF6 id\uFF1B\u7701\u7565\u5219\u679A\u4E3E\u5BBF\u4E3B\u5168\u90E8\u6D3B\u52A8\u63D2\u4EF6\u3002",
          items: { type: "string" }
        }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      async execute(rawArgs) {
        const plugins = listPlugins(ctx);
        const explicit = healthSources();
        const auto = autoSources(ctx, plugins, explicit);
        const { activeTotal } = buildScope(plugins, explicit);
        const only = rawArgs.only;
        const sources = only === void 0 ? auto.sources : auto.sources.filter((item) => only.some((id) => id === item.plugin));
        const supervision = {
          active_plugins: activeTotal,
          user_plugins: auto.total,
          supervised: sources.length,
          domain_probes: auto.domainCovered,
          structural_only: auto.structuralOnly
        };
        if (sources.length === 0) {
          return toToolJson({
            status: "ok",
            supervision,
            message: "\u6CA1\u6709\u53EF\u76D1\u7763\u7684\u975E\u5185\u5EFA\u63D2\u4EF6",
            notices: []
          });
        }
        const supervisor = new HealthSupervisor(ctx, sources);
        const outcome = await supervisor.run();
        const previous = await readSeenState();
        const presentCodes = new Set(outcome.grouped.map((item) => item.code));
        const persisting = Object.values(previous.findings).filter((item) => presentCodes.has(item.code)).map((item) => item.code);
        const notices = deriveNotices(outcome, [], persisting);
        const escalateAfter = 2;
        const dispositionInput = notices.map((notice) => ({
          code: notice.code,
          severity: notice.severity,
          message: notice.message,
          plugins: notice.plugins,
          count: notice.evidence.length
        }));
        const { dispositions, next } = reconcileFindings(
          dispositionInput,
          previous,
          escalateAfter
        );
        await writeSeenState(next);
        const notifier = new HealthNotifier(ctx);
        const notified = notifier.notify(notices);
        const shaped = shapeForAgent(notified, outcome.grouped);
        return toToolJson({
          status: outcome.status,
          // 监督覆盖面：用户一眼看到"全系统有多少插件、多少在被监督"
          supervision,
          probed: sources.map((item) => item.plugin),
          probe_errors: outcome.probeErrors,
          // 结构判断（CLIS 的核心产出）
          analysis: outcome.analysis,
          // 注意：分组计数保留，但它只是**证据**，不是投递项
          evidence: outcome.grouped.map((item) => ({
            code: item.code,
            count: item.count,
            plugins: item.plugins
          })),
          notices: shaped,
          dispositions: dispositions.map((item) => ({
            code: item.code,
            disposition: item.disposition,
            rounds: item.roundsUnresolved
          }))
        });
      }
    })
  );
  toolRuntime(ctx).register(
    defineTool({
      name: "clis_metrics",
      description: 'Read intervention-effectiveness metrics for CLIS, including its own miss rate. hinted = failure-feedback hints actually injected into the agent loop; adopted = the agent then called clis_run/clis_classify; adoptionRate = adopted/hinted. skipped = failures the gate evaluated and deliberately passed over, with reason and gate breakdown; missRate = skipped/evaluated. Read hinted alone and "the gate is working" looks identical to "nobody is watching" \u2014 missRate is the denominator that separates them. A missRate near 1 means the gate passes everything (effectively off); near 0 means it is nagging. Read-only; no experiment required to collect.',
      parameters: {
        window_days: {
          type: "number",
          description: "\u6C47\u603B\u7A97\u53E3\uFF08\u5929\uFF09\uFF1B\u7F3A\u7701 30\u3002"
        }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      async execute(rawArgs) {
        const days = Math.min(Math.max(1, Number(rawArgs.window_days) || 30), 365);
        const summary = await summarizeMetrics(dshHomeOf(), days);
        return toToolJson({
          window_days: days,
          hinted: summary.hinted,
          adopted: summary.adopted,
          adoption_rate: summary.adoptionRate,
          // 与提示无关的自主调用：单列，**不进分子**。
          spontaneous: summary.spontaneous,
          // —— 漏判分母（2026-11-02）——
          // 没有这三个字段时，hinted 单独读起来"正常"与"根本没在管"同形。
          skipped: summary.skipped,
          evaluated: summary.evaluated,
          miss_rate: summary.missRate,
          skipped_by_reason: summary.skippedByReason,
          skipped_by_gate: summary.skippedByGate,
          // 判读指引：数字本身不说明好坏，解释框架要给足。
          reading: summarizeReading(summary),
          // 采纳口径说明：adopted 是**有条件**的（同一 agent 此前 30 分钟内有提示）。
          // 不写这句，读者会以为 adopted 只是"调过 CLIS 的次数"。
          definition: "adopted \u53EA\u7EDF\u8BA1\u300C\u540C\u4E00 agent \u6B64\u524D 30 \u5206\u949F\u5185\u6536\u5230\u8FC7\u63D0\u793A\u300D\u7684 CLIS \u8C03\u7528\uFF1Bspontaneous \u662F\u6CA1\u6709\u4EFB\u4F55\u524D\u63D0\u63D0\u793A\u7684\u81EA\u4E3B\u8C03\u7528\uFF0C\u4E0D\u8BA1\u5165\u5206\u5B50\u3002evaluated = hinted + skipped\uFF08\u673A\u5236\u771F\u6B63\u770B\u8FC7\u7684\u5931\u8D25\u6570\uFF09\uFF1BmissRate = skipped/evaluated\u3002"
        });
      }
    })
  );
}
function dshHomeOf() {
  return process.env.DSH_HOME ?? join5(homedir3(), ".dsh");
}
function summarizeReading(s) {
  if (s.evaluated === 0) {
    return '\u7A97\u53E3\u5185\u673A\u5236\u4E00\u6B21\u90FD\u6CA1\u8BC4\u4F30\u8FC7\u5931\u8D25\uFF1A\u8981\u4E48\u786E\u5B9E\u6CA1\u6709\u5931\u8D25\uFF0C\u8981\u4E48\u4ECB\u5165\u5668\u6CA1\u6CE8\u518C\u4E0A\u3002\u6CE8\u610F\u8FD9\u4E24\u79CD\u5728\u6570\u5B57\u4E0A\u5B8C\u5168\u540C\u5F62 \u2014\u2014 \u53BB\u67E5\u5BBF\u4E3B\u65E5\u5FD7\u91CC\u6709\u6CA1\u6709"\u4ECB\u5165\u5668\u672A\u6CE8\u518C"\u3002';
  }
  if (s.missRate !== null && s.missRate >= 0.95) {
    return `\u6F0F\u5224\u7387 ${(s.missRate * 100).toFixed(0)}%\uFF1A\u95F8\u95E8\u51E0\u4E4E\u653E\u8FC7\u4E86\u6240\u6709\u5931\u8D25\uFF0C\u4ECB\u5165\u5B9E\u9645\u4E0A\u6CA1\u53D1\u751F\u3002\u4E3B\u56E0\u770B skipped_by_gate\uFF08\u591A\u6570\u5426\u51B3\u6765\u81EA\u54EA\u9053\u95F8\u95E8\uFF09\u3002`;
  }
  if (s.hinted === 0) {
    return `\u8BC4\u4F30\u4E86 ${s.evaluated} \u6B21\u4F46\u4E00\u6B21\u4E5F\u6CA1\u4ECB\u5165\uFF1A\u5168\u90E8\u88AB\u95F8\u95E8\u62E6\u4E0B\uFF0C\u5C5E\u653E\u884C\u72B6\u6001\uFF0C\u4E0D\u662F\u6545\u969C\u3002`;
  }
  if (s.adoptionRate !== null && s.adoptionRate >= 0.3) {
    return `\u91C7\u7528\u7387\u5065\u5EB7\uFF08${(s.adoptionRate * 100).toFixed(0)}%\uFF09\uFF1B\u6F0F\u5224\u7387 ${((s.missRate ?? 0) * 100).toFixed(0)}% \u8BF4\u660E\u95F8\u95E8\u5728\u8FC7\u6EE4\u800C\u975E\u5931\u660E\u3002`;
  }
  return `\u91C7\u7528\u7387\u504F\u4F4E\uFF08${s.adoptionRate === null ? "n/a" : `${(s.adoptionRate * 100).toFixed(0)}%`}\uFF09\uFF1A\u63D0\u793A\u88AB\u770B\u89C1\u4F46\u6CA1\u88AB\u4FE1\u4EFB\u3002\u4F18\u5148\u68C0\u67E5\u63AA\u8F9E\u662F\u5426\u592A\u50CF\u547D\u4EE4\u3001\u89E6\u53D1\u65F6\u673A\u662F\u5426\u592A\u9891\u7E41\u3002`;
}

// packages/clis-plugin/src/index.ts
function dshHomeForMetrics() {
  return process.env.DSH_HOME ?? join6(process.env.USERPROFILE ?? "", ".dsh");
}
var HOT_RELOAD_KEY = /* @__PURE__ */ Symbol.for("dsh-clis.hot-reload-started");
var PLUGIN_VERSION = "0.3.0";
var name = "clis-tools";
var inject = [
  "tools",
  "systemPrompt",
  "clis.causalClassifier",
  "clis.causalStrategy",
  "clis.causalOrchestrator"
];
function apply(ctx) {
  const probe = new ClisHealthProbe(ctx, PLUGIN_VERSION);
  const registry = new ProbeRegistry();
  registry.add("dsh-clis", () => probe.probe());
  const disposeListen = registry.listen(ctx);
  const sources = () => {
    const collected = registry.sources();
    const known = collected.map((item) => item.plugin);
    return [...collected, ...scanKnownProbes(ctx, known)];
  };
  registerTools(ctx, sources);
  registerPromptSection(ctx);
  const emitSignal = ctx.emit;
  try {
    emitSignal.call(ctx, "mind/register-signal", {
      name: "clis-causal",
      situation: "diagnose",
      owner: "dsh-clis",
      weight: 3,
      words: [
        "\u56E0\u679C",
        "\u56E0\u679C\u7ED3\u6784",
        "\u7ED3\u6784",
        "\u56DE\u8DEF",
        "\u53CD\u9988\u73AF",
        "\u5BF9\u5076",
        "\u77DB\u76FE",
        "\u73AF\u72B6",
        "\u5F20\u529B",
        "\u5F52\u56E0",
        "\u5F52\u56E0\u9519",
        "\u8BCA\u65AD",
        "\u5224\u4E00\u4E0B\u7ED3\u6784",
        "\u662F\u4E0D\u662F\u73AF",
        "\u4E3A\u4EC0\u4E48\u4F1A\u8FD9\u6837",
        "\u6839\u56E0"
      ]
    });
  } catch {
  }
  const subscribeOk = registerIntervener(ctx);
  if (subscribeOk === void 0) {
    void recordMetric(dshHomeForMetrics(), {
      kind: "skipped",
      agent: "plugin",
      reason: "subscriber-missing",
      gate: "gate-0-subscribe"
    });
    ctx.logger?.warn?.(
      'clis \u4ECB\u5165\u5668\u672A\u6CE8\u518C\uFF1A\u62FF\u4E0D\u5230 tools/post-execute \u4E8B\u4EF6\u6E90\u3002CLIS \u7684\u5931\u8D25\u53CD\u9988\u4ECB\u5165\u5728\u672C\u5BBF\u4E3B\u4E0A\u4E0D\u4F1A\u53D1\u751F \u2014\u2014 \u8FD9\u4E0D\u662F"\u6CA1\u4EBA\u5931\u8D25"\uFF0C\u662F"\u6CA1\u4EBA\u770B"\u3002'
    );
  }
  const globalFlags = globalThis;
  if (globalFlags[HOT_RELOAD_KEY] !== true) {
    const host2 = ctx;
    if (host2.loader !== void 0) {
      const here = import.meta.url.replace(/^file:\/\/\//u, "").replace(/\//gu, "\\");
      const installDir = here.slice(0, here.lastIndexOf("\\"));
      startHotReload(ctx, installDir, {
        info: (m) => ctx.logger?.info?.(m),
        warn: (m) => ctx.logger?.warn?.(m)
      });
      globalFlags[HOT_RELOAD_KEY] = true;
      ctx.logger?.info?.("clis: \u667A\u80FD\u70ED\u91CD\u8F7D\u770B\u95E8\u72D7\u5DF2\u542F\u52A8\uFF08\u76D1\u89C6\u5B89\u88C5\u76EE\u5F55\uFF09");
    }
  }
  const host = ctx;
  if (typeof host.effect === "function") {
    host.effect(() => disposeListen);
  }
}
export {
  FEEDBACK_RULES_VERSION,
  ROLLBACK_LIMIT_DEFAULT,
  STRATEGY_LIBRARY,
  STRATEGY_LIBRARY_VERSION,
  TYPE_LOCK_ROUNDS_DEFAULT,
  apply,
  classifyProblem,
  decide,
  detectSignal,
  executePath,
  initialState,
  inject,
  matchPaths,
  name
};
