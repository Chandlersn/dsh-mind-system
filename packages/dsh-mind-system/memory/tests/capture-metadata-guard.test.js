import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriteGuard, WRITE_DENIED } from '../src/write-guard.js';

// Faithfully represent the host's display and canonical identity for existing
// files and missing leaves; all paths used below are isolated test fixtures.
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

async function fixture(t) {
	const tmp = await mkdtemp(path.join(tmpdir(), 'capture-guard-'));
	const root = path.join(tmp, 'memory');
	const skills = path.join(tmp, 'skills');
	await mkdir(root);
	await mkdir(skills);
	const signal = new AbortController().signal;
	const agent = {};
	const ctx = { fs: { resolve: resolveTarget }, workingDirectory: { ensure: async () => root } };
	const guard = createWriteGuard(() => root, ctx, () => skills);
	t.after(async () => {
		assert.equal(path.dirname(tmp), path.resolve(tmpdir()));
		assert.ok(path.basename(tmp).startsWith('capture-guard-'));
		await rm(tmp, { recursive: true, force: true });
	});
	return { root, tmp, agent, signal, guard };
}

const protectedNames = ['.capture-mutex.sqlite', '.capture-mutex.sqlite-journal', '.capture-mutex.sqlite-wal', '.capture-mutex.sqlite-shm', '.daily-capture.pending'];
function request(name, file, agent, signal, command) {
	return { name, arguments: name === 'str_replace_editor' ? { command, path: file } : { file_path: file }, agent, signal };
}

test('采集私有元数据的全部编辑工具写操作被拦截，view 只读放行', async (t) => {
	const { root, agent, signal, guard } = await fixture(t);
	for (const name of protectedNames) {
		const file = path.join(root, name);
		await writeFile(file, 'fixture-original');
		for (const spelling of [name, name.toUpperCase()]) {
			for (const [tool, command] of [['write'], ['edit'], ['str_replace_editor', 'create'], ['str_replace_editor', 'str_replace'], ['str_replace_editor', 'insert']]) {
				let called = false;
				await assert.rejects(guard(request(tool, spelling, agent, signal, command), async () => { called = true; await writeFile(file, 'changed'); }), (err) => err.code === WRITE_DENIED && /插件/.test(err.message));
				assert.equal(called, false, `${tool} must not reach its write body: ${spelling}`);
				assert.equal(await readFile(file, 'utf8'), 'fixture-original');
			}
			assert.equal(await guard(request('str_replace_editor', spelling, agent, signal, 'view'), async () => 'read-only'), 'read-only');
		}
	}
});

test('根外路径、普通文档、嵌套文件和相似名称按原路径放行', async (t) => {
	const { root, tmp, agent, signal, guard } = await fixture(t);
	const allowed = ['README.md', '.capture-mutex.sqlite.bak', '.capture-mutex.sqlite-wal.txt', '.capture-mutex.sqlite-wal-other', '.capture-mutex.sqlite2', 'x.capture-mutex.sqlite', '.daily-capture.pending.tmp', '.daily-capture.pending2', path.join('scratch', '.daily-capture.pending')].map((s) => path.join(root, s));
	allowed.push(path.join(tmp, '.capture-mutex.sqlite'), path.join(tmp, '.daily-capture.pending'));
	for (const file of allowed) {
		for (const [tool, command] of [['write'], ['edit'], ['str_replace_editor', 'create'], ['str_replace_editor', 'str_replace'], ['str_replace_editor', 'insert']]) {
			let called = 0;
			const result = await guard(request(tool, file, agent, signal, command), () => { called++; return 'allowed'; });
			assert.equal(result, 'allowed', file);
			assert.equal(called, 1);
		}
	}
});

test('目录链接别名不能绕过采集元数据守卫', async (t) => {
	const { root, tmp, agent, signal, guard } = await fixture(t);
	const alias = path.join(tmp, 'memory-alias');
	try { await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
	catch (err) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip('directory link unavailable'); throw err; }
	for (const name of protectedNames) {
		for (const [tool, command] of [['write'], ['edit'], ['str_replace_editor', 'create'], ['str_replace_editor', 'str_replace'], ['str_replace_editor', 'insert']]) {
			await assert.rejects(guard(request(tool, path.join(alias, name), agent, signal, command), () => assert.fail('aliased write reached body')), (err) => err.code === WRITE_DENIED);
		}
		assert.equal(await guard(request('str_replace_editor', path.join(alias, name), agent, signal, 'view'), () => 'view'), 'view');
	}
	assert.equal(await guard(request('write', path.join(alias, '.capture-mutex.sqlite.bak'), agent, signal), () => 'allowed'), 'allowed');
});

test('文件链接别名不能绕过采集元数据守卫', async (t) => {
	const { root, tmp, agent, signal, guard } = await fixture(t);
	const target = path.join(root, '.capture-mutex.sqlite');
	const alias = path.join(tmp, 'innocent-alias');
	await writeFile(target, 'fixture-original');
	try { await symlink(target, alias, 'file'); }
	catch (err) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip('file symlink unavailable'); throw err; }
	await assert.rejects(guard(request('edit', alias, agent, signal), () => assert.fail('aliased edit reached body')), (err) => err.code === WRITE_DENIED);
	assert.equal(await readFile(target, 'utf8'), 'fixture-original');
});
