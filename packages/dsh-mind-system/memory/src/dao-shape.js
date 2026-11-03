/**
 * 道体的**结构契约** —— 道文件正文该由哪些节组成，每节是什么性质。
 *
 * ## 为什么需要它（2026-11-02 用户："不仅仅是修正结论，要完善机制才能治本"）
 *
 * 此前「三种形态 / 推理用法 / 依据展开 / 边界」只写在 `memory_dao` 的
 * **参数说明文字**里 —— 代码里零实现。后果可测：
 *
 * ```
 * 命题（道）      —— 世界是怎样的        ✅ 闸门检查
 * 三种形态（道）  —— 世界的结构分类      ❌ 无人检查
 * 推理用法（法/术）—— 遇到 X 先问 Y      ❌ 无人检查（且越层）
 * 依据展开（法）  —— 各条法说了什么      ❌ 无人检查（且退化成清单）
 * 边界（道）      —— 何时不成立          ✅ 新加
 * ```
 *
 * 于是一份"正文里塞满操作步骤"的道，闸门照样放行 —— 因为它只读命题那一句。
 * 写进文档的约束等于没有约束（本模块文件头早就写过这句，这次轮到道体）。
 *
 * ## 契约
 *
 * 道体**必须**含这几节，且性质各异：
 *
 * | 节 | 性质 | 判据 |
 * |---|---|---|
 * | 命题 | 描述 | 无具体标记、非操作手册（已有） |
 * | 三种形态 / 结构 | 描述 | 不得出现规范性动词 |
 * | 依据展开 | 推演 | 必须真的**推演**（多个法如何共同逼出命题），不是逐条复述 |
 * | 边界 | 描述（负向） | 必须有反面（已有） |
 *
 * **允许**一节"如何用它"（`推理用法`/`怎么用`），但它必须：
 * ① 明确标为派生（"由此推出"之类），② 不得是唯一内容 —— 道不能只剩操作指南。
 *
 * ## 与共识区的分工
 *
 * 道描述世界；"必须怎么做"属于 MEMORY.md 共识区。所以正文里的规范性动词
 * 只允许出现在**标注为派生**的那一节，其余节出现即判越层。
 *
 * @module src/dao-shape
 */

/** 描述性节（世界是怎样的）—— 不得有规范性动词。 */
export const DESCRIPTIVE_HEADINGS = ['三种形态', '结构', '形态', '表现', '机制'];

/** 推演节 —— 必须真的在推演，不是复述。 */
export const DERIVATION_HEADINGS = ['依据展开', '推演', '为什么成立', '论证'];

/** 派生节（允许有规范性动词，但必须标为派生）—— 不是道的本体。 */
export const DERIVED_HEADINGS = ['推理用法', '怎么用', '使用方式', '推论'];

/** 规范性动词（出现即说明这段在说"该怎么做"）。 */
const NORMATIVE = /(必须|应当|应该|禁止|不得|务必|只允许|先问|先做|由此推出|需要你|请)/gu;

/** 派生标记（说明这一节是从道推出来的，不是道本身）。 */
const DERIVED_MARK = /(由此推出|据此|于是|所以|可用于|用来|应用时)/u;

// ---------------------------------------------------------------------------
// 哲学韵味（2026-11-02 用户要求）
//
// 用户原话：「道，要包含哲学的韵味。比如：智慧是自组织的秩序。对立和矛盾在
// 某种条件下是可以同时存在的，不是判断正误，而是都能演化和推理出有不同的结果。」
//
// ## 这不是文采要求，是**形态要求**
//
// 把范例拆开看，它有四个结构件，缺一不可：
//
//   1. 承认一个**对立/张力**（两极同时在场）
//   2. 给出**共存条件**（在什么条件下它们能同时成立）
//   3. **拒绝裁判**（不是判断哪个对，而是两者都能推演出各自的结果）
//   4. 承认**生成性**（能演化出不同的东西，不是静态属性）
//
// 对照一条"好的工程原则"：「自产信号不携带信息」——它有精确性、有判据，
// 但它是**一个缺陷 + 一个必然结论**：没有条件（"必然"）、有裁判（判了零信息）、
// 没有生成性（静态）。这就是"工程正确但没有哲学韵味"的准确差别。
//
// ## 为什么判据要能同时说"缺哪个"
//
// 只报"没有哲学韵味"等于什么都没说。四件分开报，写的人才知道该补对立、
// 补条件、还是去掉那个绝对判断。
// ---------------------------------------------------------------------------

/** 对立/张力：两极同时在场。 */
const TENSION = /(对立|矛盾|悖论|张力|两极|一体两面|同时存在|并存|共存|互为|彼此(塑造|定义|生成)|既是.{0,12}又是|一方面.{0,30}另一方面)/u;

