import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriteGuard, classifyWrite, denialMessage, WRITE_DENIED } from '../src/write-guard.js';

// Faithful local-path resolver: display spelling plus physical identity for missing files.
async function resolveTarget(input, options = {}) {
	const displayPath = path.resolve(options.cwd ?? process.cwd(), input);
	let parent = displayPath;
	const missing = [];
	while (true) {
		try { return { displayPath, targetKey: path.join(await realpath(parent), ...missing) }; }
		catch (err) {
			if (err.code !== 'ENOENT') throw err;
			const next = path.dirname(parent);
			if (next === parent) throw err;
			missing.unshift(path.basename(parent));
			parent = next;
		}
	}
}

async function fixture(fn) {
	const tmp = await mkdtemp(path.join(tmpdir(), 'memory-guard-'));
	const originalHome = process.env.DSH_HOME;
	process.env.DSH_HOME = path.join(tmp, 'host');
	try {
		const root = path.join(tmp, 'memory');
		await mkdir(path.join(root, 'functions'), { recursive: true });
		const signal = new AbortController().signal;
		const agent = {};
		const ctx = { fs: { resolve: resolveTarget }, workingDirectory: { ensure: async (a, s) => {
			assert.equal(a, agent); assert.equal(s, signal); return root;
		} } };
		await fn({ tmp, root, signal, agent, ctx });
	} finally {
		if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
		await rm(tmp, { recursive: true, force: true });
	}
}

function request(name, file, agent, signal) {
	return { name, arguments: { file_path: file }, agent, signal };
}

test('registered tools/execute wrapper stops actual write and edit before body; unrelated calls pass through', async () => {
	await fixture(async ({ tmp, root, signal, agent, ctx }) => {
		// Register through the actual plugin apply, not a source-string assertion.
		const events = new Map();
		const noop = () => {};
		Object.assign(ctx, {
			tools: { register: () => noop },
			on: (name, listener) => { events.set(name, listener); return noop; },
			inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
			systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
		});
		const { apply } = await import('../server.js');
		const skillRoot = path.join(tmp, 'configured-skills');
		await mkdir(skillRoot, { recursive: true });
		const dispose = apply(ctx, { dshRoot: process.env.DSH_INSTALL_DIR, memoryRoot: root, skillRoot });
		try {
			const guard = events.get('tools/execute');
			assert.equal(typeof guard, 'function');
			assert.equal(events.has('fs/write-intent'), false);
			await assert.rejects(guard(request('write', path.join(skillRoot, 'configured', 'SKILL.md'), agent, signal), () => assert.fail('configured skill root body called')), e => e.code === WRITE_DENIED);
			const file = path.join(root, 'functions', 'x.md');
			await writeFile(file, 'original');
			let invoked = 0;
			const body = async () => { invoked++; await writeFile(file, 'changed'); return { ok: true }; };
			// Simulate another around-wrapper executing first and delegating, as host policies do.
			const dispatch = (exec) => (async (next) => next())(() => guard(exec, body));
			for (const name of ['write', 'edit']) {
				await assert.rejects(dispatch(request(name, 'functions/x.md', agent, signal)), e => e.code === WRITE_DENIED);
				assert.equal(await readFile(file, 'utf8'), 'original');
			}
			for (const command of ['create', 'str_replace', 'insert']) {
				await assert.rejects(dispatch({ name: 'str_replace_editor', arguments: { command, path: file }, agent, signal }), e => e.code === WRITE_DENIED);
				assert.equal(await readFile(file, 'utf8'), 'original');
			}
			assert.equal(await guard({ name: 'str_replace_editor', arguments: { command: 'view', path: file }, agent, signal }, async () => 'read'), 'read');
			assert.equal(invoked, 0);
			const safe = path.join(tmp, 'ordinary.md');
			const expected = { content: [{ type: 'text', text: 'ok' }] };
			assert.equal(await guard(request('write', safe, agent, signal), async () => { await writeFile(safe, 'safe'); return expected; }), expected);
			assert.equal(await readFile(safe, 'utf8'), 'safe');
			assert.equal(await guard(request('memory_write', 'functions/x.md', agent, signal), async () => expected), expected);
			const daily = path.join(root, '2026-11-10.md');
			for (const name of ['write', 'edit', 'str_replace_editor']) {
				const exec = name === 'str_replace_editor'
					? { name, arguments: { command: 'str_replace', path: daily }, agent, signal }
					: request(name, '2026-11-10.md', agent, signal);
				const content = `${name}: PID 123, exit code 0\n`;
				assert.equal(await guard(exec, async () => { await writeFile(daily, content); return name; }), name);
				assert.equal(await readFile(daily, 'utf8'), content);
			}
		} finally { if (typeof dispose === 'function') dispose(); }
	});
});

