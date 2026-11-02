/**
 * 道体结构契约测试（node 直跑，与仓库其他测试同风格）。
 *
 * 用户 2026-11-02：「不仅仅是修正结论，要完善机制才能治本。」
 *
 * 此前的「三种形态 / 推理用法 / 依据展开 / 边界」只写在 memory_dao 的
 * **参数说明文字**里 —— 代码里零实现。可测后果：一份正文塞满操作步骤的道，
 * 闸门照样放行，因为它只读命题那一句。
 *
 * 本套件钉住"道体该长什么样"，重点是**拒绝路径**：道变成操作手册、
 * 描述节夹带规范、推演退化成清单 —— 三种都要被挡。
 */
import { checkDaoBody, daoBodySections, philosophicalShape } from '../src/dao-shape.js';

let failures = 0;
function ok(cond, label) {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
}
const has = (r, code) => r.findings.some((f) => f.code === code);

/** 造一份合格的道体。 */
function goodBody() {
	return [
		'# 道 · 某道',
		'',
		'## 命题',
		'',
		'秩序与混乱在信息密度足够高时会互相转化，各自长出不同的结构。',
		'',
		'## 三种形态',
		'',
		'1. 自证：回路用自身产出证明自身。',
		'2. 外物：信息来自伪造不了的对手。',
		'',
		'## 依据展开',
		'',
		'这几条法共同指向同一件事，因此合起来才成为一条道。',
		'',
		'## 边界',
		'',
		'- 当产出者不在回路之内时，此判据不成立。',
	].join('\n');
}

