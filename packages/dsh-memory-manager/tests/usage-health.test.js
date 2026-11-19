/**
 * 使用信号账本的可观测性（2026-11-19）。
 *
 * ## 背景：一次"数据两天没变化"的真实排查
 *
 * 用户报告架构图数字两天不动。查下来是三层问题叠加，每一层单独看都像是
 * "系统正常"，只有把三层放在一起才解释得通：
 *
 * 1. **旧文件主导口径**：`.usage.jsonl` 有 4376 行且 11-16 起就不再写入
 *    （写路径已轮转到按月分片），分片只有 356 行。面板把它们加总成
 *    `signalCount 4732`——**92% 是冻结历史**。
 * 2. **写失败完全静默**：`appendUsage` 的 catch 是空的，理由是"信号账本
 *    不许阻断真实写入"。这个原则对，但实现让它**双向不可见**：既不抛给
 *    调用方（设计如此），也不在任何地方留下"账本已停止接收"的痕迹。
 * 3. **今天召回几乎不命中**：实测当天的真实问法（"做啊"、架构图那句话）
 *    词法命中为 0，`bestScore=0` → 注入 0 行 → **没有 recall 可写**。
 *
 * 所以"数字不动"真正说的是「今天没有可注入的召回」，而不是「采集坏了」。
 * 但在 92% 冻结基数上，这两种情况看起来一模一样——这正是本项目反复栽过的
 * 「失败被伪装成成功」。
 *
 * ## 本文件锁住的判据
 *
 * - 写失败仍然不抛错（契约不变），但必须留下可读痕迹；
 * - 失败痕迹带计数与错误码，不能只有一句"出错了"；
 * - 旧文件与活分片必须能分开识别（两者都以 `.jsonl` 结尾，只能按目录判）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { appendUsage, usageWriteHealth, resetUsageWriteHealth, usageShardPath, usageFiles } =
	await import('../src/usage.js');

const tempRoot = () => mkdtempSync(join2(tmpdir(), 'dsh-health-'));
function join2(...parts) {
	return parts.join(path.sep).replace(/[\\/]+/g, path.sep);
}

test('写成功时健康状态为空（不制造假告警）', async () => {
	resetUsageWriteHealth();
	const root = tempRoot();
	try {
		await appendUsage(root, { href: 'functions/a.md', kind: 'read' });
		const h = usageWriteHealth();
		assert.equal(h.failure, null, '写成功不该留失败痕迹');
		assert.equal(h.failures, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('写失败不抛错，但必须留痕（核心契约）', async () => {
	resetUsageWriteHealth();
	const root = tempRoot();
	try {
		// Make the shard directory impossible to create: plant a FILE where the
		// `.usage` directory must go, so mkdir fails with EEXIST/ENOTDIR.
		writeFileSync(path.join(root, '.usage'), 'not a directory', 'utf8');
		await appendUsage(root, { href: 'functions/a.md', kind: 'read' });
		const h = usageWriteHealth();
		assert.ok(h.failure, '失败必须有痕迹——这正是原来缺的东西');
		assert.ok(h.failures >= 1, '要计数');
		assert.ok(typeof h.failure.code === 'string' && h.failure.code.length > 0, '要带错误码，便于定位');
		assert.ok(h.failure.at, '要带时间');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('失败痕迹有界：不把整条超长消息塞进来', async () => {
	resetUsageWriteHealth();
	const root = tempRoot();
	try {
		writeFileSync(path.join(root, '.usage'), 'x', 'utf8');
		await appendUsage(root, { href: 'functions/a.md', kind: 'read' });
		const h = usageWriteHealth();
		assert.ok(h.failure.message.length <= 300, '痕迹会被探针每轮读取，必须截断');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('旧文件与活分片按目录区分（两者都叫 .jsonl）', async () => {
	const root = tempRoot();
	try {
		// legacy: <root>/.usage.jsonl ; live: <root>/.usage/YYYY-MM.jsonl
		writeFileSync(path.join(root, '.usage.jsonl'), '{"t":"2026-11-01T00:00:00Z"}\n', 'utf8');
		mkdirSync(path.join(root, '.usage'), { recursive: true });
		const shard = usageShardPath(root, new Date('2026-11-15T00:00:00Z'));
		writeFileSync(shard, '{"t":"2026-11-15T00:00:00Z"}\n', 'utf8');

		const files = await usageFiles(root);
		const classified = files.map((f) => ({
			base: path.basename(f.file),
			legacy: path.dirname(path.resolve(f.file)) === path.resolve(root),
		}));
		const legacy = classified.find((c) => c.base === '.usage.jsonl');
		const live = classified.find((c) => c.base === shard.split(path.sep).pop());
		assert.ok(legacy, '旧文件要出现在读取列表里');
		assert.equal(legacy.legacy, true, '旧文件必须被识别为冻结源');
		assert.ok(live, '分片要出现在读取列表里');
		assert.equal(live.legacy, false, '分片必须被识别为活源——按扩展名判会把它和旧文件混在一起');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('写路径只碰分片，从不追加旧文件（轮转后旧文件是只读历史）', async () => {
	const root = tempRoot();
	try {
		writeFileSync(path.join(root, '.usage.jsonl'), '', 'utf8');
		await appendUsage(root, { href: 'functions/a.md', kind: 'read' });
		const legacyAfter = readFileSync(path.join(root, '.usage.jsonl'), 'utf8');
		assert.equal(legacyAfter, '', '旧文件不该再被追加，否则历史会被继续污染');
		const shard = readFileSync(usageShardPath(root), 'utf8');
		assert.match(shard, /functions\/a\.md/, '新行必须进当月分片');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
