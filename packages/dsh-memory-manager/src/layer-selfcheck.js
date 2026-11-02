/**
 * 层级自检 —— **萃取/结晶落盘后，立刻拿它对照该层自己的定义**。
 *
 * ## 为什么需要这一步（2026-11-02 用户要求）
 *
 * 用户原话：「每次蒸馏后，要检验蒸馏的结果是否符合它对应层级的定义，
 * 不符合就不要出随意结果。」
 *
 * 触发它的现场事故：`memory_dao` 回执说"道已沉淀"，而体检的 R24 读出
 * **0 条来源法**、报"道的依据不足"。两边都"没错"：写入方按模板写、模板
 * 追加的节在文件里；读取方的锚被正文撞了前缀。**写入方报的是"我写了"，
 * 不是"写出来的东西符合道的定义"** —— 这就是"随意结果"。
 *
 * ## 这一层与三件事的分工
 *
 * - `layer-gate.js` 管**准入**：写入*前*，输入的形状对不对（缺 5 条法就拒绝写）。
 * - 本模块管**落地**：写入*后*，**从磁盘读回来的产物**是否符合该层定义。
 * - `memory_check`（R14/R24 等）管**体检**：整个记忆根的长期健康，事后发现。
 *
 * 三者判据同源（都调 layer-gate 的纯函数），但**时机与对象不同**：
 * 准入看输入、自检看产物、体检看全局。只做准入会漏"写进去的东西读不出来"
 * 这一类；只做体检则要等到下一次体检，中间这段时间账是假的。
 *
 * ## 判据必须自外而内
 *
 * 自检**不采信写入方的内存中间态**，一律 `readFile` 回来的字节：
 * 能读出来才算数 —— 与 R24 读的是同一份字节、同一套锚。这正是
 * 「绿灯不携带信息」在工具层的落地：写者不能给自己的产物背书。
 *
 * 纯函数：输入 `{ layer, content, relPath }`，输出 `{ ok, layer, findings }`。
 * 不碰文件系统（读字节由调用方做），所以可穷举测试。
 */

import { concreteMarkersOf, looksLikeProcedure, daoSourceSlugs, MIN_DAO_SOURCES, MIN_FA_SOURCES } from './layer-gate.js';
import { checkDaoBody } from './dao-shape.js';

/** 各层定义里的硬阈值（与体检 R14 同源，改一处要同时改体检）。 */
export const BLOCK_MAX_CHARS = 900;
export const SUMMARY_MAX_CHARS = 110;

/**
 * 层名（与记忆根目录一一对应）。
 *
 * - `术` = functions/ 迭代块：一个域"怎么做"的完整迭代史
 * - `法` = insights/ 跨域可重套原则（单源降级为「专项」，不算失败）
 * - `道` = dao/ 最抽象命题，≥5 条法萃取
 * - `器` = capabilities/ 外部能力台账（怎么调用、前提、踩过的坑）
 * - `技能` = skills/<name>/SKILL.md 可调用程序（宿主目录包）
 */
export const LAYERS = ['术', '法', '道', '器', '技能'];

/** 迭代块的必需小节（缺哪一项，这个块就说不清"发生了什么"）。 */
const BLOCK_KEYS = ['概括', '改动', '原因', '验证', '结果'];

/**
 * 把文本切成迭代块（`## [YYYY-MM-DD...]` 开头的节）。
 *
 * @param text 功能域文件全文。
 * @returns `{ heading, body }[]`。
 */
