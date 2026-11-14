/**
 * dsh-valves —— 心智系统的两类阀门（《心智系统开发说明书》§4.2 的最小落地）。
 *
 * ## 定位：判据的裁决所，不是又一个判断器
 *
 * - 判据在 src/predicates.js（纯函数，一处实现）；
 * - 阈值在 src/thresholds.js（全部暂定，待账本分布校准）；
 * - 本入口只做三件事：暴露工具、发布服务、记双侧账。
 *
 * ## 生成与判断分离（§2.4）
 *
 * agent（LLM）通过 `valve_check` **提交**候选与证据（提名），
 * 谓词函数裁决（校验），账本留痕。LLM 不控制流向：
 * 判定 accept/human_gate 也不生效——负向规则生效的唯一通道是
 * `valve_confirm`（人工确认语义），正向规则的闸门在 memory 层已有
 * （gateFa/gateDao），这里不重复实现（判据单一实现）。
 *
 * ## 与 memory 的分工（映射表第 11 项的裁决）
 *
 * memory-manager 继续拥有蒸馏与层级写入闸门（它的判据更严、已实战）；
 * 本包补它没有的两件：**下行负向黑名单**（召回时注入已确认的禁令）与
 * **阀门双侧账本**（evaluated/skipped，答"该拦没拦的有多少"）。
 * memory 通过 ctx.get('valves') 运行时探测本服务——缺了照常工作（N4 降级）。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
	admitDownward,
	admitUpward,
	checkPrinciple,
	isExternallyVerifiable,
} from './src/predicates.js';
import { mergeThresholds, canCalibrate, MIN_CALIBRATION_SAMPLES, DEFAULT_LAYERS, DEFAULT_THRESHOLDS } from './src/thresholds.js';
import {
	appendDecision,
	readDecisions,
	summarizeDecisions,
	readNegativeRules,
	confirmNegativeRule,
	// III-4 回滚：退到上一版快照，上限按规则计。
	rollbackNegativeRule,
	matchNegativeRules,
	// IV-3 沉底：命中流水 + 过期候选 + 人工沉底（保留资产不删除）。
	appendRuleTrigger,
	readRuleTriggers,
	findSinkCandidates,
	sinkRules,
	sunkRules,
} from './src/store.js';
// III-5 越权拦截：只有人工通道能签票，规则库写入必须持票。
import { issuePermit } from './src/guard.js';
// III-6 语义越权：标记不阻断；embedder 可选，缺了标 degraded（N4）。
import { detectSemanticBypass } from './src/semantic.js';
// III-7 定时巡检：周级原则 + 季度层结构，结论落盘（不自动改任何东西）。
import {
	weeklyPrinciplePatrol, quarterlyLayerPatrol,
	writePatrolReport, readLatestPatrolReport, isPatrolDue, PATROL_PERIODS, clampTimerDelay,
	readPendingAxiomCandidates, readPrinciplesFromDisk, readLayerCountsFromDisk,
} from './src/patrol.js';
// IV-5 公理闸门限速：每月最多生效一次 + 显式测试通道（不消耗额度）。
import { checkAxiomRate, applyAxiomLimit } from './src/ratelimit.js';
import { nominateFromDisk } from './src/nominate.js';
// III-3 预算缰绳：批量执行面（提名/治理/确认）的数量上限。
import { check as checkBudget, DEFAULT_BUDGET } from './src/budget.js';
import { readClisHistory, consumeClisHistory, criterionEvidenceFromInsights } from './src/clis-bridge.js';
import { governanceRound, referenceCoverage, validateClassification } from './src/governance.js';

export const name = 'valves';

/**
 * tools 是硬依赖（没有它本插件的主体面不存在）。
 * 与 meta/index.js 同一形态：服务名数组，不写 required/optional 对象。
 */
export const inject = ['tools'];

/** 探针代号（稳定，供监督层检索）。 */
export const PROBE_CODES = {
	ok: 'valves.ok',
	notLoaded: 'valves.not-loaded',
	toolMissing: 'valves.tool-missing',
	storeUnreadable: 'valves.store-unreadable',
	thresholdsOverridden: 'valves.thresholds-overridden',
};

/** 数据目录：<dshHome>/storages（与 clis-interventions.jsonl 同级）。 */
export function defaultStorageDir() {
	const env = process.env.DSH_HOME;
	const home = typeof env === 'string' && env.trim() ? resolve(env.trim()) : join(homedir(), '.dsh');
	return join(home, 'storages');
}

/**
 * Memory root for patrol enumeration (P0-1, 2026-11-13).
 *
 * Derived from the actual storageDir (`<home>/storages` -> `<home>/memory`),
 * NOT from homedir(): a test that passes a sandbox storageDir must never read
 * the real global memory root. Config `patrol.memoryRoot` overrides.
 */
export function memoryRootForStorage(storageDir) {
	return join(dirname(resolve(String(storageDir ?? ''))), 'memory');
}

/**
 * 宿主 defineTool 加载 —— 与 memory/src/host.js 同一探测纪律：
 * 不写死安装目录，候选链任一命中 node_modules/@deepseek-ai/dsh-tools 才算。
 * DSH_HOME 是数据目录，明确不作安装根候选。
 */
const HOST_MARKER = join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

