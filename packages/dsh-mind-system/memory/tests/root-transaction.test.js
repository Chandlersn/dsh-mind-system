import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'memory-root-transaction-'));
	t.after(async () => {
		assert.equal(path.dirname(root), path.resolve(tmpdir()));
		assert.ok(path.basename(root).startsWith('memory-root-transaction-'));
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

// Allow pending filesystem resolution to finish before asserting B is blocked.
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

async function assertSerial(firstRunner, firstRoot, secondRunner, secondRoot) {
	const entered = deferred();
	const release = deferred();
	const events = [];
	const first = firstRunner(firstRoot, async () => {
		events.push('first entered'); entered.resolve();
		await release.promise;
		events.push('first finished');
		return 'first result';
	});
	await entered.promise;
	const second = secondRunner(secondRoot, async () => {
		events.push('second entered');
		return 'second result';
	});
	try {
		await pause();
		assert.deepEqual(events, ['first entered'], 'second callback must wait for first');
	} finally {
		release.resolve();
		await Promise.allSettled([first, second]);
	}
	assert.deepEqual(events, ['first entered', 'first finished', 'second entered']);
	assert.deepEqual(await Promise.all([first, second]), ['first result', 'second result']);
}

test('same physical root serializes full async callbacks', async (t) => {
	const root = await fixture(t);
	await assertSerial(withMemoryRootTransaction, root, withMemoryRootTransaction, root);
});

test('realpath aliases and missing roots use the same queue, even after creation', async (t) => {
	const parent = await fixture(t);
	const actual = path.join(parent, 'actual');
	const alias = path.join(parent, 'alias');
	await mkdir(actual);
	try { await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
	catch (error) {
		if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return t.skip('directory links unavailable');
		throw error;
	}
	const rootViaAlias = path.join(alias, 'new', 'memory');
	const rootViaActual = path.join(actual, 'new', 'memory');
	const entered = deferred();
	const release = deferred();
	const events = [];
	const first = withMemoryRootTransaction(rootViaAlias, async () => {
		await mkdir(rootViaAlias, { recursive: true });
		events.push('first entered'); entered.resolve();
		await release.promise;
		events.push('first finished');
	});
	await entered.promise;
	const second = withMemoryRootTransaction(rootViaActual, () => { events.push('second entered'); });
	try {
		await pause();
		assert.deepEqual(events, ['first entered']);
	} finally {
		release.resolve();
		await Promise.allSettled([first, second]);
	}
	assert.deepEqual(events, ['first entered', 'first finished', 'second entered']);
});

test('Windows case variants of a root use the same queue', async (t) => {
	if (process.platform !== 'win32') return t.skip('Windows file identity');
	const root = await fixture(t);
	await assertSerial(withMemoryRootTransaction, root, withMemoryRootTransaction, root.toUpperCase());
});

test('rejection releases the queue and preserves the original error', async (t) => {
	const root = await fixture(t);
	const entered = deferred();
	const release = deferred();
	const expected = new Error('synthetic transaction failure');
	const first = withMemoryRootTransaction(root, async () => { entered.resolve(); await release.promise; throw expected; });
	// Attach a rejection observer immediately so deliberately failing work is handled.
	const observedFirst = first.catch((error) => error);
	await entered.promise;
	const next = withMemoryRootTransaction(root, () => 'continued');
	release.resolve();
	assert.strictEqual(await observedFirst, expected);
	assert.equal(await next, 'continued');
});

test('different roots can make progress in parallel', async (t) => {
	const parent = await fixture(t);
	const a = path.join(parent, 'a');
	const b = path.join(parent, 'b');
	await mkdir(a); await mkdir(b);
	const entered = deferred();
	const release = deferred();
	const first = withMemoryRootTransaction(a, async () => { entered.resolve(); await release.promise; });
	await entered.promise;
	let timer;
	try {
		const result = await Promise.race([
			withMemoryRootTransaction(b, () => 'parallel'),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('different root was blocked')), 2000); }),
		]);
		assert.equal(result, 'parallel');
	} finally {
		clearTimeout(timer);
		release.resolve();
		await first;
	}
});

test('separately imported module instances share the same root queue', async (t) => {
	const root = await fixture(t);
	const copyUrl = new URL('../src/root-transaction.js?independent-module-instance=1', import.meta.url);
	const copy = await import(copyUrl.href);
	assert.notStrictEqual(copy.withMemoryRootTransaction, withMemoryRootTransaction);
	await assertSerial(withMemoryRootTransaction, root, copy.withMemoryRootTransaction, root);
});

test('invalid inputs and dangling root links fail without running callbacks', async (t) => {
	const root = await fixture(t);
	let called = false;
	await assert.rejects(withMemoryRootTransaction('', () => { called = true; }), /non-empty/);
	await assert.rejects(withMemoryRootTransaction(root, null), /callback/);
	const dangling = path.join(root, 'dangling');
	try { await symlink(path.join(root, 'missing-target'), dangling, process.platform === 'win32' ? 'junction' : 'dir'); }
	catch (error) {
		if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return t.skip('directory links unavailable');
		throw error;
	}
	await assert.rejects(withMemoryRootTransaction(path.join(dangling, 'memory'), () => { called = true; }), /ENOENT/);
	assert.equal(called, false);
	const ordinary = path.join(root, 'file');
	await writeFile(ordinary, 'not a directory');
	await assert.rejects(withMemoryRootTransaction(path.join(ordinary, 'memory'), () => { called = true; }));
	assert.equal(called, false);
});
