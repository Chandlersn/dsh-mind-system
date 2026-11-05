/**
 * 层级准入闸门 —— 把「道 / 法 / 专项」的判据写成**可执行谓词**。
 *
 * ## 为什么需要这个模块（2026-10-27 用户要求）
 *
 * 「道必须从 ≥5 条法萃取」「法必须跨 ≥2 个来源域」这类纪律，此前只写在
 * MEMORY.md 的说明文字里。写进文档的约束等于没有约束：
 *   - 模型读完不一定记得；
 *   - 记得也不一定照做；
 *   - 照做了也没人验证；
 *   - 违反了完全没有症状。
 *
 * 从本模块起，每条准入条件都是**一个函数**：输入实际数据，输出通过/拒绝。
 * 判据不合格时写入直接失败（不是警告），错误消息里带**差在哪里、还缺几条**。
 * 纪律从「提示词里的文字」变成「调用即失败的门」。
 *
 * ## 三层判据
 *
 * | 层 | 存放 | 硬条件（拒绝写入） | 软条件（警告） |
 * |---|---|---|---|
 * | 道 dao/ | 独立文件 | 必须挂 ≥5 条**来源法**；命题不得含具体工具/项目名；每卦必须声明它覆盖哪些法 | 数量 > 7 |
 * | 法 insights/（法层） | insights/ | ≥2 个**无关来源功能域** | 含操作步骤句式、字数超限 |
 * | 专项 insights/（专项层） | insights/ | —（本来就只要求 1 源） | 单源占比 > 阈值时提示整层命名有问题 |
 *
 * ## 为什么「来源」要用两种不同的计数
 *
 * 法层的 `sources` 指向 **functions/ 功能域**（一条经验在哪些功能里被验证过）；
 * 道层的 `extractedFrom` 指向 **insights/ 法**（这一条道从哪几条法里萃出来）。
 * 两者不能混：道不直接从功能域萃取——中间必须隔着法，否则就是「单条法换个说法」。
 *
 * @module src/layer-gate.js
 */

/** 道层最少的来源法条数（用户明确要求：至少 5 条）。 */
export const MIN_DAO_SOURCES = 5;

/** 道层数量上限：道多了就不是道，是清单。 */
export const MAX_DAO_ENTRIES = 7;

/** 法层最少的无关来源域数。 */
export const MIN_FA_SOURCES = 2;

/**
 * 道层命题的「抽象度」检查：出现这些词说明它还在讲具体东西，不是道。
 *
 * 刻意只放**强信号**词（具体技术名词、具体项目名、具体文件名），
 * 不放「工具」「系统」这类中性词——它们在任何抽象层都可能出现。
 */
