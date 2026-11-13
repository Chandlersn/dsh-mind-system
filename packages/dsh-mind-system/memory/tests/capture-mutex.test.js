import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, link, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { withCaptureMutex, CAPTURE_SENTINEL } from '../src/capture-mutex.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (p) => access(p).then(() => true, () => false);
async function waitFor(condition, label, ms = 7000) {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) { if (await condition()) return; await sleep(15); }
	throw new Error(`timeout waiting for ${label}`);
}
const name = fileURLToPath(import.meta.url);

// Child coordination uses only isolated signal files: no piped stdio or shared memory.
if (process.env.CAPTURE_MUTEX_TEST_CHILD === '1') {
	const { CT_ROOT: root, CT_STARTED: started, CT_ENTERED: entered, CT_RELEASE: release } = process.env;
	await writeFile(started, 'started');
	if (process.env.CT_BUSY_PROBE) {
		let unexpectedlyEntered = false;
		try { await withCaptureMutex(root, () => { unexpectedlyEntered = true; }, { timeoutMs: 0 }); }
		catch (error) { if (error.code !== 'CAPTURE_MUTEX_BUSY') throw error; }
		if (unexpectedlyEntered) throw new Error('positive control: contender did not actually hit the held lock');
		await writeFile(process.env.CT_BUSY_PROBE, 'busy');
	}
	await withCaptureMutex(root, async () => {
		await writeFile(entered, 'entered');
		if (release) await waitFor(() => exists(release), 'release', 15000);
	}, { timeoutMs: 10000, retryMs: 20 });
} else {
	async function fixture(t) {
		const home = await mkdtemp(path.join(tmpdir(), 'capture-mutex-test-'));
		const root = path.join(home, 'memory');
		await mkdir(root);
		const children = [];
		t.after(async () => {
			for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
			await Promise.all(children.map((c) => c.finished.catch(() => {})));
			assert.equal(path.dirname(home), path.resolve(tmpdir()));
			assert.ok(path.basename(home).startsWith('capture-mutex-test-'));
			await rm(home, { recursive: true, force: true });
		});
		function child(rootPath, tag, release, probeBusy = false) {
			const started = path.join(home, `${tag}.started`), entered = path.join(home, `${tag}.entered`), busy = path.join(home, `${tag}.busy`);
			const p = spawn(process.execPath, ['--no-warnings', name], { stdio: 'ignore', env: { ...process.env, CAPTURE_MUTEX_TEST_CHILD: '1', CT_ROOT: rootPath, CT_STARTED: started, CT_ENTERED: entered, CT_RELEASE: release ?? '', CT_BUSY_PROBE: probeBusy ? busy : '' } });
			p.finished = new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', (code, signal) => resolve({ code, signal })); });
			children.push(p);
			return { p, started, entered, busy };
		}
		return { home, root, child };
	}

	test('two processes serialize one physical root, while a different root enters concurrently', async (t) => {
		const { home, root, child } = await fixture(t);
		const other = path.join(home, 'other'); await mkdir(other);
		const release = path.join(home, 'release');
		const a = child(root, 'first', release);
		await waitFor(() => exists(a.entered), 'first holds lock');
		const b = child(root, 'second', undefined, true);
		await waitFor(() => exists(b.busy), 'second independently observed SQLite busy');
		const c = child(other, 'other');
		await waitFor(() => exists(c.entered), 'other root entered while first held');
		assert.equal((await c.p.finished).code, 0);
		await sleep(150);
		assert.equal(await exists(b.entered), false, 'second must not enter before release');
		await writeFile(release, 'go');
		await waitFor(() => exists(b.entered), 'second entered after release');
		assert.equal((await a.p.finished).code, 0);
		assert.equal((await b.p.finished).code, 0);
	});

	test('OS releases SQLite lock after holder is forcibly killed, without deleting sentinel', async (t) => {
		const { home, root, child } = await fixture(t);
		const a = child(root, 'victim', path.join(home, 'never-release'));
		await waitFor(() => exists(a.entered), 'victim holds lock');
		const before = await stat(path.join(root, CAPTURE_SENTINEL));
		const b = child(root, 'after-kill', undefined, true);
		await waitFor(() => exists(b.busy), 'contender independently observed SQLite busy');
		await sleep(120); assert.equal(await exists(b.entered), false);
		a.p.kill('SIGKILL'); await a.p.finished;
		await waitFor(() => exists(b.entered), 'contender acquired after process death');
		assert.equal((await b.p.finished).code, 0);
		const after = await stat(path.join(root, CAPTURE_SENTINEL));
		assert.equal(after.ino, before.ino, 'no sentinel delete or stale-lock breaking');
	});

	test('busy deadline refuses callback and does not block same-process event loop', async (t) => {
		const { home, root, child } = await fixture(t);
		const a = child(root, 'holder', path.join(home, 'never-release'));
		await waitFor(() => exists(a.entered), 'external holder');
		let called = false, ticked = false;
		const timer = setTimeout(() => { ticked = true; }, 25);
		const start = performance.now();
		await assert.rejects(withCaptureMutex(root, () => { called = true; }, { timeoutMs: 180, retryMs: 15 }), { code: 'CAPTURE_MUTEX_BUSY' });
		clearTimeout(timer);
		assert.equal(called, false); assert.equal(ticked, true);
		assert.ok(performance.now() - start >= 130, 'deadline must actually wait');
		await assert.rejects(withCaptureMutex(root, () => { called = true; }, { timeoutMs: 0 }), { code: 'CAPTURE_MUTEX_BUSY' });
		assert.equal(called, false);
	});

	test('same-process competing async callbacks serialize and release on rejection', async (t) => {
		const { root } = await fixture(t); const seen = [];
		let release; const gate = new Promise((r) => { release = r; });
		let entered; const ready = new Promise((r) => { entered = r; });
		const a = withCaptureMutex(root, async () => { seen.push('a-enter'); entered(); await gate; seen.push('a-exit'); });
		await ready;
		const b = withCaptureMutex(root, async () => { seen.push('b-enter'); throw new Error('callback-b'); }, { timeoutMs: 2000 });
		await sleep(75); assert.deepEqual(seen, ['a-enter']);
		release(); await a; await assert.rejects(b, /callback-b/);
		assert.deepEqual(seen, ['a-enter', 'a-exit', 'b-enter']);
		assert.equal(await withCaptureMutex(root, () => 42), 42);
	});

	test('a directory alias resolves to the same physical-root lock', async (t) => {
		const { home, root } = await fixture(t); const alias = path.join(home, 'root-alias');
		try { await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
		catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`directory alias unavailable: ${error.code}`); throw error; }
		await withCaptureMutex(root, async () => {
			let called = false;
			await assert.rejects(withCaptureMutex(alias, () => { called = true; }, { timeoutMs: 0 }), { code: 'CAPTURE_MUTEX_BUSY' });
			assert.equal(called, false);
		});
	});

	test('negative control proves deferred BEGIN admits concurrent callbacks', async (t) => {
		const { root } = await fixture(t); const original = DatabaseSync.prototype.exec;
		DatabaseSync.prototype.exec = function (sql) { return original.call(this, sql === 'BEGIN IMMEDIATE' ? 'BEGIN' : sql); };
		let release; const gate = new Promise((resolve) => { release = resolve; });
		let entered; const ready = new Promise((resolve) => { entered = resolve; });
		try {
			const a = withCaptureMutex(root, async () => { entered(); await gate; });
			await ready;
			const b = await withCaptureMutex(root, () => 'overlap', { timeoutMs: 200 });
			assert.equal(b, 'overlap', 'without BEGIN IMMEDIATE a second callback really enters');
			release(); await a;
		} finally { release?.(); DatabaseSync.prototype.exec = original; }
	});

	test('missing root, non-directory root, hard-linked sentinel and corrupted DB fail closed', async (t) => {
		const { root, home } = await fixture(t); let calls = 0;
		const fn = () => { calls++; };
		await assert.rejects(withCaptureMutex(path.join(home, 'missing'), fn));
		const plain = path.join(home, 'plain'); await writeFile(plain, 'original');
		await assert.rejects(withCaptureMutex(plain, fn));
		await link(plain, path.join(root, CAPTURE_SENTINEL));
		await assert.rejects(withCaptureMutex(root, fn), { code: 'CAPTURE_MUTEX_UNSAFE_PATH' });
		assert.equal(await readFile(plain, 'utf8'), 'original'); assert.equal(calls, 0);
		const corruptRoot = path.join(home, 'corrupt'); await mkdir(corruptRoot);
		await writeFile(path.join(corruptRoot, CAPTURE_SENTINEL), 'not a sqlite database');
		await assert.rejects(withCaptureMutex(corruptRoot, fn)); assert.equal(calls, 0);
	});

	test('hard-linked SQLite journal companion is rejected before SQLite opens it', async (t) => {
		const { root, home } = await fixture(t); const target = path.join(home, 'journal-target');
		await writeFile(target, 'untouched');
		await link(target, path.join(root, `${CAPTURE_SENTINEL}-journal`));
		let called = false;
		await assert.rejects(withCaptureMutex(root, () => { called = true; }), { code: 'CAPTURE_MUTEX_UNSAFE_PATH' });
		assert.equal(called, false); assert.equal(await readFile(target, 'utf8'), 'untouched');
	});

	test('symbolic-link sentinel fails closed when symlinks are supported', async (t) => {
		const { root, home } = await fixture(t); const target = path.join(home, 'target');
		await writeFile(target, 'untouched');
		try { await symlink(target, path.join(root, CAPTURE_SENTINEL)); }
		catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`); throw error; }
		let called = false;
		await assert.rejects(withCaptureMutex(root, () => { called = true; }), { code: 'CAPTURE_MUTEX_UNSAFE_PATH' });
		assert.equal(called, false); assert.equal(await readFile(target, 'utf8'), 'untouched');
	});

	test('uncertain BEGIN acknowledgement never calls callback, then releases connection', async (t) => {
		const { root } = await fixture(t); const original = DatabaseSync.prototype.exec; let called = false;
		DatabaseSync.prototype.exec = function (sql) { if (sql === 'BEGIN IMMEDIATE') { original.call(this, sql); throw Object.assign(new Error('synthetic lost acknowledgement'), { errcode: 10 }); } return original.call(this, sql); };
		try { await assert.rejects(withCaptureMutex(root, () => { called = true; }), { code: 'CAPTURE_MUTEX_ACQUIRE_FAILED' }); }
		finally { DatabaseSync.prototype.exec = original; }
		assert.equal(called, false); assert.equal(await withCaptureMutex(root, () => 'after'), 'after');
	});

	test('falsy thrown callback values are not mistaken for success', async (t) => {
		const { root } = await fixture(t);
		for (const value of [undefined, null, false, 0, '']) {
			let caught = false;
			try { await withCaptureMutex(root, () => { throw value; }); }
			catch (error) { caught = true; assert.equal(error, value); }
			assert.equal(caught, true);
		}
	});

	test('close acknowledgement failure stays observable and does not hide callback error', async (t) => {
		const { root } = await fixture(t); const original = DatabaseSync.prototype.close;
		const callbackError = new Error('synthetic callback failure');
		DatabaseSync.prototype.close = function () { original.call(this); throw new Error('synthetic close acknowledgement loss'); };
		try {
			await assert.rejects(withCaptureMutex(root, () => { throw callbackError; }), (error) => error instanceof AggregateError && error.code === 'CAPTURE_MUTEX_CLOSE_UNKNOWN' && error.cause === callbackError && error.errors[0] === callbackError && error.errors[1].code === 'CAPTURE_MUTEX_CLOSE_UNKNOWN');
			await assert.rejects(withCaptureMutex(root, () => { throw null; }), (error) => error instanceof AggregateError && error.errors[0] === null && error.errors[1].code === 'CAPTURE_MUTEX_CLOSE_UNKNOWN');
			await assert.rejects(withCaptureMutex(root, () => 'ok'), { code: 'CAPTURE_MUTEX_CLOSE_UNKNOWN' });
		} finally { DatabaseSync.prototype.close = original; }
		assert.equal(await withCaptureMutex(root, () => 'available'), 'available');
	});
}