console.log('\n--- 结构：必须说清"世界长什么样"与"凭什么成立" ---');
{
	const r = checkDaoBody(goodBody());
	ok(r.findings.length === 0, '合格道体 → 通过');
}
{
	const noStruct = goodBody().replace(/## 三种形态[\s\S]*?(?=## 依据展开)/, '');
	const r = checkDaoBody(noStruct);
	ok(has(r, 'dao-no-structure'), '缺描述性节 → 拒绝（只有一句命题不足以辨认）');
}
{
	const noDeriv = goodBody().replace(/## 依据展开[\s\S]*?(?=## 边界)/, '');
	const r = checkDaoBody(noDeriv);
	ok(has(r, 'dao-no-derivation'), '缺推演节 → 拒绝（读者只能信或不信）');
}

console.log('\n--- 描述节不得夹带规范（道说世界，不规定动作）---');
{
	const prescriptive = goodBody().replace(
		'1. 自证：回路用自身产出证明自身。',
		'1. 你必须先检查产出者是谁。',
	);
	const r = checkDaoBody(prescriptive);
	ok(has(r, 'dao-descriptive-prescriptive'), '描述节出现"必须" → 拒绝（越层）');
}

console.log('\n--- 推演节不能退化成逐条复述 ---');
{
	// 5 条以上列表、无任何推演连接词 = 把法各说一遍
	const listy = goodBody().replace(
		'这几条法共同指向同一件事，因此合起来才成为一条道。',
		['- 法一说了甲。', '- 法二说了乙。', '- 法三说了丙。', '- 法四说了丁。', '- 法五说了戊。'].join('\n'),
	);
	const r = checkDaoBody(listy);
	ok(has(r, 'dao-derivation-is-list'), '推演是逐条复述（无连接词）→ 拒绝');
}
{
	// 同样是列表，但有推演连接词 → 放行（列表本身不是罪，复述才是）
	const reasoned = goodBody().replace(
		'这几条法共同指向同一件事，因此合起来才成为一条道。',
		'它们都指向同一件事，所以合起来构成一条道：\n' + ['- 法一。', '- 法二。', '- 法三。', '- 法四。', '- 法五。'].join('\n'),
	);
	const r = checkDaoBody(reasoned);
	ok(!has(r, 'dao-derivation-is-list'), '列表但有推演连接词 → 放行');
}

console.log('\n--- 派生节：可以有用例，但不能只有用例 ---');
{
	const withUsage = goodBody() + '\n\n## 推理用法\n\n由此推出：先问产出者是谁。\n';
	const r = checkDaoBody(withUsage);
	ok(r.findings.length === 0, '带标注的派生节 → 通过');
}
{
	const unmarked = goodBody() + '\n\n## 推理用法\n\n先问产出者是谁，再问分母是谁。\n';
	const r = checkDaoBody(unmarked);
	ok(r.notes.some((n) => n.code === 'dao-derived-unmarked'), '派生节未标"由此推出" → 提示（不拒绝）');
}
{
	const onlyProc = ['# 道 · x', '', '## 命题', '', '某命题。', '', '## 推理用法', '', '遇到读数先问三件事。'].join('\n');
	const r = checkDaoBody(onlyProc);
	ok(has(r, 'dao-no-structure') || has(r, 'dao-only-procedure'), '只有"怎么用"没有"世界是什么" → 拒绝（那是操作手册）');
}

console.log('\n--- 分节工具 ---');
{
	const secs = daoBodySections(goodBody());
	ok(secs.length === 4, `daoBodySections 切出 4 节：命题/三种形态/依据展开/边界（实际 ${secs.length}）`);
	ok(secs.some((s) => s.heading.includes('三种形态')), '节标题正确保留');
}



// ---------------------------------------------------------------------------
// 2026-11-02 用户：「道，要包含哲学的韵味。」
// 范例：智慧是自组织的秩序 / 对立和矛盾在某种条件下可以同时存在，不是判断正误，
// 而是都能演化出不同的结果。
//
// 判据用**用户的范例本身**校准过三版：四件全齐会判死范例1，生成性必需仍会判死它，
// 最终定为「生成性 或 对立 任一在场」——这两者才是哲学命题与工程结论的分水岭。
// ---------------------------------------------------------------------------
console.log('\n--- 哲学韵味：用户的两个范例都必须通过 ---');
{
	ok(philosophicalShape('智慧是自组织的秩序').ok, '范例1「智慧是自组织的秩序」→ 通过（只有生成性也算）');
	ok(
		philosophicalShape('对立和矛盾在某种条件下是可以同时存在的，不是判断正误，而是都能演化和推理出有不同的结果').ok,
		'范例2「对立与矛盾共存」→ 通过（四件俱全）',
	);
	ok(philosophicalShape('秩序与混乱是一体两面').ok, '只有对立 → 通过（对立也是分水岭之一）');
}
{
	ok(!philosophicalShape('所有系统最终都会腐烂').ok, '静态断言「所有系统最终都会腐烂」→ 拒绝（无生成性、无对立）');
	ok(
		!philosophicalShape('裁判长在回路之内，它出具的报告就必然偏向回路，本身不携带信息').ok,
		'工程式命题（缺陷+必然结论）→ 拒绝',
	);
}
{
	const prop = philosophicalShape('智慧是自组织的秩序');
	ok(prop.missing.includes('tension'), '缺什么要逐项报出来（范例1 缺对立）');
	ok(prop.missing.includes('refusesVerdict'), '范例1 也缺拒绝裁判');
}


{
	// 走完整 checkDaoBody：静态命题必须被**闸门**拦住，而不只是纯函数返回 false。
	// 变异测试暴露过这个缺口：只测 philosophicalShape 时，把闸门那段删掉测试仍全绿。
	const staticBody = goodBody().replace(
		'秩序与混乱在信息密度足够高时会互相转化，各自长出不同的结构。',
		'所有系统最终都会腐烂。',
	);
	const r = checkDaoBody(staticBody);
	ok(has(r, 'dao-not-philosophical'), '静态命题经 checkDaoBody → 判 dao-not-philosophical（闸门链路生效）');
}

console.log(failures === 0 ? '\ndao-shape: ALL PASS' : `\ndao-shape: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);