/**
 * 覆盖度审查测试（2026-11-02）。
 *
 * 用户：「继续完善，其他层级也同样审查。」
 *
 * 审查发现的不是"文案不同步"，而是**定义要求的核心内容，判据没查**：
 *
 * | 层 | 定义要求 | 旧判据 |
 * |---|---|---|
 * | 器 | 确切调用 + 前提 + 踩过的坑 | 只查调用方式 |
 * | 技能 | 何时用 + **步骤** + 坑 + **验证** | 只查 frontmatter |
 * | 法 | ≥2 个**无关**来源域 | 只数个数，不判无关 |
 *
 * 这三条都是"声明了却从未实现"，比写错更隐蔽：判据存在、测试全绿、
 * 而定义里最核心的部分从来没被检查过。
 */
import { checkArtifact } from '../src/layer-selfcheck.js';
import { gateFa, unrelatedSources } from '../src/layer-gate.js';

let failures = 0;
function ok(cond, label) {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
}
const has = (r, code) => r.findings.some((f) => f.code === code);
const noteHas = (r, code) => r.notes.some((n) => n.code === code);

// ---------------------------------------------------------------------------
console.log('\n--- 器层：定义要三件（调用 + 前提 + 坑），不是一件 ---');
{
	const full = '# 某工具\n\n## 调用方式\n\n- `tool --flag`\n\n## 前提 / 环境\n\n- 需要 X 环境\n\n## 解决过什么\n\n- 解决过 Y\n';
	const r = checkArtifact({ layer: '器', content: full, relPath: 'capabilities/x.md' });
	ok(r.ok && r.notes.length === 0, '三件齐全 → 通过且无提示');
}
{
	const onlyInvocation = '# 某工具\n\n## 调用方式\n\n- `tool --flag`\n';
	const r = checkArtifact({ layer: '器', content: onlyInvocation, relPath: 'capabilities/x.md' });
	ok(r.ok, '只有调用方式 → **不失败**（它们是提示，不是硬闸门）');
	ok(noteHas(r, 'no-prereq'), '  但提示缺「前提 / 环境」');
	ok(noteHas(r, 'no-solved'), '  也提示缺「解决过什么」');
}

// ---------------------------------------------------------------------------
console.log('\n--- 技能层：frontmatter 只是登记，正文没步骤就不是技能 ---');
{
	const noProcedure = '---\nname: some-skill\ndescription: Does a thing.\nstatus: active\n---\n\n# body\n\n## Verification\n\n- ok\n';
	const r = checkArtifact({ layer: '技能', content: noProcedure, relPath: 'skills/x/SKILL.md' });
	ok(!r.ok && has(r, 'no-procedure'), '缺 Procedure → **拒绝**（没有步骤它只是说明，不是技能）');
}
{
	const noVerification = '---\nname: some-skill\ndescription: Does a thing.\nstatus: active\n---\n\n# body\n\n## Procedure\n\n1. 做甲。\n';
	const r = checkArtifact({ layer: '技能', content: noVerification, relPath: 'skills/x/SKILL.md' });
	ok(!r.ok && has(r, 'no-verification'), '缺 Verification → **拒绝**（说不出怎么算做成，下次无法判断该不该信）');
}
{
	// 中文标题也认
	const chinese = '---\nname: some-skill\ndescription: Does a thing.\nstatus: active\n---\n\n## 步骤\n\n1. 做甲。\n\n## 验证\n\n- 跑通即算。\n';
	const r = checkArtifact({ layer: '技能', content: chinese, relPath: 'skills/x/SKILL.md' });
	ok(r.ok, '「## 步骤」+「## 验证」→ 通过（中英标题都认）');
}

// ---------------------------------------------------------------------------
console.log('\n--- 法层：「≥2 个无关来源域」——无关必须真的判 ---');
{
	ok(unrelatedSources('clis因果分层系统', 'memory-manager'), 'clis vs memory-manager → 无关');
	ok(!unrelatedSources('dsh插件开发', 'dsh视频工坊'), 'dsh插件开发 vs dsh视频工坊 → 相关（同族）');
	ok(!unrelatedSources('clis', 'clis因果分层系统'), 'clis vs clis因果分层系统 → 相关（互为包含）');
	ok(!unrelatedSources('a', 'a'), '同名 → 相关');
	ok(unrelatedSources('批印坊工程加固', '学习模式插件'), '批印坊 vs 学习模式 → 无关');
}
{
	const sameFamily = gateFa({ principle: '某原则', sources: ['dsh插件开发', 'dsh视频工坊'] });
	ok(sameFamily.ok, '同族双源 → 不拒绝（单源合法）');
	ok(sameFamily.tier === '专项', '  但降级为「专项」——同族域共享假设，验不出普适性');
	ok(sameFamily.warnings.some((w) => w.includes('互相无关')), '  警告说明只有 1 个独立来源');

	const realTwo = gateFa({ principle: '某原则', sources: ['clis因果分层系统', 'memory-manager'] });
	ok(realTwo.tier === '法', '真正无关的双源 → 「法」');
}

console.log(failures === 0 ? '\ncoverage: ALL PASS' : `\ncoverage: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);