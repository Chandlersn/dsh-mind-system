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
import { mergeThresholds, DEFAULT_LAYERS, DEFAULT_THRESHOLDS } from './src/thresholds.js';
import {
	appendDecision,
	readDecisions,
	summarizeDecisions,
	readNegativeRules,
	confirmNegativeRule,
	matchNegativeRules,
} from './src/store.js';
import { nominateFromDisk } from './src/nominate.js';

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
			...(input?.origin === undefined ? {} : { origin: input.origin }),
		});
		return decision;
	};

	return {
		storageDir,
		thresholds,
		layers,
		downward(from, to, data) {
			return record(`downward_${from}_${to}`, 'down', admitDownward(from, to, data, { layers, thresholds }), { from, to, origin: data?.origin });
		},
		upward(from, to, candidate) {
			return record(`upward_${from}_${to}`, 'up', admitUpward(from, to, candidate, { layers, thresholds }), {
				from,
				to,
				candidate_id: candidate?.candidate_id ?? candidate?.rule_id,
				origin: candidate?.origin,
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
				...(stats?.origin === undefined ? {} : { origin: stats.origin }),
			});
			return verdict;
		},
		async negativeRules() {
			return readNegativeRules(storageDir);
		},
		async matchNegative(text) {
			const rules = await readNegativeRules(storageDir);
			return matchNegativeRules(rules, text);
		},
		async confirm(rule) {
			const result = await confirmNegativeRule(storageDir, rule);
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
			return {
				...summarizeDecisions(entries),
				negative_rules: rules === undefined ? null : rules.length,
				negative_store: rules === undefined ? 'unreadable' : 'ok',
				thresholds,
				thresholds_status: '暂定（待实测分布校准）',
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
				out.verdicts = [];
				for (const c of [...(out.forbidden ?? []), ...(out.skills ?? [])]) {
					// 器→术：候选都在 L3 原料层，目标 L2。
					const decision = this.upward('L3', 'L2', c);
					out.verdicts.push({ candidate_id: c.candidate_id, ...decision });
				}
			}
			return out;
		},
	};
}

/** 工具名。 */
export const TOOL_NAMES = { check: 'valve_check', confirm: 'valve_confirm', metrics: 'valve_metrics', nominate: 'valve_nominate' };

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
	facts.storageDir = runtime.storageDir;
	facts.thresholdsOverridden = config?.thresholds !== undefined && Object.keys(config.thresholds ?? {}).length > 0;
	facts.loaded = true;

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
			'阈值为暂定值，判定与拒绝都落双侧账本（valve_metrics 可查漏判分母）。',
		parameters: {
			direction: { type: 'string', required: true, enum: ['down', 'up', 'principle'], description: 'down=下行准入；up=上行准入；principle=原则失效判定（外层治理判据核）。' },
			from: { type: 'string', description: '源层（如 L2）。direction=principle 时可省。' },
			to: { type: 'string', description: '目标层（如 L1）。direction=principle 时可省。' },
			data: {
				type: 'object',
				additionalProperties: false,
				properties: {
					// 样本口径（可选）：验证/演练样本显式标记，日常样本缺省不标。
					// I-1 计数只数无 origin 或 origin=daily 的行——验证样本不得灌进校准分布。
					origin: { type: 'string', enum: ['daily', 'verification', 'drill', 'nomination'], description: '样本类型：daily=日常（缺省）；verification=部署/闭环验证；drill=演练；nomination=自动提名器产物。' },
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
				return { direction: 'up', ...runtime.upward(args.from, args.to, args.data ?? {}) };
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
			'生效后下行准入与 memory 召回自动使用它（零配合：不需要其它插件改代码）。',
		parameters: {
			id: { type: 'string', required: true, description: '规则稳定 id（kebab-case，如 forbidden-retry-without-read）。同 id 覆盖为修订。' },
			negative_type: { type: 'string', required: true, enum: ['forbidden_skill', 'invalidated_criterion', 'out_of_scope_scenario', 'weakened_axiom'], description: '负向规则类型。' },
			statement: { type: 'string', required: true, description: '一句话禁令/证伪陈述（会注入到后续召回里，写给未来的 agent 看）。' },
			keywords: { type: 'array', items: { type: 'string' }, description: '下行匹配关键词：候选路径描述包含任一词即命中拦截。选具体词，避免误杀。' },
			layer: { type: 'string', description: '规则所属层（如 L2）。' },
			source: { type: 'string', description: '确认来源（如用户原话摘要、trace id）。' },
		},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute(args) {
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
			'泛化失败签名标 degraded_signature（可能是假重复，确认前须回查原始记录）。',
		parameters: {
			channel: { type: 'string', enum: ['forbidden', 'skills', 'both'], description: '提名通道：负向/正向/两侧。缺省 both。' },
			window_days: { type: 'number', description: '负向统计窗口（天）；缺省不限（全量账本）。' },
			check: { type: 'boolean', description: 'true 时把每条候选立即送 valve_check 裁决并落账（origin=nomination）；缺省 false 只列候选。' },
		},
		output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
		async execute(args) {
			try {
				return await runtime.nominate(args ?? {});
			} catch (error) {
				return { error: 'valve_nominate 执行失败', reason: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	for (const tool of [checkTool, confirmTool, metricsTool, nominateTool]) {
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
		if (facts.registeredTools.length < 4) {
			findings.push({
				code: PROBE_CODES.toolMissing,
				severity: 'error',
				message: `工具只注册了 ${facts.registeredTools.length}/4：${facts.loadError ?? '原因未知'}`,
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

export { admitDownward, admitUpward, checkPrinciple, isExternallyVerifiable, mergeThresholds, DEFAULT_LAYERS, DEFAULT_THRESHOLDS };