test('canonical target identity blocks a symlink alias to a protected directory', async (t) => {
	await fixture(async ({ tmp, root, signal, agent, ctx }) => {
		const alias = path.join(tmp, 'alias');
		try { await symlink(path.join(root, 'functions'), alias, process.platform === 'win32' ? 'junction' : 'dir'); }
		catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) return t.skip('symlink creation unavailable'); throw err; }
		const guard = createWriteGuard(() => root, ctx);
		await assert.rejects(guard(request('write', path.join(alias, 'new.md'), agent, signal), () => assert.fail('body called')), e => e.code === WRITE_DENIED);
	});
});

test('resolution errors fail closed and non-agent calls use provider default cwd', async () => {
	await fixture(async ({ root, signal, ctx }) => {
		const guard = createWriteGuard(() => root, ctx);
		assert.equal(await guard(request('write', path.join(root, '2026-11-10.md'), undefined, signal), () => 'allowed'), 'allowed');
		await assert.rejects(guard(request('write', path.join(root, 'functions', 'x.md'), undefined, signal), () => assert.fail('protected body called')), e => e.code === WRITE_DENIED);
		const bad = createWriteGuard(() => root, { fs: { resolve: async () => { throw new Error('cannot resolve'); } } });
		await assert.rejects(bad(request('edit', 'x', undefined, signal), () => assert.fail('body called')), /cannot resolve/);
	});
});

test('default host skill root rejects tool writes but permits workspace and read-only operations', async () => {
	await fixture(async ({ tmp, root, signal, agent, ctx }) => {
		const saved = process.env.DSH_HOME;
		process.env.DSH_HOME = path.join(tmp, 'host');
		try {
			const skillRoot = path.join(process.env.DSH_HOME, 'skills');
			await mkdir(path.join(skillRoot, 'example'), { recursive: true });
			const skill = path.join(skillRoot, 'example', 'SKILL.md');
			await writeFile(skill, 'original');
			const guard = createWriteGuard(() => root, ctx);
			for (const name of ['write', 'edit']) {
				await assert.rejects(guard(request(name, skill, agent, signal), () => assert.fail('write body called')), e => e.code === WRITE_DENIED);
			}
			for (const command of ['create', 'str_replace', 'insert']) {
				await assert.rejects(guard({ name: 'str_replace_editor', arguments: { command, path: skill }, agent, signal }, () => assert.fail('editor body called')), e => e.code === WRITE_DENIED);
			}
			assert.equal(await readFile(skill, 'utf8'), 'original');
			assert.equal(await guard({ name: 'str_replace_editor', arguments: { command: 'view', path: skill }, agent, signal }, () => 'view'), 'view');
			assert.equal(await guard({ name: 'read', arguments: { file_path: skill }, agent, signal }, () => 'read'), 'read');
			assert.equal(await guard(request('write', path.join(tmp, 'workspace.md'), agent, signal), () => 'ok'), 'ok');
		} finally {
			if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
		}
	});
});

test('custom independent skill root and directory aliases are protected', async (t) => {
	await fixture(async ({ tmp, root, signal, agent, ctx }) => {
		const skillRoot = path.join(tmp, 'independent-skills');
		await mkdir(path.join(skillRoot, 'nested'), { recursive: true });
		const alias = path.join(tmp, 'skills-alias');
		try { await symlink(skillRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
		catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) return t.skip('directory symlink unavailable'); throw err; }
		const guard = createWriteGuard(() => root, ctx, () => skillRoot);
		for (const target of [skillRoot, path.join(skillRoot, 'nested', 'new.md'), path.join(alias, 'nested', 'new.md')]) {
			await assert.rejects(guard(request('write', target, agent, signal), () => assert.fail('write body called')), e => e.code === WRITE_DENIED);
		}
		const reversed = createWriteGuard(() => root, ctx, () => alias);
		await assert.rejects(reversed(request('edit', path.join(skillRoot, 'nested', 'new.md'), agent, signal), () => assert.fail('write body called')), e => e.code === WRITE_DENIED);
		assert.equal(await guard(request('write', path.join(tmp, 'independent-skills-other', 'safe.md'), agent, signal), () => 'allowed'), 'allowed');
	});
});

test('invalid or unresolved skill root fails closed while read-only operations pass', async () => {
	await fixture(async ({ tmp, root, signal, agent, ctx }) => {
		for (const getSkillRoot of [() => '', () => 'relative-skills', () => undefined, () => { throw new Error('skill root unavailable'); }]) {
			const guard = createWriteGuard(() => root, ctx, getSkillRoot);
			await assert.rejects(guard(request('write', path.join(tmp, 'workspace.md'), agent, signal), () => 'unexpected'), /技能根|skill root unavailable/);
			assert.equal(await guard({ name: 'str_replace_editor', arguments: { command: 'view', path: 'x' }, agent, signal }, () => 'view'), 'view');
		}
	});
});