export function splitBlocks(text) {
	const lines = String(text ?? '').split('\n');
	const blocks = [];
	let current = null;
	for (const line of lines) {
		if (/^##\s+\[?\d{4}-\d{2}-\d{2}/u.test(line)) {
			current = { heading: line.replace(/^#+\s*/u, '').trim(), body: [] };
			blocks.push(current);
			continue;
		}
		if (current !== null) current.body.push(line);
	}
	return blocks.map((b) => ({ heading: b.heading, body: b.body.join('\n').trim() }));
}

/**
 * 各层**必须声明边界**的节名（含同义写法）。
 *
 * ## 为什么边界是硬条件（2026-11-02 用户指出）
 *
 * 上一版自检只验结构（该有的节在不在、长度合不合规），于是出现一个荒唐的
 * 通过：道文件有命题、有 7 条来源法，**却一个字没说它何时不成立** —— 自检
 * 照样报 ✓。而层级的定义里，边界是区分"法"与"口号"的那条线：
 *
 * - 没有边界的法，会被跨域套用到它根本不成立的地方（本机真实代价：
 *   「闸门只证没坏」被套到不需要闸门的场景，判据空转）
 * - 没有边界的道，就是一句漂亮话 —— 而道层的判据恰恰是"换领域依然成立"，
 *   说不出"哪里不成立"就证明它没被真正想清楚
 *
 * 所以：**边界缺失 = 不合格**，与"缺命题"同级。同义标题都认（`适用面` 是
 * 模板里的写法，`边界` 是更直白的写法），但必须**有内容**、且不能只写
 * 一句"视情况而定"这种不可执行的话。
 */
const BOUNDARY_HEADINGS = ['适用面', '边界', '局限', '不适用'];

/** 边界节的正文最少字数（低于这个数基本是敷衍）。 */
const BOUNDARY_MIN_CHARS = 20;

/**
 * 取某层文件的边界节正文（第一个命中的同义标题）。
 *
 * @param content 文件全文。
 * @returns 边界节正文；没有该节时返回空串。
 */
export function boundarySectionOf(content) {
	const lines = String(content ?? '').split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+/u.test(lines[i]) && BOUNDARY_HEADINGS.some((h) => lines[i].includes(h))) {
			start = i;
			break;
		}
	}
	if (start === -1) return '';
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) end++;
	return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * 检查边界节是否合格：存在、非空、够具体、**说了"何时不成立"**。
 *
 * ## 为什么"存在"不够（2026-11-02 真机打回）
 *
 * 写入工具会自动补一个 `## 适用面` 标题，于是"有没有边界节"这条判据被
 * 模板架空了 —— 探针文件一字未写边界，自检照样 ✓。
 *
 * 所以真正的判据是**内容形态**：边界节必须包含"不成立/失效/不适用"这类
 * 反面表述。只写"适用于哪些场景"是适用范围（正向），不是边界（负向）；
 * 说不出反面，就等于说不出这条法在哪里会骗人。
 *
 * 判据顺序决定用户拿到哪条修法，所以顺序本身是判据的一部分：
 * 空话 → 过短 → 无反面，三者报的修法完全不同。
 *
 * @param content 文件全文。
 * @param layer 层名（只用于措辞）。
 * @returns 不合格时的 `{ code, message }`；合格时 undefined。
 */
export function boundaryDefect(content, layer) {
	const body = boundarySectionOf(content);
	if (!body) {
		return {
			code: 'no-boundary',
			message: `缺边界节（「## 适用面」或「## 边界」）：说不出"何时不适用"，${layer}就只是一句口号——它会被套到根本不成立的地方`,
		};
	}
	// 空话先判：`- 视情况而定` 只有 7 字，若先判长度会被报成"过短"，
	// 那是在说"多写点字"，而真正的问题是这句话无法被反驳。
	const stripped = body.replace(/^[\s\-*•]+/gmu, '').replace(/[\s。．.！!]+/gu, '');
	if (/^(视情况而定|具体问题具体分析|看情况|不一定|视具体场景而定)$/u.test(stripped)) {
		return {
			code: 'boundary-vacuous',
			message: '边界节是空话（"视情况而定"）：无法被任何反例推翻的话不携带信息，写清"哪种情况下不成立"',
		};
	}
	if ([...body].length < BOUNDARY_MIN_CHARS) {
		return {
			code: 'boundary-thin',
			message: `边界节只有 ${[...body].length} 字：至少要写清"适用于哪类场景"与"哪种情况下不成立"`,
		};
	}
	// 反面表述：边界必须是**负向**的。模板会自动补标题，只有内容能证明作者
	// 真的想过"哪里不成立"。没有反面词 → 那只是适用范围，不是边界。
	const hasNegative =
		/(不成立|失效|不适用|无效|会骗|误导|反而更糟|不能|不该|不覆盖|例外|反例|陷阱)/u.test(body);
	if (!hasNegative) {
		return {
			code: 'boundary-one-sided',
			message:
				'边界节只写了"适用于哪些场景"，没写"哪种情况下不成立"：正向适用范围不等于边界——' +
				'说不出反面，这条' + layer + '就会被套到它根本不成立的地方',
		};
	}
	return undefined;
}