/** 共存条件：在什么条件下两者能同时成立。 */
const COEXIST_CONDITION = /(在.{0,20}?(条件|前提|情况|场景|语境|关系|尺度|层次)下|当.{1,30}?时|一旦.{1,30}?(就|便|则)|只要.{1,30}?就|若.{1,30}?(则|就)|只有.{1,30}?才|越.{1,10}?越)/u;

/** 拒绝裁判：不判正误，而是各自成立。 */
const REFUSES_VERDICT = /(不是(判断|区分|分出)?(正误|对错|真伪|好坏|优劣)|无所谓(正误|对错)|两者都(能|可以|成立)|各自(成立|有效|推演)|都(能|可以)(演化|推演|推出|得到)|而非(判断|区分)|不必(判断|分出))/u;

/** 生成性：能演化出不同的结果。 */
const GENERATIVE = /(演化|演进|转化|生成|推演|推导|涌现|自组织|长成|分化|分岔|生出|迭代|自我(生成|组织|强化)|长出新)/u;

/**
 * 检查命题是否具备"哲学韵味"的四个结构件。
 *
 * ## 判据不是"四件全齐"（2026-11-02 用真实范例校准）
 *
 * 用户给的两个范例本身就是**两种不同形态**：
 *
 * ```
 * 智慧是自组织的秩序                                    → 只有「生成」
 * 对立和矛盾在某种条件下…不是判断正误，而是都能演化出…   → 四件俱全
 * ```
 *
 * 若要求四件全齐，第一条（用户的范例！）会被自己的判据判死。所以真实判据是：
 *
 * - **生成性必居其一**：静态属性是工程结论，有"能长成什么"才是哲学命题
 * - 另有**至少一项**：对立 / 条件 / 拒绝裁判 —— 它给出张力或方向
 *
 * 即 `generative && (tension || condition || refusesVerdict)`。这条既能挡住
 * "一个缺陷 + 一个必然结论"那种工程式命题，又不把道逼成单一模子。
 *
 * @param proposition 命题正文。
 * @returns `{ missing, has, ok }`。
 */
export function philosophicalShape(proposition) {
	const text = String(proposition ?? '');
	const parts = {
		tension: TENSION.test(text),
		condition: COEXIST_CONDITION.test(text),
		refusesVerdict: REFUSES_VERDICT.test(text),
		generative: GENERATIVE.test(text),
	};
	const missing = Object.entries(parts)
		.filter(([, ok]) => !ok)
		.map(([k]) => k);
	const has = Object.keys(parts).filter((k) => parts[k]);
	// 形态判定（用真实范例校准过两次）：
	//
	//   第 1 版「四件全齐」→ 判死用户的范例1（"智慧是自组织的秩序"只有生成性）
	//   第 2 版「生成性必需」→ 仍判死范例1（它没有对立/条件/拒判）
	//   第 3 版（当前）：**生成性 或 对立 任一在场即可**，因为这两者才是
	//   "哲学命题"与"工程结论"的分水岭 ——
	//
	//   · 有生成性：命题指向"能长成什么"，不是静态属性
	//   · 有对立：命题承认两极同时在场，不是单指一个缺陷
	//
	//   而"条件/拒绝裁判"是**加分的完整度**，不是必要条件：范例1 没有它们
	//   依然是公认的哲学命题。把它们设成必需，等于用判据否定范例本身。
	//
	//   被挡住的正是"一个缺陷 + 一个必然结论"那种工程式命题（四件全无）。
	const ok = parts.generative || parts.tension;
	return { missing, has, ok };
}

/** 结构件的中文名与修法提示（报错时用，让作者知道补什么）。 */
const PART_HINTS = {
	tension: '缺少**对立/张力**：道要承认两极同时在场（如"既是……又是……""一方面……另一方面"），而不是单指一个缺陷',
	condition: '缺少**共存条件**：要说出"在什么条件下两者能同时成立"——没有条件的"必然"是绝对判断，不是道',
	refusesVerdict: '缺少**拒绝裁判**：道不判哪个对，而是两者都能推演出各自的结果（如"不是判断正误，而是……"）',
	generative: '缺少**生成性**：道要能演化出不同的东西（如"都能演化/推演出……"），静态属性是工程结论不是道',
};

/**
 * 把道文件正文切成节。
 *
 * @param content 道文件全文。
 * @returns `{ heading, body }[]`（不含标题行本身）。
 */
