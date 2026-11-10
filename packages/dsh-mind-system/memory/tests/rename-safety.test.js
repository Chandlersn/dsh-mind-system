import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Each case uses the real apply/registered execute path, with every data root
// below its own temporary directory. No global DSH memory or skill files are used.
async function fixture(t) {
	const home = await mkdtemp(path.join(tmpdir(), 'memory-rename-safety-'));
	const root = path.join(home, 'memory');
	const functions = path.join(root, 'functions');
	const skills = path.join(home, 'skills');
	await mkdir(functions, { recursive: true });
	await mkdir(skills, { recursive: true });
	await writeFile(path.join(root, 'MEMORY.md'), '# 隔离测试索引\n', 'utf8');
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	});

	const registered = [];
	const noop = () => {};
	const ctx = {
		tools: { register: (definition) => (registered.push(definition), noop) },
		on: () => noop,
		inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
	};
	const mod = await import('../server.js');
	const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
	if (typeof dispose === 'function') t.after(() => dispose());
	const rename = registered.find((item) => item?.name === 'memory_rename' && typeof item.execute === 'function');
	assert.ok(rename, '真实插件 apply 必须注册 memory_rename 执行器');
	return { root, functions, rename: (from, to) => rename.execute({ from, to }, {}) };
}

const targetText = '# 目标功能\n\n## 当前状态摘要（截至 2026-11-10）\n\n- 目标摘要保持不变。\n\n## [2026-11-10] 目标迭代\n\n- 目标原有结论。\n';

for (const [label, sourceText] of [
	['仅有早期演化', '# 来源功能\n\n## 早期演化（2 块已折叠）\n\n- [2026-10-18] 早期结论甲\n- [2026-10-19] 早期结论乙\n'],
	['含自定义章节与摘要', '# 来源功能\n\n## 当前状态摘要（截至 2026-11-09）\n\n- 来源独有状态。\n\n## 自定义章节\n\n保留这段自定义内容与格式。\n\n## [2026-11-09] 来源迭代\n\n- 来源独有结论。\n'],
]) {
	test(`合并${label}的源文件时完整保留两边内容`, async (t) => {
		const f = await fixture(t);
		const source = path.join(f.functions, '来源.md');
		const target = path.join(f.functions, '目标.md');
		await writeFile(source, sourceText, 'utf8');
		await writeFile(target, targetText, 'utf8');
		const result = await f.rename('来源', '目标');
		assert.equal(result.mode, 'merged');
		const output = await readFile(target, 'utf8');
		assert.ok(output.includes(targetText.trimEnd()), '目标原文必须保留');
		assert.ok(output.includes(sourceText), '来源完整原文必须保留，不能只抽取迭代块');
		await assert.rejects(readFile(source), { code: 'ENOENT' }, '合并成功后来源才可移除');
	});
}

test('拒绝合并同一物理文件的硬链接且两个名字的字节不变', async (t) => {
	const f = await fixture(t);
	const source = path.join(f.functions, '硬链来源.md');
	const target = path.join(f.functions, '硬链目标.md');
	const original = Buffer.from('# 原始功能\r\n\r\n## 早期演化\r\n\r\n- 字节不能变。\r\n', 'utf8');
	await writeFile(source, original);
	await link(source, target);
	const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
	assert.equal(sourceStat.ino, targetStat.ino, '测试前确认硬链接指向同一 inode');
	assert.equal(sourceStat.dev, targetStat.dev, '测试前确认硬链接位于同一设备');
	await assert.rejects(f.rename('硬链来源', '硬链目标'), /同一文件|同一路径/);
	assert.deepEqual(await readFile(source), original);
	assert.deepEqual(await readFile(target), original);
});

test('Windows 大小写不同但同一路径必须拒绝并保留原字节', { skip: process.platform !== 'win32' ? '仅适用于 Windows 路径大小写规则' : false }, async (t) => {
	const f = await fixture(t);
	const source = path.join(f.functions, 'MemoryCase.md');
	const alternate = path.join(f.functions, 'memorycase.md');
	const original = Buffer.from('# 大小写路径\r\n\r\n保留全部字节。\r\n', 'utf8');
	await writeFile(source, original);
	assert.deepEqual(await readFile(alternate), original, '测试前确认大小写路径确实指向同一文件');
	await assert.rejects(f.rename('MemoryCase', 'memorycase'), /同一文件|同一路径/);
	assert.deepEqual(await readFile(source), original);
	assert.deepEqual(await readFile(alternate), original);
});