/**
 * 检查一件刚落盘的产物是否符合它所在层的定义。
 *
 * @param input.layer 层名（`术`/`法`/`道`/`器`/`技能`）。
 * @param input.content 从磁盘读回的全文。
 * @param input.relPath 相对记忆根的路径（只用于报错定位）。
 * @returns `{ ok, layer, findings, notes }`；findings 每项 `{ code, message }`。
 */
export function checkArtifact(input) {
	const layer = String(input.layer ?? '');
	const content = String(input.content ?? '');
	const relPath = String(input.relPath ?? '');
	const findings = [];
	const notes = [];
	const fail = (code, message) => findings.push({ code, message });
	const note = (code, message) => notes.push({ code, message });

	if (!content.trim()) fail('empty', `${relPath} 读回来是空的：落盘失败或路径不对`);

	if (layer === '术') {
		if (!/^##\s*当前状态摘要/mu.test(content)) {
			fail('head-summary', '缺「## 当前状态摘要」：没有它，文件头部说不清现在稳定在什么行为');
		}
		const blocks = splitBlocks(content);
		if (!blocks.length) fail('no-block', '没有任何迭代块（`## [YYYY-MM-DD]`）：功能域文件靠块记录"发生了什么"');
		for (const b of blocks) {
			if ([...b.body].length > BLOCK_MAX_CHARS) {
				fail('block-overlong', `块「${b.heading.slice(0, 24)}」${[...b.body].length} 字 > ${BLOCK_MAX_CHARS}：那是过程不是结论，压成动因/改动/判据/待观察`);
			}
			for (const key of BLOCK_KEYS) {
				if (!b.body.includes(`**${key}**`)) {
					// **不算失败**：`memory_write` 的 API 里 reason/change/verification
					// 是可选的，体检 R14 也只强制长度与概括。把"缺小节"升级成硬失败
					// 会造出比体检更严的第二套判据（同一件事两处实现 —— 这个记忆根
					// 反复吃亏的形态）。如实提示，让人自己决定补不补。
					note('block-incomplete', `块「${b.heading.slice(0, 24)}」缺 **${key}** —— 块要说清动因/改动/原因/验证/结果`);
					break;
				}
			}
			const summary = b.body.match(/\*\*概括\*\*[：:]\s*([^\n]+)/u)?.[1] ?? '';
			if (summary && [...summary].length > SUMMARY_MAX_CHARS) {
				fail('summary-overlong', `块「${b.heading.slice(0, 24)}」概括 ${[...summary].length} 字 > ${SUMMARY_MAX_CHARS}：概括是索引行的原料，超了会被体检打回`);
			}
		}
	}

	if (layer === '法') {
		const srcLine = content.match(/^>\s*来源[：:].*$/mu)?.[0] ?? '';
		if (!srcLine) {
			fail('no-source', '缺「> 来源：」行：回链是这条法唯一的证据，没有它降不成法');
		} else {
			// 计数必须**按来源域去重**：真实的 `> 来源：` 行里同一个域出现两次
			// （链接标签 + href），按出现次数会算成 2 个来源 —— 单源的专项会被
			// 误判成法。判据落在 slug 集合上，与 R24(d) 的认领统计同一口径。
			const slugs = [...srcLine.matchAll(/(?:\.\.\/)?functions\/([^/()\s、]+?)\.md/g)].map((m) => m[1]);
			const count = new Set(slugs).size;
			if (count === 0) fail('no-source-link', '「> 来源：」行里没有任何 functions/*.md 回链');
			else if (count < MIN_FA_SOURCES) {
				// 单源**不失败**：它落在「专项」是定义允许的落点。但要说清它
				// 不是普适原则 —— 否则下一步就会有人拿它去萃道、跨域引用。
				note('downgraded-special', `只有 ${count} 个来源域 → 它是「专项」不是「法」：不要跨域引用，也不得作为道的萃取来源`);
			}
		}
		const principle = content.match(/^##\s*核心原则\s*\n+\s*[-*]\s*([^\n]+)/mu)?.[1] ?? '';
		if (!principle) fail('no-principle', '缺「## 核心原则」的正文本体：只有标题没有内容等于没写');
		else if (looksLikeProcedure(principle)) {
			fail('principle-is-procedure', '核心原则是操作手册句式：能改写成步骤的是术，不是法');
		}
		// 边界是法层的**定义条件**，不是加分项：说不出"何时不成立"，
		// 这条法就会被套到它根本不成立的地方（本机真实代价见 BOUNDARY_HEADINGS 注释）。
		const bd = boundaryDefect(content, '法');
		if (bd) fail(bd.code, bd.message);
	}

	if (layer === '道') {
		const proposition = content.match(/##\s*命题\s*\n+\s*\n?([^\n]+)/u)?.[1] ?? '';
		if (!proposition) fail('no-proposition', '缺「## 命题」正文：道必须能用一句话说出来');
		else {
			const markers = concreteMarkersOf(proposition);
			if (markers.length) {
				fail('concrete-in-proposition', `命题含具体标记（${markers.slice(0, 3).join('、')}）：那是法伪装成道，换领域后应依然成立`);
			}
		}
		const slugs = daoSourceSlugs(content);
		if (slugs.length < MIN_DAO_SOURCES) {
			fail('source-section-unreadable', `来源法节读出 ${slugs.length} 条（< ${MIN_DAO_SOURCES}）：要么真缺依据，要么节标题被正文撞了前缀导致读不到`);
		}
		// 道层的边界比法层更硬：道的判据是"换领域依然成立"，说不出
		// "哪里不成立"就证明它没被想清楚 —— 那不是道，是一句漂亮话。
		const daoBd = boundaryDefect(content, '道');
		if (daoBd) fail(daoBd.code, daoBd.message);
		// 道体结构：命题之外还得说清"世界长什么样"与"这几条法如何共同逼出它"。
		// 此前这两节只写在参数说明文字里、代码零实现，于是正文塞满操作步骤也放行。
		const shape = checkDaoBody(content);
		for (const x of shape.findings) fail(x.code, x.message);
		for (const x of shape.notes) note(x.code, x.message);
	}

	if (layer === '器') {
		if (!/^##\s*调用方式/mu.test(content)) {
			fail('no-invocation', '缺「## 调用方式」：台账的价值就是下次不必重新摸索，没有它这份记录没用');
		} else {
			const section = content.split(/^##\s*调用方式/mu)[1] ?? '';
			if (!/^\s*[-*]\s*\S/mu.test(section)) fail('empty-invocation', '「## 调用方式」下没有任何条目');
		}
		// 器的定义是"确切调用 + 前提 + 踩过的坑"三件（见 memory_capability 的
		// description）。只查调用方式，等于只验了三件里的一件——而"前提"与"坑"
		// 恰恰是下次能省下摸索的那部分。缺了它们，这份台账就退化成命令清单。
		//
		// ⚠️ 标题匹配要容忍实际写法：`## 前提 / 环境` 带空格与斜杠，
		// 用 `^##\s*前提` 这种前缀锚会漏（实测踩过）。
		const sectionOf = (prefixes) => {
			const lines = content.split('\n');
			let start = -1;
			for (let i = 0; i < lines.length; i++) {
				if (/^##\s+/u.test(lines[i]) && prefixes.some((p) => lines[i].includes(p))) {
					start = i;
					break;
				}
			}
			if (start === -1) return '';
			let end = start + 1;
			while (end < lines.length && !lines[end].startsWith('## ')) end++;
			return lines.slice(start + 1, end).join('\n').trim();
		};
		if (!sectionOf(['前提', '环境', 'prereq', 'Prereq'])) {
			note(
				'no-prereq',
				'缺「## 前提 / 环境」：调用前要什么（路径、token、版本、启动方式）没写，下次还得重新摸索',
			);
		}
		if (!sectionOf(['解决过什么', '解决过', 'solved', 'Solved'])) {
			note('no-solved', '缺「## 解决过什么」：没有"用它干成过什么"，就判断不出这份台账值不值得信');
		}
	}

	if (layer === '技能') {
		const fm = content.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
		if (!fm) fail('no-frontmatter', '缺 YAML frontmatter：宿主技能靠它登记（name/description/status）');
		else {
			const name = fm.match(/^name:\s*(.+)$/mu)?.[1]?.trim() ?? '';
			if (!name) fail('no-name', 'frontmatter 缺 name');
			else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
				fail('name-not-kebab', `name「${name}」不是 kebab-case：它同时是宿主目录名`);
			}
			const desc = fm.match(/^description:\s*(.+)$/mu)?.[1]?.trim() ?? '';
			if (!desc) fail('no-description', 'frontmatter 缺 description：触发词就写在它里面');
			else if (desc.split(/\s+/u).length > 80) {
				fail('description-overlong', `description ${desc.split(/\s+/u).length} 词 > 80：过长会被截断，触发词会失效`);
			}
			if (!/^status:\s*(candidate|active|retired)\s*$/mu.test(fm)) {
				fail('no-status', 'frontmatter 的 status 缺失或不是 candidate|active|retired');
			}
		}
		// 技能的定义是"可调用程序"：何时用 + 步骤 + 坑 + 验证。frontmatter 只是
		// 登记信息，**正文里没有步骤**的技能根本没法被"照做"——它只是一个名字。
		//
		// ⚠️ 不能用 `\b`：中文与标点之间没有词边界，`## 步骤\b` 永远不匹配（实测踩过）。
		const hasHeading = (names) =>
			content.split('\n').some((l) => /^##\s+/u.test(l) && names.some((n) => l.includes(n)));
		if (!hasHeading(['Procedure', '步骤', '做法', 'Steps'])) {
			fail(
				'no-procedure',
				'缺步骤节（「## Procedure」/「## 步骤」）：技能是可调用程序，没有步骤它就不是技能，只是一段说明',
			);
		}
		if (!hasHeading(['Verification', '验证', '检查'])) {
			fail(
				'no-verification',
				'缺验证节（「## Verification」/「## 验证」）：说不出"怎么算做成了"，下次无法判断该不该信它',
			);
		}
	}

	return { ok: findings.length === 0, layer, relPath, findings, notes };
}

/**
 * 把自检结果压成一行给工具回执用（合格时说一句，不合格时点名缺什么）。
 *
 * @param result `checkArtifact` 的返回。
 * @returns 单行文本。
 */
export function selfCheckLine(result) {
	if (result.ok) {
		const head = result.notes?.[0];
		return head ? `${result.layer}层自检通过（${head.message}）` : `${result.layer}层自检通过`;
	}
	const first = result.findings[0];
	return `${result.layer}层自检**未过**：${first.message}` + (result.findings.length > 1 ? `（另有 ${result.findings.length - 1} 项）` : '');
}

/**
 * 自检结果 → 可直接并进工具 `warnings` 的字符串数组。
 *
 * 未过 → 以 ⛔ 开头（**不许当成功**）；通过但有提示（如"这条其实只是专项"）→ ℹ。
 * 单列这个函数是为了让五个写入工具的接法完全一致 —— 免得某一层漏推提示，
 * 那层就又变回"报了绿灯但没说清落在哪一层"。
 *
 * @param result `checkArtifact` 的返回。
 * @returns 告警字符串数组（可能为空）。
 */
export function selfCheckWarnings(result) {
	// 只把**未过**抬成告警。通过但有提示（"这条其实只是专项""块缺某一节"）留在
	// 结构化的 `selfCheck.notes` 里 —— 工具的 warnings 有一条既有契约：
	// 形状合法的成功写入不产生告警（harness-test 断言 no warnings）。
	// 让可选字段的提示去污染那条契约，等于把"正常"和"有瑕疵"again 混成一个信号。
	if (result.ok) return [];
	return [`⛔ ${selfCheckLine(result)} —— 已落盘但不符合${result.layer}层定义，请按上面点名的项修正后重写（不要当它已经可用）`];
}