export function daoBodySections(content) {
	const lines = String(content ?? '').split('\n');
	const sections = [];
	let current = null;
	for (const line of lines) {
		if (/^##\s+/u.test(line)) {
			current = { heading: line.replace(/^#+\s*/u, '').trim(), body: [] };
			sections.push(current);
			continue;
		}
		if (current !== null) current.body.push(line);
	}
	return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

/**
 * 检查道体结构是否符合"道"的定义。
 *
 * @param content 道文件全文。
 * @returns `{ findings, notes }`；findings 为 `{ code, message }`。
 */
export function checkDaoBody(content) {
	const findings = [];
	const notes = [];
	const fail = (code, message) => findings.push({ code, message });
	const note = (code, message) => notes.push({ code, message });

	const sections = daoBodySections(content);
	const byKind = (headings) => sections.filter((s) => headings.some((h) => s.heading.includes(h)));

	// —— 0. 命题的哲学形态（2026-11-02 用户："道要包含哲学的韵味"）——
	//
	// 判据分两档，因为"韵味"不该一刀切：
	//   全缺 → 它不是道，是工程结论（硬失败）
	//   缺一部分 → 指出缺哪件（提示，可执行）
	// 这样既守住形态，又不逼着每条道都写成同一个模子。
	const proposition = (sections.find((s) => s.heading.includes('命题'))?.body ?? '').trim();
	if (proposition) {
		const shape = philosophicalShape(proposition);
		if (!shape.ok) {
			fail(
				'dao-not-philosophical',
				'命题缺少哲学形态：' +
					(shape.has.length === 0
						? '四件全缺——它是一条工程结论，不是道。'
						: `已具备 ${shape.has.join('/')}，但` +
							(shape.missing.includes('generative')
								? '缺**生成性**（能演化出什么）——静态属性是工程结论'
								: '缺**对立/条件/拒绝裁判**中至少一项——它给出的是张力或方向')) +
					'。四件含义：' +
					[PART_HINTS.tension, PART_HINTS.condition, PART_HINTS.refusesVerdict, PART_HINTS.generative].join('；'),
			);
		} else if (shape.missing.length > 0) {
			note(
				'dao-philosophy-thin',
				`命题具备 ${shape.has.join('/')}；若要更完整可补：${shape.missing.map((k) => PART_HINTS[k]).join('；')}`,
			);
		}
	}

	// —— 1. 必须有描述性节：道要描述世界的结构，不能只有命题一句 ——
	const descriptive = byKind(DESCRIPTIVE_HEADINGS);
	if (descriptive.length === 0) {
		fail(
			'dao-no-structure',
			'缺描述性节（如「## 三种形态」）：道要说清"世界长什么样"，只有一句命题不足以让人照着辨认',
		);
	}
	// 描述性节不得夹带规范
	for (const s of descriptive) {
		const hits = [...s.body.matchAll(NORMATIVE)].map((m) => m[1]);
		if (hits.length > 0) {
			fail(
				'dao-descriptive-prescriptive',
				`「${s.heading}」是描述性节，却出现规范性动词（${[...new Set(hits)].join('、')}）：` +
					'道描述世界，不规定动作 —— 该怎么做属共识区或法层',
			);
		}
	}

	// —— 2. 必须有推演节，且不能是"逐条复述" ——
	const derivation = byKind(DERIVATION_HEADINGS);
	if (derivation.length === 0) {
		fail(
			'dao-no-derivation',
			'缺推演节（如「## 依据展开」）：道要说明"这几条法如何共同逼出这个命题"，否则读者只能信或不信',
		);
	}
	for (const s of derivation) {
		const items = s.body.split('\n').filter((l) => l.trim().startsWith('-') || l.trim().startsWith('*'));
		// 逐条复述的特征：条目数 == 来源法数，且每条只说了单条法
		const looksLikeList = items.length >= 5 && !DERIVED_MARK.test(s.body) && !/(共同|都指向|合起来|同构|因此|所以)/u.test(s.body);
		if (looksLikeList) {
			fail(
				'dao-derivation-is-list',
				`「${s.heading}」看起来是**逐条复述**（${items.length} 条列表，无推演连接词）：` +
					'推演要说明这些法如何**共同**指向命题，不是把它们各说一遍',
			);
		}
	}

	// —— 3. 派生节可以有，但必须标为派生 ——
	const derived = byKind(DERIVED_HEADINGS);
	for (const s of derived) {
		if (!DERIVED_MARK.test(s.body)) {
			note(
				'dao-derived-unmarked',
				`「${s.heading}」是派生用法，建议明确写成"由此推出……"：让人分得清哪句是道、哪句是从道推出来的`,
			);
		}
	}
	// 只剩派生节、没有描述节 —— 已在 1 拦住；这里补一条更强的：道不能全是操作
	if (derived.length > 0 && descriptive.length === 0 && derivation.length === 0) {
		fail(
			'dao-only-procedure',
			'道文件只有"怎么用"，没有"世界是怎样的"：那是操作手册，不是道',
		);
	}

	return { findings, notes };
}