function ascendForRoot(seed) {
	if (typeof seed !== 'string' || !seed) return undefined;
	let dir = resolve(seed);
	if (!existsSync(dir)) dir = dirname(dir);
	for (;;) {
		if (existsSync(join(dir, HOST_MARKER))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function loadDefineTool(configured) {
	const candidates = [
		typeof configured === 'string' && configured.trim() ? configured.trim() : undefined,
		process.env.DSH_INSTALL_DIR,
		process.env.DSH_ROOT,
		ascendForRoot(process.argv[1]),
		ascendForRoot(process.cwd()),
		ascendForRoot(process.env.DSH_PROFILE_DIR),
	];
	for (const c of candidates) {
		if (typeof c === 'string' && existsSync(join(c, HOST_MARKER))) {
			const file = join(c, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
			return createRequire(file)(file).defineTool;
		}
	}
	throw new Error('无法定位 DSH 安装目录（node_modules/@deepseek-ai/dsh-tools）；设 DSH_INSTALL_DIR 或 config.dshRoot');
}

// —— 探针事实源（apply 时写入；探针零参数拿不到 ctx，与 meta/health 同法）——
const facts = {
	loaded: false,
	registeredTools: [],
	storageDir: undefined,
	thresholdsOverridden: false,
	loadError: undefined,
	/** 运行时观测到的故障（读库失败等）。probe() 只读它，不做 I/O。 */
	runtimeFindings: new Map(),
};

/** 记一条运行时故障（同代号覆盖）。 */
function reportFinding(code, severity, message) {
	facts.runtimeFindings.set(code, { code, severity, message });
}

/** 故障恢复后清掉（否则探针会永远报一次性的旧故障）。 */
function clearFinding(code) {
	facts.runtimeFindings.delete(code);
}

/** 供服务消费方与测试读取的运行时句柄。 */
let runtime;

/**
 * 建运行时：把 storageDir/thresholds 绑定进一组带记账的操作。
 * 每次阀门评估**两侧都落账**：allow/accept/human_gate/downgrade → admitted，
 * deny/reject → skipped。账写失败不影响判定返回（fire-and-forget）。
 */
export function createRuntime(options = {}) {
	const storageDir = options.storageDir ?? defaultStorageDir();
	const thresholds = mergeThresholds(options.thresholds);
	const layers = Array.isArray(options.layers) && options.layers.length >= 2 ? [...options.layers] : [...DEFAULT_LAYERS];

	const record = (gate, direction, decision, input) => {
		const outcome = decision.action === 'deny' || decision.action === 'reject' ? 'skipped' : 'admitted';
		void appendDecision(storageDir, {
			gate,
			direction,
			outcome,
			action: decision.action,
			reason: decision.reason,
			from: input?.from,
			to: input?.to,
			candidate_id: input?.candidate_id,
			// origin 口径（2026-11-10 修正）：**不传 = daily**。
			//
			// 原实现是"不传就不写字段"，本意是不猜来源。但它有个致命后果：
			// 真实调用（agent 跑 valve_check）通常不传 origin，于是真实日常
			// 样本全部落成"无 origin"，dailyCount 永远是 0 —— 阈值校准依赖的
			// 分布**永远攒不出来**（实测：100 行账本里 0 行 daily）。不猜来源
			// 变成了"拒绝承认最可能的来源"，把一个统计口径做成了数据黑洞。
			//
			// 现在的语义：真实判定默认就是日常；验证/演练/提名必须**显式声明**
			// 来把自己排除出校准分布。这样"忘了标"的后果从"样本丢失"降为
			// "验证样本混进日常"——后者至少有 origin 字段可事后筛，前者无从恢复。
			origin: typeof input?.origin === 'string' && input.origin ? input.origin : 'daily',
			// III-2：调用方显式声明"这次判定依据了哪些原则"——覆盖率只数
			// 显式引用，不猜语义关联。形状不合（非字符串数组）如实丢弃。
			...(Array.isArray(input?.principle_refs) && input.principle_refs.every((r) => typeof r === 'string' && r)
				? { principle_refs: input.principle_refs }
				: {}),
		});
		return decision;
	};

	return {
		storageDir,
		thresholds,
		layers,
		downward(from, to, data) {
			return record(`downward_${from}_${to}`, 'down', admitDownward(from, to, data, { layers, thresholds }), { from, to, origin: data?.origin, principle_refs: data?.principle_refs });
		},
		upward(from, to, candidate) {
			return record(`upward_${from}_${to}`, 'up', admitUpward(from, to, candidate, { layers, thresholds }), {
				from,
				to,
				candidate_id: candidate?.candidate_id ?? candidate?.rule_id,
				// 同 record() 的口径：不声明就是日常（见 record 里的说明）。
				origin: typeof candidate?.origin === 'string' && candidate.origin ? candidate.origin : 'daily',
				principle_refs: candidate?.principle_refs,
			});
		},
		/**
		 * IV-5：带公理限速的上行准入（异步，因为要读账本算额度）。
		 *
		 * 为什么不改 `upward()` 本身：它被 14 处调用（3 生产 + 11 测试）且是同步的，
		 * 为了一条公理路径把全部调用改成异步，代价远大于收益。限速是**叠加层**，
		 * 独立方法更清楚：predicate 判合规，本方法判时机。
		 */
		async upwardWithAxiomLimit(from, to, candidate, options = {}) {
			const decision = admitUpward(from, to, candidate, { layers, thresholds });
			// 只有公理类变更受限速约束；其它类型原样返回（不读账本、不增加开销）。
			const touchesAxiom = candidate?.rule_type === 'axiom' || candidate?.negative_type === 'weakened_axiom';
			if (!touchesAxiom) {
				return record(`upward_${from}_${to}`, 'up', decision, {
					from, to,
					candidate_id: candidate?.candidate_id ?? candidate?.rule_id,
					origin: typeof candidate?.origin === 'string' && candidate.origin ? candidate.origin : 'daily',
					principle_refs: candidate?.principle_refs,
				});
			}
			const entries = await readDecisions(storageDir);
			// 账本读不到 → 不能假装"这个月还没改过"（那会让限速静默失效）。
			// 如实转人工：与"读不到黑名单就不放行"同一纪律。
			if (entries === undefined) {
				const guarded = {
					...decision,
					action: 'human_gate',
					reason: 'axiom_ledger_unreadable',
					note: '账本读取失败，无法判定本月公理额度（不当作零额度放行）',
				};
				return record(`upward_${from}_${to}`, 'up', guarded, {
					from, to, candidate_id: candidate?.candidate_id ?? candidate?.rule_id,
					origin: typeof candidate?.origin === 'string' && candidate.origin ? candidate.origin : 'daily',
				});
			}
			const rate = checkAxiomRate(
				{ entries, now: Date.now(), ...(options.testChannel === true || candidate?.testChannel === true ? { testChannel: true } : {}) },
				options,
			);
			const final = applyAxiomLimit(decision, rate);
			return record(`upward_${from}_${to}`, 'up', final, {
				from, to,
				candidate_id: candidate?.candidate_id ?? candidate?.rule_id,
				origin: typeof candidate?.origin === 'string' && candidate.origin ? candidate.origin : 'daily',
				// 公理判定附上额度信息：事后能回答"当时还剩多少额度"。
				...(touchesAxiom ? { axiom_rate: { used: rate.used ?? 0, max: rate.max, test_channel: rate.testChannel === true } } : {}),
				// 测试通道**不进生产分布**：显式标出来，summary 会把它单列。
				...(rate.testChannel === true ? { origin: 'verification' } : {}),
			});
		},
		principle(stats) {
			const verdict = checkPrinciple(stats, { thresholds });
			void appendDecision(storageDir, {
				gate: 'principle',
				direction: 'governance',
				outcome: verdict.status === 'invalid' ? 'skipped' : 'admitted',
				action: verdict.status,
				reason: verdict.triggered.join('+') || verdict.status,
				origin: typeof stats?.origin === 'string' && stats.origin ? stats.origin : 'daily',
			});
			return verdict;
		},
		async negativeRules() {
			return readNegativeRules(storageDir);
		},
		/**
		 * III-7 跑一次巡检并落盘。
		 *
		 * kind=weekly：原则巡检（需要调用方给原则清单——巡检不自动枚举，
		 * 没被用过的原则排队只会刷屏）。
		 * kind=quarterly：层结构巡检（层与计数由调用方给，从 memory 读）。
		 *
		 * **失败也落盘**：`ok:false` + 原因。否则"没跑"与"跑了没问题"
		 * 在文件系统里长得一样，而这两件事完全不同。
		 */
		async patrol(kind, input = {}) {
			const now = new Date();
			const at = now.toISOString();
			let body;
			try {
				if (kind === 'quarterly') {
					body = quarterlyLayerPatrol({ layers: input.layers, counts: input.counts });
				} else {
					body = weeklyPrinciplePatrol({ principles: input.principles }, input.options);
					// IV-3：周检顺带报"这些负向规则该退休了"。只报不改——
					// 规则的去留是人的判断，定时器只负责把候选摆到台面上。
					const rules = await readNegativeRules(storageDir);
					const triggers = await readRuleTriggers(storageDir);
					if (rules !== undefined) {
						const sink = findSinkCandidates(rules, triggers, {
							windowDays: thresholds.negativeRuleSinkDays,
							now: now.getTime(),
						});
						body.findings = [...(body.findings ?? []), ...sink.candidates.map((c) => ({
							kind: 'negative_rule_sink_candidate',
							rule_id: c.id,
							last_activity_at: c.lastActivityAt,
							note: `超过 ${thresholds.negativeRuleSinkDays} 天未触发：可经 valve_confirm action=sink 沉底（移出拦截、保留资产）`,
						}))];
						body.summary = {
							...(body.summary ?? {}),
							sink_candidates: sink.candidates.length,
							...(sink.unknown ? { sink_unknown: 'rule_triggers_unreadable' } : {}),
						};
					} else {
						body.summary = { ...(body.summary ?? {}), sink_candidates: null, sink_unknown: 'rules_unreadable' };
					}
				}
			} catch (err) {
				const failed = { kind, at, ok: false, error: err instanceof Error ? err.message : String(err) };
				await writePatrolReport(storageDir, failed);
				return failed;
			}
			const report = { kind, at, ok: true, ...body };
			const written = await writePatrolReport(storageDir, report);
			void appendDecision(storageDir, {
				gate: 'patrol',
				direction: 'scheduled',
				outcome: 'admitted',
				action: kind,
				reason: body.findings.length > 0 ? 'findings_reported' : 'clean',
				origin: 'daily',
			});
			return { ...report, report_path: written.path, report_ok: written.ok };
		},
		/** 上次巡检报告（探针与"是否该补跑"的判据来源）。 */
		async lastPatrol(kind) {
			return readLatestPatrolReport(storageDir, kind);
		},
		/**
		 * III-6 语义越权标记：**只标记不阻断**。
		 *
		 * 读现有规则（含各自声明的 boundary_keywords），对候选描述做词面检查；
		 * 传了 embed 才做语义层，否则如实标 degraded。结果落账为
		 * possible_semantic_bypass（outcome 记 admitted，因为它**不拦**）。
		 */
		async semanticCheck(input = {}) {
			const rules = await readNegativeRules(storageDir);
			if (rules === undefined) {
				// 读不到规则 ≠ 没有越权 —— 如实报不可判定，不冒充"干净"。
				return { error: 'rules_unreadable', flagged: false, blocked: false };
			}
			const verdict = await detectSemanticBypass(
				{ rules, text: input.text, ...(typeof input.embed === 'function' ? { embed: input.embed } : {}) },
				{ similarityThreshold: input.similarity_threshold },
			);
			if (verdict.flagged) {
				void appendDecision(storageDir, {
					gate: 'semantic',
					direction: 'check',
					// 标记不等于拒绝：它放行了，只是进了人工抽查队列。
					outcome: 'admitted',
					action: 'flag',
					reason: verdict.code,
					candidate_id: input.candidate_id,
					origin: typeof input?.origin === 'string' && input.origin ? input.origin : 'daily',
				});
			}
			return verdict;
		},
		async matchNegative(text) {
			const rules = await readNegativeRules(storageDir);
			const hits = matchNegativeRules(rules, text);
			// IV-3：命中即记一笔"这条规则还在生效"。写失败不影响拦截本身
			// （记账是附加能力），但沉底判据会因缺流水而保守不沉底。
			if (Array.isArray(hits) && hits.length) void appendRuleTrigger(storageDir, { ruleIds: hits });
			return hits;
		},
		/** IV-3 检索沉底规则（反例资产）：不参与拦截，但可查。 */
		async sunkNegativeRules() {
			const rules = await readNegativeRules(storageDir);
			if (rules === undefined) return undefined;
			return sunkRules(rules);
		},
		/**
		 * IV-3 沉底候选（只报不改）。定时巡检用它产出"这些规则该退休了"，
		 * 实际沉底仍要人工通道——定时器不许替人决定规则的去留。
		 */
		async sinkCandidates(options = {}) {
			const rules = await readNegativeRules(storageDir);
			if (rules === undefined) {
				reportFinding(PROBE_CODES.storeUnreadable, 'warn', '负向规则库读取失败，沉底候选不可判定。');
				return { candidates: [], unknown: true, rules_unreadable: true };
			}
			const triggers = await readRuleTriggers(storageDir);
			const found = findSinkCandidates(rules, triggers, {
				windowDays: options.windowDays ?? thresholds.negativeRuleSinkDays,
				...(Number.isFinite(options.now) ? { now: options.now } : {}),
			});
			return { ...found, triggers_unreadable: found.unknown, windowDays: options.windowDays ?? thresholds.negativeRuleSinkDays };
		},
		/**
		 * IV-3 沉底（人工通道）。与 confirm/rollback 同一入口纪律：
		 * 移出拦截但保留内容，写前快照，因此可回退（回退=重新激活）。
		 */
		async sink(ruleIds, options = {}) {
			const ids = Array.isArray(ruleIds) ? ruleIds : [ruleIds];
			// 票只能由人工通道签：这里就是 valve_confirm 本身。
			const permits = [];
			for (const id of ids) {
				const permit = issuePermit({ via: 'sink', ruleId: String(id ?? '') });
				if (!permit.ok) return permit;
				permits.push(permit.token);
			}
			const result = await sinkRules(storageDir, ids, {
				permits,
				reason: typeof options.reason === 'string' ? options.reason : undefined,
			});
			void appendDecision(storageDir, {
				gate: 'sink',
				direction: 'human',
				outcome: result.ok ? 'admitted' : 'skipped',
				action: result.ok ? 'sank' : 'sink_refused',
				reason: result.ok ? 'human_sink_stale_rule' : String(result.error ?? 'sink_failed'),
				candidate_id: ids.join(','),
			});
			return result;
		},
		async confirm(rule) {
			// III-5：签票只能走人工通道。这里就是人工通道本身（valve_confirm），
			// 所以由它签发给 store —— 任何其它路径想写库都拿不到票。
			const permit = issuePermit({ via: 'confirm', ruleId: String(rule?.id ?? '') });
			const result = await confirmNegativeRule(storageDir, rule, {
				...(permit.ok ? { permit: permit.token } : {}),
			});
			// 确认事件本身也进账本：生效通道被使用过几次，是审计的一部分。
			void appendDecision(storageDir, {
				gate: 'confirm',
				direction: 'human',
				outcome: result.ok ? 'admitted' : 'skipped',
				action: result.ok ? 'confirmed' : 'confirm_failed',
				reason: result.ok ? 'human_confirmed' : 'confirm_write_failed',
				candidate_id: rule?.id,
			});
			return result;
		},
		/**
		 * III-4 回退：把一条规则退到上一版快照。
		 *
		 * 与 confirm 共用一个人工入口（不新增第 6 个工具）：两者都是**人工
		 * 改规则库**的动作，区别只是方向。超过上限时返回 human_gate_required
		 * 而不是静默失败——上限不是错误，是"这条规则该由人重新想一遍"。
		 */
		async rollback(ruleId) {
			const permit = issuePermit({ via: 'rollback', ruleId: String(ruleId ?? '') });
			const result = await rollbackNegativeRule(storageDir, ruleId, {
				...(permit.ok ? { permit: permit.token } : {}),
			});
			void appendDecision(storageDir, {
				gate: 'rollback',
				direction: 'human',
				outcome: result.ok ? 'admitted' : 'skipped',
				action: result.ok ? result.action : 'rollback_refused',
				reason: result.ok ? 'human_rollback' : String(result.error ?? 'rollback_failed'),
				candidate_id: ruleId,
			});
			return result;
		},
		async metrics() {
			const entries = await readDecisions(storageDir);
			if (entries === undefined) {
				reportFinding(PROBE_CODES.storeUnreadable, 'warn', '判定账本读取失败（mind-valves.jsonl）。');
				return { error: 'ledger_unreadable' };
			}
			const rules = await readNegativeRules(storageDir);
			if (rules === undefined) {
				reportFinding(PROBE_CODES.storeUnreadable, 'warn', '负向规则库读取失败（mind-negative-rules.json）——下行检查按不可判定转人工。');
			} else {
				clearFinding(PROBE_CODES.storeUnreadable);
			}
			// III-7：上次巡检的时间与结论。没跑过要如实说"从未"，不能空着——
			// "没有报告"与"巡检了没问题"是两件事，指标上必须分得开。
			const weeklyPatrol = await readLatestPatrolReport(storageDir, 'weekly');
			const quarterlyPatrol = await readLatestPatrolReport(storageDir, 'quarterly');
			const summary = summarizeDecisions(entries);
			// P0-2: thresholds may only be tuned from the DAILY denominator. The
			// verdict is reported so "still provisional" has a testable reason,
			// instead of a permanent label nobody can act on.
			const calib = canCalibrate(summary.calibration);
			return {
				...summary,
				negative_rules: rules === undefined ? null : rules.length,
				negative_store: rules === undefined ? 'unreadable' : 'ok',
				last_patrol: {
					weekly: weeklyPatrol ? { at: weeklyPatrol.at, ok: weeklyPatrol.ok, findings: weeklyPatrol.findings?.length ?? 0 } : 'never',
					quarterly: quarterlyPatrol ? { at: quarterlyPatrol.at, ok: quarterlyPatrol.ok, findings: quarterlyPatrol.findings?.length ?? 0 } : 'never',
				},
				thresholds,
				thresholds_status: calib.allowed ? '可校准（日常样本已达标）' : `暂定（${calib.reason}：日常样本 ${calib.evaluated}/${calib.needed}，提名与验证不计入）`,
				calibration_writable: calib.allowed,
			};
		},
		/**
		 * II-1/II-2 自动提名。usageItems 由调用方（memory 桥或周检脚本）
		 * 聚合后传入——本包不反向 import memory（依赖方向纪律）。
		 * 不传则 skills 侧如实返回 skipped（不是空候选假装查过）。
		 */
		async nominate(args = {}) {
			const channel = args.channel ?? 'both';
			const rules = await readNegativeRules(storageDir);
			const result = await nominateFromDisk(
				{
					storageDir,
					interventionsPath: args.interventionsPath,
					usageItems: channel === 'forbidden' ? [] : args.usageItems,
				},
				{ thresholds, existingRuleIds: Array.isArray(rules) ? rules.map((r) => r?.id) : [], windowDays: args.window_days },
			);
			const out = {
				forbidden: channel === 'skills' ? null : result.forbidden ?? null,
				skills: channel === 'forbidden' ? null : result.skills ?? null,
				...(result.forbidden === undefined && channel !== 'skills' ? { forbidden_error: 'clis-interventions.jsonl 读取失败' } : {}),
				...(channel !== 'forbidden' && args.usageItems === undefined ? { skills_note: '未提供 usage 聚合（调用方经 memory summarizeUsage 传入），正向侧本次未查' } : {}),
			};
			if (args.check === true) {
				// III-3 预算缰绳：裁决会逐条落账，批次规模必须先过预算。
				// 超限**不静默截断**——只处理前 N 条会让账本看起来完整、
				// 实际缺一段，事后无人能查。所以整批终止并说清剩多少。
				const candidates = [...(out.forbidden ?? []), ...(out.skills ?? [])];
				const budgetCheck = checkBudget({ items: candidates.length, rows: candidates.length });
				if (!budgetCheck.ok) {
					return {
						...out,
						terminated_by: budgetCheck.code,
						budget: budgetCheck.detail,
						verdicts: [],
						note: `本批 ${candidates.length} 条超过预算 ${budgetCheck.detail.maxItems}，已整批终止（未部分执行）。用 window_days 缩小范围或分批重跑。`,
					};
				}
				out.verdicts = [];
				for (const c of candidates) {
					// 器→术：候选都在 L3 原料层，目标 L2。
					const decision = this.upward('L3', 'L2', c);
					out.verdicts.push({ candidate_id: c.candidate_id, ...decision });
				}
				out.budget_used = { items: candidates.length, maxItems: (budgetCheck.detail?.maxItems ?? DEFAULT_BUDGET.maxItems) };
			}
			return out;
		},
		/**
		 * II-5：消费 clis 历史，提名+裁决成对落账（零配合——读现成文件）。
		 * 首次消费全量；之后按落账里的 fingerprint@at 去重（账本自身是
		 * 游标，不另建第二份状态）。misjudged 线索单独返回给人工核。
		 */
		async clisTrace() {
			const history = await readClisHistory(storageDir);
			const consumed = consumeClisHistory(history);
			if (consumed.error) return consumed;
			const ledger = await readDecisions(storageDir);
			const seen = new Set(
				(ledger ?? [])
					.filter((e) => e?.gate === 'clis_nomination' && e.candidate_id)
					.map((e) => e.candidate_id),
			);
			let recorded = 0;
			for (const n of consumed.nominations) {
				const key = `${n.fingerprint}@${n.at}`;
				if (seen.has(key)) continue;
				seen.add(key);
				recorded++;
				void appendDecision(storageDir, {
					gate: 'clis_nomination',
					direction: 'trace',
					outcome: n.verdict === 'accepted' ? 'admitted' : 'skipped',
					action: n.verdict,
					reason: n.reason,
					candidate_id: key,
					nominated_type: n.nominated_type,
					origin: 'nomination',
				});
			}
			return { ...consumed, newly_recorded: recorded };
		},
		/**
		 * II-3：真实 insights 覆盖数据喂 criterion 五门。
		 * insightFiles 由调用方读盘传入（不反向 import memory）。
		 */
		async criteria(insightFiles) {
			const candidates = criterionEvidenceFromInsights(insightFiles);
			// III-3：判据五门逐条裁决，同样受预算约束（不静默截断）。
			const budgetCheck = checkBudget({ items: candidates.length, rows: candidates.length });
			if (!budgetCheck.ok) {
				return {
					candidates: [],
					verdicts: [],
					terminated_by: budgetCheck.code,
					budget: budgetCheck.detail,
					note: `本批 ${candidates.length} 条超过预算 ${budgetCheck.detail.maxItems}，已整批终止（未部分执行）。分批重跑。`,
				};
			}
			const verdicts = candidates.map((c) => ({ candidate_id: c.candidate_id, ...this.upward('L2', 'L1', c) }));
			return { candidates, verdicts, budget_used: { items: candidates.length } };
		},
		/**
		 * III-1：治理循环单轮。账本从盘上读（调用方不传 entries），
		 * 原则清单由调用方给（agent 提名哪些原则受检——治理不自动枚举全部原则，
		 * 那会把没被用过的原则也判 uncertain 刷屏）。结果落账 gate=governance。
		 */
		async govern(input = {}) {
			// III-3：受检原则数 + 反例总数都算批量规模；超限整批终止。
			const principles = Array.isArray(input.principles) ? input.principles : [];
			const antiTotal = principles.reduce((n, p) => n + (Array.isArray(p?.anti_examples) ? p.anti_examples.length : 0), 0);
			const budgetCheck = checkBudget({ items: principles.length, rows: principles.length + antiTotal });
			if (!budgetCheck.ok) {
				return { terminated_by: budgetCheck.code, budget: budgetCheck.detail, principle_reports: [], redefinition_proposals: [], human_gate_required: true };
			}
			const entries = await readDecisions(storageDir);
			if (entries === undefined) {
				reportFinding(PROBE_CODES.storeUnreadable, 'warn', '治理循环读账本失败。');
				return { error: 'ledger_unreadable' };
			}
			const result = governanceRound(
				{ ...input, entries },
				{ thresholds, layers, windowDays: input.window_days, minSampleSize: input.min_sample_size },
			);
			void appendDecision(storageDir, {
				gate: 'governance',
				direction: 'governance',
				outcome: result.human_gate_required ? 'skipped' : 'admitted',
				action: result.terminated_by,
				reason: result.redefinition_proposals.map((p) => p.principle_id).join('+') || result.terminated_by,
				origin: input.origin ?? 'daily',
			});
			return result;
		},
	};
}

/** 工具名。 */
export const TOOL_NAMES = { check: 'valve_check', confirm: 'valve_confirm', metrics: 'valve_metrics', nominate: 'valve_nominate', govern: 'valve_govern' };

export function apply(ctx, config = {}, overrides = {}) {
	const logger = overrides.logger ?? ctx.logger?.('valves');
	let thresholds;
	try {
		thresholds = mergeThresholds(config?.thresholds);
	} catch (error) {
		// 配置错要在装载时可见，但不炸整个宿主：降级用默认值 + 探针点名。
		logger?.error?.(`thresholds 配置非法，退回默认值：${error instanceof Error ? error.message : String(error)}`);
		facts.loadError = `thresholds: ${error instanceof Error ? error.message : String(error)}`;
		thresholds = { ...DEFAULT_THRESHOLDS };
	}

	runtime = createRuntime({
		storageDir: typeof config?.storageDir === 'string' && config.storageDir.trim() ? config.storageDir.trim() : undefined,
		thresholds,
		layers: config?.layers,
	});
	// III-6 语义层的 embedder 是**可选 peer**：配置里给了函数才用，
	// 缺了就是 degraded（N4：附加能力缺了要降级，主流程不依赖它）。
	const semanticEmbedder = typeof config?.embedder === 'function' ? config.embedder : undefined;
	facts.semanticEmbedder = semanticEmbedder === undefined ? 'absent' : 'configured';
	facts.storageDir = runtime.storageDir;
	facts.thresholdsOverridden = config?.thresholds !== undefined && Object.keys(config.thresholds ?? {}).length > 0;
	facts.loaded = true;

	// ── III-7 定时巡检 ───────────────────────────────────────────────────
	// 为什么不用第三方 timer 插件：巡检是附加能力，零依赖才降级得干净（N4）。
	//
	// 为什么除了 interval 还要"启动即补跑一次"：interval 只在进程活着时走，
	// 宿主重启就重新计时。频繁重启时周检可能**永远等不到那一刻**——
	// 那等于没有定时巡检。所以启动时先看上次报告时间，过期就立刻补跑。
	const patrolConfig = config?.patrol ?? {};
	const patrolEnabled = patrolConfig.enabled !== false; // 缺省开
	const patrolTimers = [];
	const runPatrol = async (kind) => {
		try {
			const last = await readLatestPatrolReport(runtime.storageDir, kind);
			const period = kind === 'quarterly' ? PATROL_PERIODS.quarterlyMs : PATROL_PERIODS.weeklyMs;
			if (!isPatrolDue(last, period)) return null;
			// 巡检自己也要读数据：原则清单从账本与规则聚合，层次统计从 memory 拿。
			// 拿不到就只跑周级（原则巡检不依赖外部），季度级如实记 skipped。
			if (kind === 'quarterly') {
				// P0-1b (2026-11-14): same shape as the weekly fix. The quarterly
				// patrol used to skip silently (`skipped_no_layer_counts`) because
				// nobody configured `layerCounts`; real metrics read
				// `quarterly: "never"`. Layer counts are ordinary directories, so
				// enumerate them from disk when no callback is configured.
				let layers = Array.isArray(config?.layers) && config.layers.length ? config.layers : DEFAULT_LAYERS;
				let counts = typeof patrolConfig.layerCounts === 'function'
					? await patrolConfig.layerCounts()
					: undefined;
				if (counts === undefined) {
					const rootForLayers = typeof patrolConfig.memoryRoot === 'string' && patrolConfig.memoryRoot.trim()
						? patrolConfig.memoryRoot.trim()
						: memoryRootForStorage(runtime.storageDir);
					const got = await readLayerCountsFromDisk(rootForLayers);
					if (!got.ok) {
						// Report the failure instead of pretending the layer is empty.
						facts.patrolQuarterly = `error:${got.error}`;
						const failed = {
							kind: 'quarterly',
							at: new Date().toISOString(),
							ok: false,
							error: 'layer_counts_unreadable',
							note: `层目录无法读取（${got.error}），本轮未巡检任何层（不是 clean）`,
						};
						await writePatrolReport(runtime.storageDir, failed);
						return failed;
					}
					layers = got.layers;
					counts = got.counts;
				}
				return await runtime.patrol('quarterly', { layers, counts });
			}
			// 周检没拿到原则清单时**不能报 clean**：那等于"什么都没查"却给出
			// "查过没问题"的绿灯（真机第一份报告就是 principles:0 + clean，
			// 这正是"绿灯不携带信息"）。如实记 no_input，让读数说出真相。
			//
			// P0-1（2026-11-13）：no_input 曾经**永远**触发——配置没人传原则清单，
			// 定时器每 7 天空转一次。原则的来源本来就在盘上（insights/ + 账本
			// principle_refs + 阀门证据节），这里直接从磁盘枚举，配置显式给的
			// principles 仍优先（测试注入/人工指定受检面）。
			const configPrinciples = Array.isArray(patrolConfig.principles) ? patrolConfig.principles : null;
			let principles = configPrinciples ?? [];
			let principlesBasis = configPrinciples ? 'config' : 'none';
			if (principles.length === 0 && configPrinciples === null) {
				const rootForPrinciples = typeof patrolConfig.memoryRoot === 'string' && patrolConfig.memoryRoot.trim()
					? patrolConfig.memoryRoot.trim()
					: memoryRootForStorage(runtime.storageDir);
				const ledgerForRefs = await readDecisions(runtime.storageDir);
				const got = await readPrinciplesFromDisk(rootForPrinciples, ledgerForRefs ?? []);
				if (got.ok) {
					principles = got.principles;
					principlesBasis = got.absent ? 'disk_absent' : 'disk';
					if (ledgerForRefs === undefined) facts.patrolRefsBasis = 'ledger_unreadable_refs_zero';
				} else {
					facts.patrolPrinciples = `error:${got.error}`;
				}
			}
			// 待决策的候选公理（2026-11-10）：默认从**磁盘**读 `dao/_candidates/`，
			// 不反向 import memory（依赖方向纪律）；配置给了回调就用回调覆盖。
			//
			// 为什么放进周检：候选写进去如果没人提醒，就等于"存在但没人知道"，
			// 和没写一样。周检是天然提醒时机——每周一看报告就能决定。
			let pendingCandidates = null;
			// Same root resolution as principles (P0-1): config override, else
			// derived from storageDir — never homedir, so sandbox tests stay clean.
			const rootForCandidates = typeof patrolConfig.memoryRoot === 'string' && patrolConfig.memoryRoot.trim()
				? patrolConfig.memoryRoot.trim()
				: memoryRootForStorage(storageDir);
			try {
				if (typeof patrolConfig.pendingAxiomCandidates === 'function') {
					const got = await patrolConfig.pendingAxiomCandidates();
					pendingCandidates = Array.isArray(got) ? got : null;
				} else {
					const got = await readPendingAxiomCandidates(rootForCandidates);
					// 读失败不静默当零候选：那会让人以为"没有待决策项"。
					if (!got.ok) facts.patrolCandidates = `error:${got.error}`;
					else pendingCandidates = got.candidates;
				}
			} catch (err) {
				facts.patrolCandidates = `error:${err instanceof Error ? err.message : String(err)}`;
			}
			if (principles.length === 0 && pendingCandidates === null) {
				const skipped = {
					kind: 'weekly',
					at: new Date().toISOString(),
					ok: false,
					error: 'no_input',
					note: '未提供原则清单、也没有候选公理来源，本轮未实际巡检任何东西（不是 clean）',
				};
				await writePatrolReport(runtime.storageDir, skipped);
				facts.patrolWeekly = 'skipped_no_principles';
				return null;
			}
			// 原则为空但有候选：仍要跑一轮，否则"每周提醒候选"这件事永远不发生。
			const report = await runtime.patrol('weekly', { principles });
			if (pendingCandidates !== null) {
				// 候选单独成段，不混进 findings：findings 是"原则本身有问题"，
				// 候选是"等你决策"，两件事混在一起会让人以为候选也是故障。
				const enriched = {
					...report,
					pending_axiom_candidates: {
						count: pendingCandidates.length,
						items: pendingCandidates,
						...(pendingCandidates.length
							? { note: '有候选公理待你决策：确认转正，或说明理由否决（否决会留档作为反例）' }
							: {}),
					},
				};
				await writePatrolReport(runtime.storageDir, enriched);
				facts.patrolCandidates = pendingCandidates.length;
				return enriched;
			}
			return report;
		} catch (error) {
			// 巡检失败不能拖垮插件：记事实 + 日志，不抛。
			facts.patrolError = error instanceof Error ? error.message : String(error);
			logger?.warn?.(`巡检执行失败：${facts.patrolError}`);
			return null;
		}
	};
	if (patrolEnabled) {
		// 启动补跑（不 await，装载不被巡检拖慢）
		void runPatrol('weekly');
		void runPatrol('quarterly');
		for (const [kind, period] of [['weekly', PATROL_PERIODS.weeklyMs], ['quarterly', PATROL_PERIODS.quarterlyMs]]) {
			try {
				// 夹到 32 位上限：90 天超过 Node setInterval 的上限会被压成 1ms
				// （实测 TimeoutOverflowWarning，季度巡检变忙循环）。夹短之后
				// 每次唤醒都用 isPatrolDue 判是否真到期，行为仍然正确。
				const t = setInterval(() => { void runPatrol(kind); }, clampTimerDelay(period));
				// unref：巡检不该阻止进程退出（测试/CLI 场景尤其重要）。
				if (typeof t?.unref === 'function') t.unref();
				patrolTimers.push(t);
			} catch {
				// 环境没有 setInterval（极少见）：巡检降级为"只能手动跑"。
				facts.patrolTimers = 'unavailable';
			}
		}
		facts.patrol = 'enabled';
	} else {
		facts.patrol = 'disabled';
	}
	// 插件卸载时清掉定时器，否则重载会叠加出多个并行巡检。
	if (typeof ctx.on === 'function') {
		ctx.on('dispose', () => {
			for (const t of patrolTimers) {
				try { clearInterval(t); } catch { /* ignore */ }
			}
			patrolTimers.length = 0;
		});
	}

	// 服务发布：memory 等成员用 ctx.get('valves') 运行时探测（可选依赖）。
	// ctx.provide 两参数形态（Cordis 4.0.5 实测）；provide 不可用时退回 ctx.set。
	try {
		if (typeof ctx.provide === 'function') ctx.provide('valves', runtime);
		else if (typeof ctx.set === 'function') ctx.set('valves', runtime);
	} catch (error) {
		logger?.warn?.(`valves 服务发布失败（工具面不受影响）：${error instanceof Error ? error.message : String(error)}`);
	}

	let defineTool;
	try {
		defineTool = (overrides.loadDefineTool ?? loadDefineTool)(config?.dshRoot);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		facts.loadError = reason;
		logger?.error?.(`valve 工具未注册：无法加载宿主工具定义器。原因：${reason}`);
		return;
	}

	const checkTool = defineTool({
		name: TOOL_NAMES.check,
		description:
			'两类阀门的准入判定（提名→代码裁决→留痕）。direction=down：上一层原则是否已具体化到下一层可执行（查负向黑名单、查具体化、禁跳层）；' +
			'direction=up：反例/证据是否够格修改上层（J1 可外部检验、逐层不跳、正负向阈值）。' +
			'**判定 accept/human_gate 不等于生效**：负向规则生效必须走 valve_confirm（人工确认），正向规则写入走 memory 工具（其层级闸门更严）。' +
			'阈值为暂定值，判定与拒绝都落双侧账本（valve_metrics 可查漏判分母）。' +
			'direction=semantic：语义越权**只标记不阻断**（标 possible_semantic_bypass 进人工抽查）；词面层永远可用，' +
			'语义层需要 embedder（可选 peer），缺了如实标 degraded 且不阻断主流程（N4）。',
		parameters: {
			direction: { type: 'string', required: true, enum: ['down', 'up', 'principle', 'semantic'], description: 'down=下行准入；up=上行准入；principle=原则失效判定（外层治理判据核）；semantic=语义越权标记（不阻断）。' },
			from: { type: 'string', description: '源层（如 L2）。direction=principle 时可省。' },
			to: { type: 'string', description: '目标层（如 L1）。direction=principle 时可省。' },
			semantic: {
				type: 'object',
				additionalProperties: false,
				properties: {
					text: { type: 'string', description: 'semantic：待检查的候选描述/约束文本。' },
					candidate_id: { type: 'string', description: 'semantic：候选标识（落账用）。' },
					similarity_threshold: { type: 'number', description: 'semantic：语义相似度阈值（缺省 0.82，暂定）。' },
				},
				description: 'direction=semantic 的输入。embedder 由插件配置提供，调用方不可传函数。',
			},
			data: {
				type: 'object',
				additionalProperties: false,
				properties: {
					// 样本口径（可选）：验证/演练样本显式标记，日常样本缺省不标。
					// I-1 计数只数无 origin 或 origin=daily 的行——验证样本不得灌进校准分布。
					origin: { type: 'string', enum: ['daily', 'verification', 'drill', 'nomination'], description: '样本类型：daily=日常（缺省）；verification=部署/闭环验证；drill=演练；nomination=自动提名器产物。' },
					testChannel: { type: 'boolean', description: 'up 公理：声明走测试通道——不消耗月度额度、不进生产分布（IV-5）。只能由显式参数打开，不读环境变量。' },
					// down
					constraints: { type: 'array', items: { type: 'string' }, description: 'down：已具体化的可执行约束（空 = 未具体化，拒）。' },
					touches_axiom: { type: 'boolean', description: 'down：是否触及公理语义（true → human_gate）。' },
					// up 通用
					kind: { type: 'string', enum: ['positive', 'negative'], description: 'up：正向候选或负向候选。' },
					rule_type: { type: 'string', enum: ['skill', 'criterion', 'axiom'], description: 'up 正向：规则类型。' },
					negative_type: { type: 'string', enum: ['forbidden_skill', 'invalidated_criterion', 'out_of_scope_scenario', 'weakened_axiom'], description: 'up 负向：负向规则类型。' },
					evidence: { type: 'array', items: { type: 'string' }, description: 'up：反例/证据检索记录（无记录拒绝入库，F12）。' },
					verifiable_by: { type: 'string', description: 'up：用什么外部手段可推翻它（J1 防伪；缺 → 正向降级/负向拒）。' },
					// up 技能
					repeats: { type: 'integer', description: 'up skill：重复次数。' },
					success_rate: { type: 'number', description: 'up skill：成功率 0–1。' },
					success_evidence: { type: 'string', enum: ['external', 'self_report'], description: 'up skill：成败证据来源——只认 external（退出码/断言），self_report 拒。' },
					failure_count: { type: 'integer', description: 'up forbidden_skill：失败次数。' },
					// up 判据
					skill_coverage: { type: 'integer', description: 'up criterion：覆盖独立技能数。' },
					scenario_coverage: { type: 'integer', description: 'up criterion：覆盖场景数。' },
					anti_example_count: { type: 'integer', description: 'up criterion/weakened_axiom：可外部检验反例数。' },
					predict_rate: { type: 'number', description: 'up criterion：预测新场景成功率 0–1。' },
					overlap: { type: 'number', description: 'up criterion：与已有判据重叠度 0–1。' },
					out_of_scope_hits: { type: 'integer', description: 'up out_of_scope_scenario：越界次数。' },
					distinct_criteria: { type: 'integer', description: 'up weakened_axiom：反例来自几个不同判据。' },
					// principle
					source_diversity: { type: 'integer', description: 'principle：反例来源多样性。' },
					coverage_rate: { type: 'number', description: 'principle：原则能解释的 trace 占比 0–1。' },
					conflict_with_upper: { type: 'boolean', description: 'principle：与上层原则存在可判别冲突。' },
					window_rounds: { type: 'integer', description: 'principle：统计覆盖的轮数。' },
				},
				description: '判定输入：字段按 direction 取用（down 用 constraints/touches_axiom；up 用 kind 及其分支字段；principle 用统计四件套）。',
			},
		},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute(args) {
			try {
				if (args.direction === 'principle') {
					return { direction: 'principle', ...runtime.principle(args.data ?? {}) };
				}
				if (args.direction === 'down') {
					// 黑名单服务端自查：判定与检索分离，但检索不靠调用方自觉。
					const text = Array.isArray(args.data?.constraints) ? args.data.constraints.join('\n') : '';
					const hits = await runtime.matchNegative(text);
					const data = {
						...(args.data ?? {}),
						// 读库失败（undefined）不当"没命中"：如实转人工。
						...(hits === undefined ? { touches_axiom: true } : { negative_rule_hits: hits }),
					};
					const decision = runtime.downward(args.from, args.to, data);
					return { direction: 'down', ...decision, ...(hits === undefined ? { note: '负向规则库读取失败，按不可判定转人工（没查成 ≠ 没命中）' } : {}) };
				}
				if (args.direction === 'semantic') {
					// III-6：标记不阻断。embedder 来自插件配置（可选 peer），
					// 调用方不能传函数——工具参数只接受 JSON。
					return {
						direction: 'semantic',
						...(await runtime.semanticCheck({
							text: args.semantic?.text,
							candidate_id: args.semantic?.candidate_id,
							similarity_threshold: args.semantic?.similarity_threshold,
							...(typeof semanticEmbedder === 'function' ? { embed: semanticEmbedder } : {}),
						})),
					};
				}
				// IV-5：走限速版本——公理类变更额外受月度额度约束。
				// testChannel 只能由 **data 里的显式字段** 打开（见 ratelimit.js 的说明）。
				return {
					direction: 'up',
					...(await runtime.upwardWithAxiomLimit(args.from, args.to, args.data ?? {}, {
						...(args.data?.testChannel === true ? { testChannel: true } : {}),
					})),
				};
			} catch (error) {
				return { error: 'valve_check 执行失败', reason: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	const confirmTool = defineTool({
		name: TOOL_NAMES.confirm,
		description:
			'人工确认一条负向规则并写入生效库（唯一生效通道）。调用前提：用户已在对话中明确确认这条禁令/证伪/越界标记。' +
			'未经用户确认不得调用——这是人工闸门的语义，不是自动流程的一步。' +
			'生效后下行准入与 memory 召回自动使用它（零配合：不需要其它插件改代码）。' +
			'**回退**：传 action=rollback 与 rollback_rule_id，把该规则退到上一版快照（写入前已自动快照）。' +
			'同一规则回退满 3 次后拒绝自动回退并转人工——反复回退说明判据本身不稳，该由人重新想一遍。' +
			'**沉底（IV-3）**：传 action=sink 与 sink_rule_id/sink_rule_ids，把长期未触发的规则移出拦截但**保留内容**（不删除，仍可检索为反例资产）；' +
			'沉底同样写前快照，回退即重新激活。定时巡检只报沉底候选，不代替人做这个决定。',
		parameters: {
			action: { type: 'string', enum: ['confirm', 'rollback', 'sink'], description: '缺省 confirm（写入/修订规则）；rollback 退到上一版；sink 沉底过期规则（移出拦截、保留资产）。' },
			rollback_rule_id: { type: 'string', description: 'action=rollback 时必填：要回退的规则 id。' },
			sink_rule_id: { type: 'string', description: 'action=sink 时必填（单条）：要沉底的规则 id。' },
			sink_rule_ids: { type: 'array', items: { type: 'string' }, description: 'action=sink 时可批量：要沉底的规则 id 列表（巡检报出的候选）。' },
			sink_reason: { type: 'string', description: 'action=sink 可选：沉底理由（进规则内容与账本，便于日后回查为什么退休）。' },
			id: { type: 'string', description: '规则稳定 id（kebab-case，如 forbidden-retry-without-read）。同 id 覆盖为修订。action=confirm 时必填。' },
			negative_type: { type: 'string', enum: ['forbidden_skill', 'invalidated_criterion', 'out_of_scope_scenario', 'weakened_axiom'], description: '负向规则类型。action=confirm 时必填。' },
			statement: { type: 'string', description: '一句话禁令/证伪陈述（会注入到后续召回里，写给未来的 agent 看）。action=confirm 时必填。' },
			keywords: { type: 'array', items: { type: 'string' }, description: '下行匹配关键词：候选路径描述包含任一词即命中拦截。选具体词，避免误杀。' },
			layer: { type: 'string', description: '规则所属层（如 L2）。' },
			source: { type: 'string', description: '确认来源（如用户原话摘要、trace id）。' },
		},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute(args) {
			if (args?.action === 'rollback') {
				const ruleId = String(args?.rollback_rule_id ?? '').trim();
				if (!ruleId) return { error: 'action=rollback 需要 rollback_rule_id' };
				return runtime.rollback(ruleId);
			}
			if (args?.action === 'sink') {
				// IV-3 沉底：移出拦截、保留为反例资产。同样是人工通道（本人调用），
				// 定时巡检只报候选，不代劳。
				const ids = (Array.isArray(args.sink_rule_ids) ? args.sink_rule_ids : [args.sink_rule_id])
					.map((v) => String(v ?? '').trim())
					.filter(Boolean);
				if (!ids.length) return { error: 'action=sink 需要 sink_rule_id 或 sink_rule_ids' };
				return runtime.sink(ids, { reason: args.sink_reason });
			}
			return runtime.confirm(args);
		},
	});

	const metricsTool = defineTool({
		name: TOOL_NAMES.metrics,
		description:
			'读阀门双侧账本：evaluated/admitted/skipped + missRate（skipped/evaluated）+ 按 reason/gate 分布 + 负向规则数 + 当前阈值。' +
			'判读：missRate 接近 1 = 几乎全拒（可能误杀或阈值过严）；接近 0 = 几乎全放（可能没在管）。' +
			'阈值全部暂定，本工具的分布就是将来校准阈值的原料。',
		parameters: {},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute() {
			return runtime.metrics();
		},
	});

	const nominateTool = defineTool({
		name: TOOL_NAMES.nominate,
		description:
			'自动提名器（阶段 II）：从既有真实账本聚合候选——负向吃 clis-interventions.jsonl 的重复失败签名（≥阈值才提名），' +
			'正向吃 memory 使用聚合（高频功能域值得结晶技能）。**只提名不生效**：候选交 valve_check 裁决、人工确认后生效。' +
			'正向候选不编造成功率（usage 账本没有外部成败证据），如实标 needs_external_evidence；' +
			'泛化失败签名标 degraded_signature（可能是假重复，确认前须回查原始记录）。' +
			'channel=clis_trace：消费 clis-history 提名+裁决成对留痕（幂等，账本当游标）；' +
			'channel=criteria：真实 insights 来源回链喂判据五门（数不出的留空，阀门如实 downgrade）。',
		parameters: {
			channel: { type: 'string', enum: ['forbidden', 'skills', 'criteria', 'clis_trace', 'both'], description: '提名通道：负向/正向技能/判据五门/CLIS历史留痕/两侧。缺省 both。' },
			window_days: { type: 'number', description: '负向统计窗口（天）；缺省不限（全量账本）。' },
			check: { type: 'boolean', description: 'true 时把每条候选立即送 valve_check 裁决并落账（origin=nomination）；缺省 false 只列候选。' },
			insight_files: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						theme: { type: 'string', required: true, description: 'insight 文件名（不含 .md）。' },
						text: { type: 'string', required: true, description: 'insight 正文（调用方经 memory_read 读盘传入）。' },
					},
				},
				description: 'channel=criteria 时必给：真实 insights 正文，从来源回链数覆盖、喂五门（数不出的字段留空，阀门如实 downgrade）。',
			},
		},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute(args) {
			try {
				if (args?.channel === 'clis_trace') return await runtime.clisTrace();
				if (args?.channel === 'criteria') {
					if (!Array.isArray(args?.insight_files)) return { error: 'channel=criteria 需要 insight_files（经 memory_read 读盘传入）' };
					return await runtime.criteria(args.insight_files);
				}
				return await runtime.nominate(args ?? {});
			} catch (error) {
				return { error: 'valve_nominate 执行失败', reason: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	const governTool = defineTool({
		name: TOOL_NAMES.govern,
		description:
			'外层治理循环单轮（阶段 III）：读阀门账本 → 对指定原则做体检（引用覆盖率 + 反例四判据）→ 失效则出改定义提议。' +
			'**不执行任务、不修改规则库**——提议生效走人工闸门。覆盖率口径：只数账本行显式 principle_refs 引用（不猜语义关联）；' +
			'窗口内日常样本 <10 条不出覆盖率（小样本噪声不触发失效，判 uncertain）。' +
			'归类提名（classification）由调用方给，代码只校验形态与置信度（<0.7 转人工）。' +
			'原则清单由调用方指定受检对象——不自动枚举全部原则（没用过的原则判 uncertain 只会刷屏）。',
		parameters: {
			principles: {
				type: 'array',
				required: true,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						principle_id: { type: 'string', required: true, description: '原则标识（与账本 principle_refs 精确匹配）。' },
						statement: { type: 'string', description: '原则陈述（进提议用）。' },
						anti_examples: {
							type: 'array',
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									source: { type: 'string', description: '反例来源（任务类型/域）。' },
									trace_ref: { type: 'string', required: true, description: '可回查的 trace/账本引用。' },
								},
							},
							description: '可外部检验的反例列表。',
						},
						conflict_with_upper: { type: 'boolean', description: '与上层原则存在可判别冲突。' },
						semantic_coverage: { type: 'number', description: '人工判读的语义覆盖率 0–1（显式给才用，覆盖引用口径）。' },
					},
				},
				description: '本轮受检原则清单。',
			},
			classification: {
				type: 'object',
				additionalProperties: false,
				properties: {
					layer: { type: 'string', description: '提名的起始层。' },
					confidence: { type: 'number', description: '提名置信度 0–1。' },
					evidence: { type: 'array', items: { type: 'string' }, description: '归类依据。' },
				},
				description: '可选：当前问题的归类提名（LLM 给，代码校验）。',
			},
			window_days: { type: 'number', description: '覆盖率统计窗口（天）；缺省全量。' },
			min_sample_size: { type: 'number', description: '覆盖率最小样本数（缺省 10，暂定）。' },
			origin: { type: 'string', enum: ['daily', 'verification', 'drill'], description: '本轮治理判定的样本标记（缺省 daily）。' },
		},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute(args) {
			try {
				return await runtime.govern(args ?? {});
			} catch (error) {
				return { error: 'valve_govern 执行失败', reason: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	for (const tool of [checkTool, confirmTool, metricsTool, nominateTool, governTool]) {
		ctx.tools.register(tool);
		facts.registeredTools.push(tool.name ?? '(unnamed)');
	}
}

/** 运行时句柄（memory 等消费方经 ctx.get 拿；测试可直接取）。 */
export function getRuntime() {
	return runtime;
}

/**
 * 健康探针：只报事实——装载没有、工具注册没有、账本读得动吗。
 * 只读、不抛错（监督层零参数调用）。
 */
export function probe() {
	const findings = [];
	if (!facts.loaded) {
		findings.push({ code: PROBE_CODES.notLoaded, severity: 'error', message: 'valves 未装载（apply 未执行）。', hint: '查宿主启动日志。' });
	} else {
		if (facts.registeredTools.length < 5) {
			findings.push({
				code: PROBE_CODES.toolMissing,
				severity: 'error',
				message: `工具只注册了 ${facts.registeredTools.length}/5：${facts.loadError ?? '原因未知'}`,
				hint: '多为宿主定位失败；设 DSH_INSTALL_DIR 或 config.dshRoot。',
			});
		}
		if (facts.thresholdsOverridden) {
			findings.push({ code: PROBE_CODES.thresholdsOverridden, severity: 'info', message: '阈值被配置覆盖（默认值全部暂定）。' });
		}
		for (const f of facts.runtimeFindings.values()) findings.push(f);
		if (!findings.some((f) => f.severity === 'error' || f.severity === 'warn')) {
			findings.push({
				code: PROBE_CODES.ok,
				severity: 'info',
				message: `valves 装载且 ${facts.registeredTools.length} 工具注册；账本目录 ${facts.storageDir}。阈值为暂定值，待分布校准。`,
			});
		}
	}
	const status = findings.some((f) => f.severity === 'error') ? 'failing' : findings.some((f) => f.severity === 'warn') ? 'degraded' : 'ok';
	return { plugin: 'valves', status, findings };
}

export const healthProbe = { probe };

export { admitDownward, admitUpward, checkPrinciple, isExternallyVerifiable, mergeThresholds, DEFAULT_LAYERS, DEFAULT_THRESHOLDS, governanceRound, referenceCoverage, validateClassification };