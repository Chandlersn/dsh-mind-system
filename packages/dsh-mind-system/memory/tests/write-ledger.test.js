/**
 * 层级写入溯源测试（2026-11-10 用户要求）。
 *
 * 用户："把机制卡死，每个层级的数据和信息编辑来源，只能是插件系统的抽取，
 * 绝对不可以直接动用编辑工具进行书写。"
 *
 * 核心判据只有两条，缺一条这个机制就是摆设：
 * 1. **插件写入 → 通过**（否则机制会骚扰正常路径，没人会留着它）
 * 2. **编辑工具直接写 → 点名**（否则等于没卡）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	contentHash, ledgerKey, isTracked, recordWrite, recordDeleteEvent, readLedger, reconcile, auditBatch,
	TRACKED_ZONES, UNVERIFIED_WRITE, LEDGER_REL,
} from '../src/write-ledger.js';
import { writeText, withPathLock, withWriteCommitLock } from '../src/util.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-write-ledger-'));
}

// ——————————————————————————————————————————————
// 基础：哈希与受管范围
// ——————————————————————————————————————————————

test('contentHash 对内容负责：同内容同哈希，改一个字就变', () => {
	assert.equal(contentHash('abc'), contentHash('abc'));
	assert.notEqual(contentHash('abc'), contentHash('abd'));
	assert.equal(contentHash('').length, 16);
});

test('isTracked：五个层受管，README 与 skills 不受管（不冒充已验证）', () => {
	for (const z of TRACKED_ZONES) assert.equal(isTracked(`${z}/x.md`), true, `${z} 应受管`);
	assert.equal(isTracked('README.md'), false);
	assert.equal(isTracked('skills/foo/SKILL.md'), false);
	assert.equal(isTracked('dao/_candidates/x.md'), true, '候选也属于道层，同样受管');
});

test('删除意图必须配对完成事件；重现文件和交错写入不会被视作正常删除', async () => {
	const root = sandbox();
	const key = 'functions/old.md';
	try {
		assert.equal(await recordWrite(root, { key, hash: contentHash('before'), tool: 'test' }), true);
		assert.equal(await recordDeleteEvent(root, { key, op: 'delete_intent', id: 'tx-1', tool: 'test' }), true);
		let ledger = await readLedger(root);
		assert.equal(ledger.get(key).op, 'delete_intent');
		assert.equal(reconcile({ key, text: 'before', ledger }).reason, 'delete_incomplete');
		assert.equal(await recordDeleteEvent(root, { key, op: 'delete', id: 'tx-1', tool: 'test' }), true);
		ledger = await readLedger(root);
		assert.equal(ledger.get(key).op, 'delete');
		assert.equal(reconcile({ key, text: 'reappeared', ledger }).reason, 'deleted_present');
		assert.equal(await recordWrite(root, { key, hash: contentHash('new'), tool: 'test' }), true);
		ledger = await readLedger(root);
		assert.equal(reconcile({ key, text: 'new', ledger }).verdict, 'ok');
		assert.equal(await recordDeleteEvent(root, { key, op: 'delete', id: 'tx-1' }), true);
		assert.equal(await readLedger(root), undefined, '未配对或交错写入后的完成事件不能掩盖竞态');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('未完成意图之后的写入或另一意图不能把竞态洗成正常记录', async () => {
	for (const next of ['write', 'intent']) {
		const root = sandbox();
		const key = 'functions/race.md';
		try {
			await recordDeleteEvent(root, { key, op: 'delete_intent', id: 'first' });
			if (next === 'write') await recordWrite(root, { key, hash: 'new-hash' });
			else await recordDeleteEvent(root, { key, op: 'delete_intent', id: 'second' });
			assert.equal(await readLedger(root), undefined, `${next} after pending deletion must remain unknown`);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test('删除事件拒绝无效路径和无法写入的账本', async () => {
	const root = sandbox();
	try {
		assert.equal(await recordDeleteEvent(root, { key: 'functions/../x.md', op: 'delete_intent', id: 'x' }), false);
		mkdirSync(join(root, LEDGER_REL));
		assert.equal(await recordDeleteEvent(root, { key: 'functions/x.md', op: 'delete_intent', id: 'x' }), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// ——————————————————————————————————————————————
// 判据 1：插件写入 → 通过
// ——————————————————————————————————————————————

test('插件写入（writeText）自动登记，对账判 ok', async () => {
	const root = sandbox();
	try {
		mkdirSync(join(root, 'functions'), { recursive: true });
		const p = join(root, 'functions', '某域.md');
		await writeText(p, '# 某域\n\n正文\n', { memoryRoot: root });

		const ledger = await readLedger(root);
		assert.ok(ledger instanceof Map, '账本可读');
		assert.equal(ledger.size, 1, '写一次记一行');
		const rec = ledger.get('functions/某域.md');
		assert.ok(rec, '按相对键登记');
		assert.equal(rec.tool, 'memory-manager');

		const text = readFileSync(p, 'utf8');
		const r = reconcile({ key: 'functions/某域.md', text, ledger });
		assert.equal(r.verdict, 'ok', '插件写的文件必须判 ok');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('writeText 登记录的是**脱敏后**的内容（否则每次都会误判被改过）', async () => {
	const root = sandbox();
	try {
		mkdirSync(join(root, 'functions'), { recursive: true });
		const p = join(root, 'functions', '含密钥.md');
		// 里面放一个会被脱敏的 token
		await writeText(p, '# 含密钥\n\ntoken ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 已配置\n', { memoryRoot: root });
		const onDisk = readFileSync(p, 'utf8');
		const ledger = await readLedger(root);
		const rec = ledger.get('functions/含密钥.md');
		assert.equal(rec.hash, contentHash(onDisk), '账本哈希必须等于磁盘上的（脱敏后的）内容');
		assert.equal(reconcile({ key: 'functions/含密钥.md', text: onDisk, ledger }).verdict, 'ok');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('writeText 不登记不受管的文件（README 不在约束内）', async () => {
	const root = sandbox();
	try {
		await writeText(join(root, 'README.md'), '# 索引\n', { memoryRoot: root });
		const ledger = await readLedger(root);
		assert.equal(ledger.size, 0, 'README 不该进账本');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('显式配置根正确登记深层候选和归档，不写入子目录伪账本', async () => {
	const root = sandbox();
	try {
		for (const key of ['dao/_candidates/候选.md', 'dao/_candidates/_rejected/拒绝.md', 'functions/某域.md']) {
			const p = join(root, ...key.split('/'));
			await writeText(p, `内容 ${key}`, { memoryRoot: root });
		}
		const ledger = await readLedger(root);
		for (const key of ['dao/_candidates/候选.md', 'dao/_candidates/_rejected/拒绝.md', 'functions/某域.md']) {
			const text = readFileSync(join(root, ...key.split('/')), 'utf8');
			assert.equal(ledger.get(key)?.hash, contentHash(text), key);
		}
		assert.equal(ledger.size, 3);
		assert.equal(existsSync(join(root, 'dao', LEDGER_REL)), false);
		assert.equal(existsSync(join(root, 'dao', '_candidates', LEDGER_REL)), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('配置根之外即使包含 functions 目录，也不应被误记账', async () => {
	const sandboxRoot = sandbox();
	try {
		const root = join(sandboxRoot, 'configured-memory');
		const other = join(sandboxRoot, 'project');
		mkdirSync(root);
		await writeText(join(other, 'functions', '普通文件.md'), '普通项目文件', { memoryRoot: root });
		assert.equal((await readLedger(root)).size, 0);
		assert.equal(existsSync(join(other, LEDGER_REL)), false);
	} finally {
		rmSync(sandboxRoot, { recursive: true, force: true });
	}
});

test('路径链接指向根外时不把根外文件记进受管账本', async (t) => {
	const sandboxRoot = sandbox();
	try {
		const root = join(sandboxRoot, 'memory');
		const outside = join(sandboxRoot, 'outside');
		mkdirSync(root); mkdirSync(outside);
		try { symlinkSync(outside, join(root, 'functions'), process.platform === 'win32' ? 'junction' : 'dir'); }
		catch (err) {
			if (['EPERM', 'EACCES', 'ENOSYS'].includes(err?.code)) { t.skip(`当前系统无法创建目录链接: ${err.code}`); return; }
			throw err;
		}
		await writeText(join(root, 'functions', 'outside.md'), '实际写在根外', { memoryRoot: root });
		assert.equal((await readLedger(root)).size, 0);
		assert.equal(readFileSync(join(outside, 'outside.md'), 'utf8'), '实际写在根外');
	} finally {
		rmSync(sandboxRoot, { recursive: true, force: true });
	}
});

test('同时使用多个配置根时各自记账，无跨根污染', async () => {
	const sandboxRoot = sandbox();
	try {
		const a = join(sandboxRoot, 'a');
		const b = join(sandboxRoot, 'b');
		mkdirSync(a); mkdirSync(b);
		await Promise.all([
			writeText(join(a, 'dao', '_candidates', 'x.md'), '甲', { memoryRoot: a }),
			writeText(join(b, 'dao', '_candidates', 'x.md'), '乙', { memoryRoot: b }),
		]);
		assert.equal((await readLedger(a)).get('dao/_candidates/x.md')?.hash, contentHash('甲'));
		assert.equal((await readLedger(b)).get('dao/_candidates/x.md')?.hash, contentHash('乙'));
	} finally {
		rmSync(sandboxRoot, { recursive: true, force: true });
	}
});

test('未传根时仅使用 DSH_HOME 下的默认记忆根，不猜目标父目录', async () => {
	const sandboxRoot = sandbox();
	const prior = process.env.DSH_HOME;
	try {
		process.env.DSH_HOME = sandboxRoot;
		const root = join(sandboxRoot, 'memory');
		const p = join(root, 'dao', '_candidates', 'x.md');
		await writeText(p, '默认根');
		assert.equal((await readLedger(root)).get('dao/_candidates/x.md')?.hash, contentHash('默认根'));
		await writeText(join(sandboxRoot, 'outside', 'functions', 'x.md'), '其他');
		assert.equal(existsSync(join(sandboxRoot, 'outside', LEDGER_REL)), false);
	} finally {
		if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior;
		rmSync(sandboxRoot, { recursive: true, force: true });
	}
});

test('显式配置根无效时写入前拒绝，避免误把当前目录当成记忆根', async () => {
	const root = sandbox();
	try {
		const p = join(root, 'functions', 'x.md');
		await assert.rejects(writeText(p, '内容', { memoryRoot: '' }), /memoryRoot/);
		assert.equal(existsSync(p), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('受管键拒绝路径穿越与非规范分隔符', () => {
	for (const key of ['functions/../other.md', 'functions//x.md', 'functions/./x.md', 'functions/..\\other.md']) {
		assert.equal(isTracked(key), false, key);
	}
});

test('提交锁阻止同文件替换与账本追加倒序，失败后队列仍可用', async () => {
	const root = sandbox();
	try {
		const p = join(root, 'x.md');
		let unblock;
		const wait = new Promise((resolve) => { unblock = resolve; });
		let started;
		const entered = new Promise((resolve) => { started = resolve; });
		const events = [];
		const a = withWriteCommitLock(p, async () => {
			events.push('rename A');
			started();
			await wait;
			events.push('ledger A');
		});
		await entered;
		const b = withWriteCommitLock(p, async () => { events.push('rename B', 'ledger B'); });
		try {
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.deepEqual(events, ['rename A'], 'A 尚未记账时 B 不能替换同一目标');
		} finally { unblock(); }
		await Promise.all([a, b]);
		assert.deepEqual(events, ['rename A', 'ledger A', 'rename B', 'ledger B']);
		await assert.rejects(withWriteCommitLock(p, () => { throw new Error('injected failure'); }), /injected/);
		await withWriteCommitLock(p, () => events.push('after failure'));
		assert.equal(events.at(-1), 'after failure');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('同文件并发写入后账本末条哈希与实际内容一致', async () => {
	const root = sandbox();
	try {
		const p = join(root, 'functions', '并发.md');
		const payloads = Array.from({ length: 80 }, (_, i) => `write-${i}\n${'x'.repeat((i % 7) * 10000)}`);
		await Promise.all(payloads.map((text) => writeText(p, text, { memoryRoot: root })));
		const ledger = await readLedger(root);
		assert.ok(ledger instanceof Map, '所有并发追加必须形成有效账本');
		const text = readFileSync(p, 'utf8');
		assert.equal(ledger.get('functions/并发.md')?.hash, contentHash(text));
		assert.equal(readFileSync(join(root, LEDGER_REL), 'utf8').trim().split('\n').length, payloads.length);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('调用方已持有 withPathLock 时仍可写入，不发生嵌套死锁', async () => {
	const root = sandbox();
	try {
		const p = join(root, 'functions', '外层锁.md');
		let timer;
		try {
			await Promise.race([
				withPathLock(p, () => writeText(p, 'locked', { memoryRoot: root })),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writeText deadlocked')), 2000); }),
			]);
		} finally { clearTimeout(timer); }
		assert.equal((await readLedger(root)).get('functions/外层锁.md')?.hash, contentHash('locked'));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// ——————————————————————————————————————————————
// 判据 2：编辑工具直接写 → 点名
// ——————————————————————————————————————————————

test('绕过插件直接改文件 → 对账判 unverified（hash 不符）', async () => {
	const root = sandbox();
	try {
		mkdirSync(join(root, 'insights'), { recursive: true });
		const p = join(root, 'insights', '某法.md');
		await writeText(p, '# 某法\n\n原始内容\n', { memoryRoot: root });
		// 模拟"直接用编辑工具改文件"
		writeFileSync(p, '# 某法\n\n被直接改过的内容\n', 'utf8');

		const ledger = await readLedger(root);
		const text = readFileSync(p, 'utf8');
		const r = reconcile({ key: 'insights/某法.md', text, ledger });
		assert.equal(r.verdict, 'unverified', '直接编辑必须被检出');
		assert.equal(r.reason, 'hash_mismatch');
		assert.ok(r.expected && r.actual && r.expected !== r.actual, '要能给出账本值与现实值');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('从没登记过的文件 → unverified（never_recorded）', async () => {
	const root = sandbox();
	try {
		const ledger = new Map();
		const r = reconcile({ key: 'functions/凭空出现.md', text: 'x', ledger });
		assert.equal(r.verdict, 'unverified');
		assert.equal(r.reason, 'never_recorded');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('账本不可读 → unknown，绝不判 ok（读坏了不能当合规）', () => {
	const r = reconcile({ key: 'functions/x.md', text: 'x', ledger: undefined });
	assert.equal(r.verdict, 'unknown');
	assert.equal(r.reason, 'ledger_unreadable');
});

test('auditBatch：只报受管层的未登记写入，不把「不管」报成「违规」', () => {
	const ledger = new Map();
	const issues = auditBatch({
		root: '/x',
		files: [
			{ key: 'functions/a.md', text: 'x' },   // 受管且未登记 → 报
			{ key: 'README.md', text: 'x' },         // 不受管 → 不报
			{ key: 'skills/s/SKILL.md', text: 'x' }, // 不受管 → 不报
		],
		ledger,
	});
	assert.equal(issues.length, 1, `只应报 1 条（实际 ${issues.length}）`);
	assert.equal(issues[0].key, 'functions/a.md');
	assert.equal(issues[0].code, UNVERIFIED_WRITE);
});

// ——————————————————————————————————————————————
// 账本行为
// ——————————————————————————————————————————————

test('账本只追加：同一文件多次写入，读回的是最后一次', async () => {
	const root = sandbox();
	try {
		await recordWrite(root, { key: 'functions/x.md', hash: 'aaaa', tool: 'memory_write' });
		await recordWrite(root, { key: 'functions/x.md', hash: 'bbbb', tool: 'memory_insight' });
		const ledger = await readLedger(root);
		assert.equal(ledger.get('functions/x.md').hash, 'bbbb', '后写覆盖先写（读的语义）');
		// 但磁盘上是两行 —— 历史没被改写
		const lines = readFileSync(join(root, LEDGER_REL), 'utf8').trim().split('\n');
		assert.equal(lines.length, 2, '历史保留两行（追加式，不修改过去）');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('没有账本文件 → 空 Map（不是 undefined）：还没记过 ≠ 读坏了', async () => {
	const root = sandbox();
	try {
		const ledger = await readLedger(root);
		assert.ok(ledger instanceof Map);
		assert.equal(ledger.size, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('recordWrite 失败不抛错（审计不能破坏写入）', async () => {
	// 指向一个不可写的位置
	await assert.doesNotReject(async () => {
		await recordWrite('Z:/definitely/not/writable', { key: 'functions/x.md', hash: 'aa', tool: 't' });
	});
});

test('账本含损坏行时返回未知，不能把旧记录当作完整账本', async () => {
	const root = sandbox();
	try {
		await recordWrite(root, { key: 'functions/a.md', hash: 'aa', tool: 't' });
		const p = join(root, LEDGER_REL);
		writeFileSync(p, `${readFileSync(p, 'utf8')}{broken json\n`, 'utf8');
		await recordWrite(root, { key: 'functions/b.md', hash: 'bb', tool: 't' });
		const ledger = await readLedger(root);
		assert.equal(ledger, undefined, '账本不完整时不能拿已有记录冒充完整历史');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ——————————————————————————————————————————————
// 可见性分层：历史包袱汇总，真违规点名（2026-11-10 真机实测）
// ——————————————————————————————————————————————

test('auditBatch 区分 never_recorded 与 hash_mismatch（调用方据此分层呈现）', () => {
	const ledger = new Map([['functions/改过的.md', { hash: 'oldhash', at: '2026-11-10T00:00:00.000Z', tool: 'memory_write' }]]);
	const issues = auditBatch({
		root: '/x',
		files: [
			{ key: 'functions/改过的.md', text: '内容已经变了' },   // hash_mismatch → 真违规
			{ key: 'functions/没记过.md', text: 'x' },              // never_recorded → 历史包袱
		],
		ledger,
	});
	assert.equal(issues.length, 2);
	const mismatch = issues.find((i) => i.key === 'functions/改过的.md');
	const never = issues.find((i) => i.key === 'functions/没记过.md');
	assert.equal(mismatch.reason, 'hash_mismatch');
	assert.equal(never.reason, 'never_recorded');
	// 两者必须可分：混成一句"N 个文件有问题"就又会淹没真违规
	assert.notEqual(mismatch.reason, never.reason);
});
