import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeText, MemoryLedgerAppendError } from '../src/util.js';
import { readLedger, contentHash, LEDGER_REL } from '../src/write-ledger.js';

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'dsh-write-failure-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

// Fail only the isolated ledger append, after its readable preflight. Restore the
// builtin binding even on assertion failure so other tests cannot inherit the fault.
async function withFailedLedgerAppend(root, target, expectedText, run) {
	const ledgerPath = join(root, LEDGER_REL);
	await writeFile(ledgerPath, '', 'utf8');
	assert.ok((await readLedger(root)) instanceof Map, '预检账本必须可读');
	const original = fs.promises.appendFile;
	let attempts = 0;
	let contentAtAppend;
	fs.promises.appendFile = async (file, ...args) => {
		if (file === ledgerPath) {
			attempts++;
			contentAtAppend = await readFile(target, 'utf8');
			const err = new Error('injected ledger append failure');
			err.code = 'EIO';
			throw err;
		}
		return original.call(fs.promises, file, ...args);
	};
	syncBuiltinESMExports();
	try {
		await run();
		assert.equal(attempts, 1, '必须实际触发一次账本追加故障');
		assert.equal(contentAtAppend, expectedText, '追加账本时正文必须已替换');
	} finally {
		fs.promises.appendFile = original;
		syncBuiltinESMExports();
	}
}

test('受管文件已替换但账本不可追加：报告部分成功，不建议盲重试', async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, 'functions'), { recursive: true });
	const file = join(root, 'functions', '问题域.md');
	await writeFile(file, '原文', 'utf8');
	await withFailedLedgerAppend(root, file, '已落盘的新内容', async () => assert.rejects(writeText(file, '已落盘的新内容', { memoryRoot: root }), (err) => {
		assert.ok(err instanceof MemoryLedgerAppendError);
		assert.equal(err.code, 'MEMORY_LEDGER_APPEND_FAILED');
		assert.equal(err.fileWritten, true);
		assert.equal(err.ledgerRecorded, null);
		assert.equal(err.ledgerStatus, 'unknown');
		assert.equal(err.path, file);
		assert.equal(err.key, 'functions/问题域.md');
		assert.match(err.message, /文件已写入/);
		assert.match(err.message, /不要盲目重试/);
		return true;
	}));
	assert.equal(await readFile(file, 'utf8'), '已落盘的新内容');
	assert.deepEqual((await readdir(join(root, 'functions'))).sort(), ['问题域.md'], '不留下临时文件');
});

test('嵌套候选记账失败也报告已落盘及准确相对键', async (t) => {
	const root = await fixture(t);
	const file = join(root, 'dao', '_candidates', '候选.md');
	await withFailedLedgerAppend(root, file, '候选正文', async () => assert.rejects(writeText(file, '候选正文', { memoryRoot: root }), (err) => {
		assert.ok(err instanceof MemoryLedgerAppendError);
		assert.equal(err.code, 'MEMORY_LEDGER_APPEND_FAILED');
		assert.equal(err.fileWritten, true);
		assert.equal(err.ledgerStatus, 'unknown');
		assert.equal(err.key, 'dao/_candidates/候选.md');
		return true;
	}));
	assert.equal(await readFile(file, 'utf8'), '候选正文');
	assert.deepEqual(await readdir(join(root, 'dao', '_candidates')), ['候选.md'], '不留下临时文件');
});

test('账本预检未知时拒绝替换，原文件与目录内容保持不变', async (t) => {
	const root = await fixture(t);
	const dir = join(root, 'functions');
	const file = join(dir, '保留原文.md');
	await mkdir(dir, { recursive: true });
	await writeFile(file, '必须保留的原文', 'utf8');
	await mkdir(join(root, LEDGER_REL));
	assert.equal(await readLedger(root), undefined, '账本不可读取必须是未知，不是空账本');
	await assert.rejects(writeText(file, '不可写入的新内容', { memoryRoot: root }), (err) => {
		assert.ok(!(err instanceof MemoryLedgerAppendError), '预检拒绝不应伪称落盘后失败');
		assert.equal(err.code, 'MEMORY_LEDGER_UNREADABLE');
		assert.equal(err.fileWritten, false);
		return true;
	});
	assert.equal(await readFile(file, 'utf8'), '必须保留的原文');
	assert.deepEqual(await readdir(dir), ['保留原文.md'], '预检失败不留临时文件');
});

test('非受管文件不依赖不可写账本，原返回形状保持兼容', async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, LEDGER_REL));
	const file = join(root, 'README.md');
	const result = await writeText(file, '普通文件', { memoryRoot: root });
	assert.ok(Array.isArray(result.hits));
	assert.equal(await readFile(file, 'utf8'), '普通文件');
});

test('正常受管写入仍返回脱敏回执并登记真实内容哈希', async (t) => {
	const root = await fixture(t);
	const file = join(root, 'insights', '正常.md');
	const result = await writeText(file, '完整内容', { memoryRoot: root });
	assert.ok(Array.isArray(result.hits));
	const ledger = await readLedger(root);
	assert.equal(ledger.get('insights/正常.md').hash, contentHash(await readFile(file, 'utf8')));
});

test('受管路径的正文无法写入时不会伪报账本部分成功', async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, 'functions', '目标.md'), { recursive: true });
	await assert.rejects(writeText(join(root, 'functions', '目标.md'), '无法覆盖目录', { memoryRoot: root }), (err) => {
		assert.notEqual(err.code, 'MEMORY_LEDGER_APPEND_FAILED');
		assert.notEqual(err.fileWritten, true);
		return true;
	});
});