const CONCRETE_MARKERS = [
	// 具体技术名词
	'cordis', 'ctx.', 'http', 'json', 'api', 'sdk', 'npm', 'pnpm', 'git',
	'windows', 'powershell', 'pwsh', 'node', 'typescript', 'javascript',
	'sql', 'css', 'html', 'dom', 'tcp', 'tls', 'dns',
	// 具体项目 / 插件名
	'dsh-', 'deepseek', 'claude', 'gpt', 'memory-manager', 'workbuddy', 'clis',
	'auto-review', 'our-free-model', 'learning-mode', 'batch-print', 'printpress',
	// 具体文件 / 路径形态
	'.js', '.ts', '.md', '.json', '.yml', '.yaml', '.ps1', '.mjs',
	'functions/', 'insights/', 'src/', 'node_modules',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 纯字母数字标记（按词边界匹配）*/
const SHAPE_MARKERS = CONCRETE_MARKERS.filter((m) => !/^[a-z0-9]+$/.test(m));
const WORD_MARKER_RES = CONCRETE_MARKERS.filter((m) => /^[a-z0-9]+$/.test(m)).map((m) => [m, new RegExp(`(?<![a-z0-9])${escapeRe(m)}(?![a-z0-9])`)]);

/**
 * 操作手册句式的强信号（出现在道/法命题里说明它降级成了操作）。
 *
 * 与 memory_insight 原有的 stepLike 保持同一套语感，但更严格：
 * 道层的命题不该出现任何「先…再…」「第一步」这类序列。
 */
// 「先…再…然后」三者齐全才算序列，漏掉了最常见的「先量化再干预」；数字步骤只认
// 中文数字，漏掉了「第1步」。两条都补上（实测这四句原先全部放行）。
const PROCEDURE_MARKERS = /(^|\s)(\d+[.、)]|步骤|第\s*[一二三四五六七八九十\d]+\s*步|命令行|执行命令|运行\s*`|点击|打开菜单|安装依赖|先.{0,12}再|先.{0,12}然后)/;

/**
 * 判断一段文本是否含具体技术/项目标记。
 *
 * 匹配分两类，因为「子串」对两类标记的含义完全不同：
 *   - **形状型**（带标点：`.js`、`ctx.`、`dsh-`、`functions/`）保持子串匹配——它们
 *     本来就是形态；
 *   - **词型**（纯字母数字：`dom`、`git`、`api`）按**词边界**匹配。用 `includes` 时
 *     wisd**om** 会撞上 `dom`、leg**git**imate 会撞上 `git`，于是一条正经的英文道命题
 *     被误判成"含具体技术名"而拒收——尺子量的是"有没有撞到英文短串"，不是"换个
 *     领域是否依然成立"。
 *
 * @param text 待检查文本（命题本体）。
 * @returns 命中的标记列表（空数组 = 够抽象）。
 */
export function concreteMarkersOf(text) {
	const lower = String(text ?? '').toLowerCase();
	const out = [];
	for (const [m, re] of WORD_MARKER_RES) if (re.test(lower)) out.push(m);
	for (const m of SHAPE_MARKERS) if (lower.includes(m)) out.push(m);
	return out;
}

/**
 * 判断一段文本是否是操作手册句式。
 *
 * @param text 待检查文本。
 * @returns 是否命中。
 */
export function looksLikeProcedure(text) {
	return PROCEDURE_MARKERS.test(String(text ?? ''));
}

/**
 * 道层准入判定 —— **纯函数**，所有判据集中在这里，便于穷举测试。
 *
 * @param input 待写入的道条目。
 * @param input.name 道名（slug）。
 * @param input.proposition 命题本体（一句话）。
 * @param input.extractedFrom 萃取来源的 insights/ 法 slug 列表。
 * @param input.existing 已存在的道条目数（用于上限检查）。
 * @returns `{ ok: true, warnings }` 或 `{ ok: false, reason }`。
 */
export function gateDao(input) {
	const warnings = [];
	const name = String(input.name ?? '').trim();
	const proposition = String(input.proposition ?? '').trim();
	const from = Array.isArray(input.extractedFrom) ? input.extractedFrom.filter((s) => String(s ?? '').trim()) : [];

	// —— 硬条件 1：名称与命题必须存在 ——
	if (!name) return { ok: false, reason: '道名不能为空' };
	if (!proposition) return { ok: false, reason: '命题本体不能为空：道要能用一句话说出来' };

	// —— 硬条件 2：必须从 ≥5 条法萃取 ——
	// 这是用户明确的规则：单条法直接升格只是换个说法，没有真正的抽象。
	// 差距必须说清楚（还缺几条、现在有几条），否则模型只会反复试错。
	// 硬条件 2 的计数必须**去重**：`from.length` 曾把「同一条法写 5 遍」算作 5 条
	// 来源，于是规则明文要堵的那条路（单条法换个说法）成了唯一能过的路。返回的
	// `count` 已经是去重值，但闸门判的是原数组长度 —— 判据与产出两处口径不一致，
	// 而唯一读 count 的地方也没人用。
	const unique = [...new Set(from)];
	if (unique.length < MIN_DAO_SOURCES) {
		return {
			ok: false,
			reason:
				`道的萃取来源不足：只有 ${unique.length} 条**不同的**法，至少需要 ${MIN_DAO_SOURCES} 条。` +
				`道不是单条法的抽象，而是多条法共同指向的上位命题——单条抽取只是换了个说法。` +
				`先让这 ${MIN_DAO_SOURCES} 条法稳定存在（insights/），再回头看它们的共同点。` +
				`当前缺 ${MIN_DAO_SOURCES - unique.length} 条。` +
				(from.length !== unique.length ? `（收到 ${from.length} 条，其中 ${from.length - unique.length} 条是重复的同一份法，不计数）` : ''),
		};
	}

	// —— 硬条件 3：命题必须够抽象（不含具体技术/项目标记）——
	const concrete = concreteMarkersOf(proposition);
	if (concrete.length) {
		return {
			ok: false,
			reason:
				`命题里出现了具体标记（${concrete.slice(0, 5).join('、')}）：这还不是道，是法或术。` +
				`道的判据之一是「换一个领域依然成立」——把具体名词换成它所在的抽象范畴，再试一次。`,
		};
	}

	// —— 硬条件 4：命题不能是操作手册 ——
	if (looksLikeProcedure(proposition)) {
		return {
			ok: false,
			reason:
				'命题是操作手册句式（含步骤/序列）：道描述「世界是怎样的」，不描述「先做什么」。' +
				'把步骤留在 functions/，把判断提到 insights/，再往上才是道。',
		};
	}

	// —— 软条件：数量上限 ——
	const existing = Number(input.existing) || 0;
	if (existing >= MAX_DAO_ENTRIES) {
		return {
			ok: false,
			reason:
				`道层已 ${existing} 条，达到上限 ${MAX_DAO_ENTRIES} 条：道多了就不是道，是清单。` +
				'新增前先看能否把已有的两条合并成更高一层的命题，或取代其中一条（supersedes）。',
		};
	}

	// —— 软条件：来源必须是真实的法 ——
	// 目录由调用方校验（本函数保持纯），这里只检查形状。
	const dupes = from.filter((s, i) => from.indexOf(s) !== i);
	if (dupes.length) warnings.push(`来源法有重复项（${[...new Set(dupes)].join('、')}），只按去重后的 ${unique.length} 条计`);
	if (unique.length > MIN_DAO_SOURCES * 2) {
		warnings.push(`${unique.length} 条来源法：留意命题是否真的覆盖它们，还是把不相关的法硬凑进来`);
	}

	return { ok: true, warnings, count: unique.length };
}

/**
 * 判定两个来源功能域是否**无关**（用于「法必须跨 ≥2 个无关来源域」）。
 *
 * ## 为什么这条判据此前是空的（2026-11-02）
 *
 * `gateFa` 只数 `sources.length >= 2`，从不判"无关"。于是 `[clis, clis2]`
 * 这种同族域也能凑成一条"法"——而这正是该规则要挡的东西：同一个实践面里
 * 的两个功能，共享同一批假设，验不出普适性。
 *
 * ## 判据：不是语义相似度，是**归因是否同源**
 *
 * 真正让"跨域"有意义的是：两边的证据来自**不同的判断链**。这里用可判定的
 * 近似——去掉共同的词缀/前缀后是否仍是不同词干，且不互为包含。它不完美，
 * 但比"只数个数"强，且能说清为什么判无关/相关。
 *
 * @param a 来源域 slug。
 * @param b 来源域 slug。
 * @returns 是否可视为无关（不同来源）。
 */
export function unrelatedSources(a, b) {
	const x = String(a ?? '').trim().toLowerCase();
	const y = String(b ?? '').trim().toLowerCase();
	if (!x || !y) return false;
	if (x === y) return false;
	// 互为包含：`clis` vs `clis因果分层系统` 是同一个实践面的不同叫法
	if (x.includes(y) || y.includes(x)) return false;
	// 共同前缀超过较短者一半：视为同族（如 `dsh插件开发` / `dsh视频工坊`）
	const shortLen = Math.min(x.length, y.length);
	let common = 0;
	while (common < shortLen && x[common] === y[common]) common++;
	if (common >= Math.max(2, Math.floor(shortLen / 2))) return false;
	// 2026-11-05：只判共同前缀会漏掉「同族但前缀不同」——`视频渲染` / `渲染管线`
	// 明显同一实践面，却因首个字不同被判无关，可凑成一条「法」。补一条共享词干
	// 判据：任一方含长度 ≥2 的公共连续子串（中文按字、英文按词元），视为同源归因。
	// 只取「较长串里的一个片段在较短串里出现」且长度 ≥2，避免单字噪声（"的"/"与"）。
	for (let len = Math.min(4, shortLen); len >= 2; len--) {
		for (let i = 0; i + len <= x.length; i++) {
			if (y.includes(x.slice(i, i + len))) return false;
		}
	}
	return true;
}

/**
 * 求最大无关子集的大小（精确解，不随输入顺序变化）。
 *
 * `unrelatedSources` 是**非传递**关系（A~B、B~C 但 A≁C 完全可能），贪心"从
 * 第一个开始挑"会让同一组来源换个顺序就得到不同 tier —— 层的归属不该由调用
 * 方传参顺序决定。这里用回溯枚举所有候选子集，取两两无关的最大者；来源数
 * 通常 <10，指数级完全够用，且结果可复现。
 *
 * @param sources 去重后的来源域 slug 列表。
 * @returns 最大无关子集的大小。
 */
export function maxUnrelatedSubset(sources) {
	let best = 0;
	const n = sources.length;
	const walk = (start, picked) => {
		if (picked.length > best) best = picked.length;
		// 剪枝：剩下的全加上也超不过当前最好，提前返回
		if (picked.length + (n - start) <= best) return;
		for (let i = start; i < n; i++) {
			if (picked.every((p) => unrelatedSources(p, sources[i]))) {
				walk(i + 1, [...picked, sources[i]]);
			}
		}
	};
	walk(0, []);
	return best;
}
export function gateFa(input) {
	const warnings = [];
	const principle = String(input.principle ?? '').trim();
	const sources = Array.isArray(input.sources) ? [...new Set(input.sources.filter(Boolean))] : [];

	if (!principle) return { ok: false, reason: '原则本体不能为空' };
	if (!sources.length) {
		return {
			ok: false,
			reason: '来源不能为空：每条法都必须能指出它在哪个功能域被验证过（回链是它唯一的证据）',
		};
	}

	// 单源是**合法的**，只是降级为专项——不拒绝，但必须让调用方知道它进了哪一层。
	//
	// 2026-11-02：规则原文是「≥2 个**无关**来源域」，而此前只数个数、从不判无关。
	// 现在真的判：若所有来源两两都相关（同族/互为包含），实际只有 1 个独立实践面，
	// 仍降级为专项——否则"跨域验证"这个词就是空的。
	let tier = sources.length >= MIN_FA_SOURCES ? '法' : '专项';
	let independentCount = sources.length;
	if (sources.length >= MIN_FA_SOURCES) {
		// 精确求最大无关子集（关系非传递，贪心会随输入顺序给出不同结论）。
		independentCount = maxUnrelatedSubset(sources);
		if (independentCount < MIN_FA_SOURCES) {
			tier = '专项';
			warnings.push(
				`${sources.length} 个来源域里只有 ${independentCount} 个**互相无关**（${sources.join('、')}）→ 归入「专项」：` +
					'同族的域共享同一批假设，验不出普适性。补一个真正不同实践面的来源才算「法」。',
			);
		}
	}
	if (tier === '专项' && independentCount === sources.length) {
		warnings.push(
			`只有 ${sources.length} 个来源域 → 归入「专项」而非「法」：可以留在 insights/，` +
				'但不要当普适原则用，也不要升级为道。补第二个无关来源域后才算法。',
		);
	}

	if (looksLikeProcedure(principle)) {
		warnings.push('原则里出现操作步骤句式：能改写成操作手册的就不是原则，步骤留在 functions/');
	}
	return { ok: true, tier, warnings };
}

// REMOVED (2026-10-28): `extractableClusters(laws)` — a reverse "which clusters
// are ready to extract" helper. It was exported, unit-tested, and **never called
// by production code**: its input was `{ slug, tags }`, but an insight file has
// no tags field at all (the template writes 来源/核心原则/适用面/待观察). So it
// modelled a data shape that does not exist, and its docstring claimed a consumer
// (memory_check) that instead grew a different implementation based on 来源
// lines. Keeping it meant two answers to "which laws are ready" — the exact
// 规格单一真值源 failure this memory root already warns about. R24(d) is the one
// implementation; this file keeps only the gates.

/**
 * 道文件的来源法节标题 —— **写入方（模板）与读取方（R24 / 自检）共用的唯一锚**。
 *
 * ## 为什么单独抽出来（2026-11-02 真机事故）
 *
 * 读取方曾用 `body.split('## 来源法')[1]` 取节。模板把这一节写在**文件末尾**，
 * 而正文里若带一个「## 来源法逐条」小节，`split` 会**先**在它上面切断 ——
 * 于是 `[1]` 拿到的是正文那一段（里面没有链接），来源法读出 **0 条**，
 * 报出"道的依据不足"。道是自己刚萃出来的、依据齐全（7 条法），却被告知缺依据。
 *
 * 根因不是谁写错了，而是**锚不唯一**：`## 来源法` 是 `## 来源法逐条` 的前缀。
 *
 * 修法：锚必须是**整行精确匹配**，且取**最后一个**匹配（模板永远追加在末尾）。
 * 这条判据只在这里实现一次，写入方与读取方都调它 —— 避免"同一判据两处实现"。
 */
export const DAO_SOURCE_HEADING = '## 来源法';

/**
 * 取出道文件的来源法节正文。
 *
 * 只认**整行等于** `## 来源法` 的标题（`## 来源法逐条` 不匹配），
 * 并在多个匹配中取最后一个 —— 模板追加的那一节。
 *
 * @param body 道文件全文。
 * @returns 该节正文（不含标题）；没有这一节时返回空串。
 */
export function daoSourceSection(body) {
	const lines = String(body ?? '').split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].replace(/\s+$/u, '') === DAO_SOURCE_HEADING) start = i;
	}
	if (start === -1) return '';
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) end++;
	return lines.slice(start + 1, end).join('\n');
}

/**
 * 取出道文件列出的来源法 slug 列表（按出现顺序，去重）。
 *
 * @param body 道文件全文。
 * @returns 来源法 slug 数组。
 */
export function daoSourceSlugs(body) {
	const section = daoSourceSection(body);
	const slugs = [...section.matchAll(/\(\.\.\/insights\/([^)]+?)\.md\)/g)].map((m) => m[1]);
	return [...new Set(slugs)];
}

/**
 * 正文里**与模板保留节撞车**的标题（写入前自检用）。
 *
 * 判据不是"读不出来"（`daoSourceSection` 已能扛前缀撞车），而是
 * **会被静默忽略**：正文自带的 `## 来源法` 节里的链接不会被读取，
 * 作者以为登记了、系统看不到 —— 静默丢弃比报错更难查。
 *
 * @param body 待写入的用户正文（模板追加的那一节不在此列）。
 * @returns 撞车的标题行数组。
 */
export function daoReservedHeadingCollisions(body) {
	return String(body ?? '')
		.split('\n')
		.filter((line) => line.startsWith('## 来源法'))
		.map((line) => line.trim());
}