test('index, layers, ledger and capture metadata remain protected while root daily logs are writable', () => {
	const root = path.resolve('memory-root');
	for (const file of ['MEMORY.md', '.usage.jsonl', '.write-ledger.jsonl', '.capture-mutex.sqlite', '.capture-mutex.sqlite-wal', '.daily-capture.pending', 'functions/2026-11-10.md', 'insights/x.md', 'dao/_candidates/x.md', 'capabilities/x.md', 'legacy/x.md', 'skills/old.md', 'daily/legacy.md']) assert.equal(classifyWrite(root, path.join(root, file)).block, true, file);
	// 暂存目录（2026-11-13）：仅插件提交通道使用，编辑工具一律拒绝。
	for (const file of ['.stage', '.stage/x.stage-abc.tmp', '.stage/nested/deep.tmp']) {
		const verdict = classifyWrite(root, path.join(root, file));
		assert.equal(verdict.block, true, file);
		assert.equal(verdict.reason, 'stage', file);
	}
	assert.match(denialMessage('.stage/x.tmp', 'stage'), /暂存目录仅插件提交通道使用|暂存目录（\.stage\/）仅插件/, 'stage 拒绝信息必须可行动');
	for (const file of ['2026-11-10.md', 'README.md', '../memory-root-other/a']) assert.equal(classifyWrite(root, path.resolve(root, file)).block, false, file);
});

test('daily/YYYY-MM.md archives are writable; other names under daily/ stay denied', () => {
	const root = path.resolve('memory-root');
	// 月/周折叠方案（2026-11）：归档文件也是数据文件，放行。
	for (const file of ['daily/2026-10.md', 'daily/1999-12.md']) {
		const verdict = classifyWrite(root, path.join(root, file));
		assert.equal(verdict.block, false, file);
		assert.equal(verdict.reason, 'daily-archive', file);
	}
	// daily/ 下其他名字一律仍拒：非月形名、日线程形、嵌套、错误扩展名。
	for (const file of ['daily/2026.md', 'daily/2026-1.md', 'daily/2026-123.md', 'daily/2026-10-05.md', 'daily/notes.md', 'daily/2026-10.txt', 'daily/sub/2026-10.md', 'daily/2026-10.md.bak', 'daily/.2026-10.md']) {
		assert.equal(classifyWrite(root, path.join(root, file)).block, true, file);
	}
	// 根层的 YYYY-MM.md 不是归档形态：既非日线程也非受管层文件——不归守卫拦，
	// 但绝不与 daily/ 放行分支混淆。
	assert.equal(classifyWrite(root, path.join(root, '2026-10.md')).block, false, 'root-level month file is unmanaged, not an archive');
});

test('daily-looking display paths cannot bypass canonical layer or independent skill identity', async () => {
	await fixture(async ({ tmp, root, signal, agent, ctx }) => {
		const skillRoot = path.join(tmp, 'independent-skills');
		await mkdir(skillRoot, { recursive: true });
		const daily = path.join(root, '2026-11-10.md');
		for (const physical of [path.join(root, 'functions', 'x.md'), path.join(skillRoot, 'x.md')]) {
			const aliasCtx = { ...ctx, fs: { resolve: async (input, options) => {
				const target = await resolveTarget(input, options);
				return target.displayPath === daily ? { ...target, targetKey: physical } : target;
			} } };
			const guard = createWriteGuard(() => root, aliasCtx, () => skillRoot);
			for (const name of ['write', 'edit', 'str_replace_editor']) {
				const exec = name === 'str_replace_editor'
					? { name, arguments: { command: 'create', path: daily }, agent, signal }
					: request(name, daily, agent, signal);
				await assert.rejects(guard(exec, () => assert.fail('alias body called')), e => e.code === WRITE_DENIED);
			}
		}
		const guard = createWriteGuard(() => root, ctx, () => skillRoot);
		for (const file of ['.write-ledger.jsonl', '.usage.jsonl', '.daily-capture.pending']) {
			await assert.rejects(guard(request('write', path.join(root, file), agent, signal), () => assert.fail('metadata body called')), e => e.code === WRITE_DENIED);
		}
		assert.equal(await guard(request('write', daily, agent, signal), () => 'allowed'), 'allowed');
	});
});

test('unresolved target identities fail closed even for daily-looking paths', async () => {
	await fixture(async ({ root, signal, agent, ctx }) => {
		const daily = path.join(root, '2026-11-10.md');
		for (const badKey of [undefined, 'relative/path']) {
			const badCtx = { ...ctx, fs: { resolve: async (input, options) => {
				const target = await resolveTarget(input, options);
				return target.displayPath === daily ? { ...target, targetKey: badKey } : target;
			} } };
			const guard = createWriteGuard(() => root, badCtx);
			await assert.rejects(guard(request('write', daily, agent, signal), () => assert.fail('unresolved body called')), /无法确认路径归属/);
		}
		assert.equal(await createWriteGuard(() => root, ctx)(request('write', daily, agent, signal), () => 'allowed'), 'allowed');
	});
});
