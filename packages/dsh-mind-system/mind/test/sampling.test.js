/** 覆盖趋势、输入隐私和采样失败时的降级行为。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordSample, readTrend, trendLine, sampleFilePath, sampleKey } from '../src/sampling.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'mind-sampling-'));
}

test('采样文件落在 storages/ 下（与记忆层同区）', () => {
	const dir = sandbox();
	try {
		const p = sampleFilePath(dir);
		assert.ok(p.includes(join('storages', 'mind-dispatch-samples.jsonl')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('采样不存输入原文或可猜测的稳定哈希', async () => {
	const dir = sandbox();
	try {
		const secret = '用户的私人内容-不应出现在磁盘上';
		await recordSample(dir, { text: secret, unknown: false, situation: 'diagnose', hits: ['x'] });

		const raw = readFileSync(sampleFilePath(dir), 'utf8');
		assert.ok(!raw.includes(secret), '原文绝不能落盘');
		assert.ok(!raw.includes(sampleKey(secret)), '不应保存可用于字典比对的稳定哈希');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('按天聚合趋势：总数 / 无信号数 / 处境分布', async () => {
	const dir = sandbox();
	try {
		await recordSample(dir, { text: '甲', unknown: false, situation: 'diagnose', hits: ['a'] });
		await recordSample(dir, { text: '乙', unknown: true, situation: null, hits: [] });
		await recordSample(dir, { text: '丙', unknown: false, situation: 'execute', hits: ['b'] });

		const t = await readTrend(dir);
		assert.equal(t.overall.total, 3);
		assert.equal(t.overall.unknown, 1);
		assert.ok(Math.abs(t.overall.unknownRate - 1 / 3) < 1e-9);
		assert.equal(t.days.length, 1);
		assert.equal(t.days[0].situations.diagnose, 1);
		assert.equal(t.days[0].situations.execute, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('没有采样文件时不得报健康（趋势为空是事实，不是故障）', async () => {
	const dir = sandbox();
	try {
		const t = await readTrend(dir);
		assert.equal(t.overall, null);
		assert.match(trendLine(t), /暂无样本/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('坏行跳过，不抛错', async () => {
	const dir = sandbox();
	try {
		await recordSample(dir, { text: '好的', unknown: false, situation: 'recall', hits: ['c'] });
		// 追加坏行
		const { appendFileSync } = await import('node:fs');
		appendFileSync(sampleFilePath(dir), 'not-json\n{"broken":\n', 'utf8');

		const t = await readTrend(dir);
		assert.equal(t.overall.total, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('采样失败不影响调度（fire-and-forget）', async () => {
	// 指向一个不可写的路径：recordSample 必须静默返回，不抛错
	await assert.doesNotReject(async () => {
		await recordSample('Z:/definitely/not/writable', { text: 'x', unknown: false, situation: 'recall', hits: [] });
	});
});

test('同一句话的幂等键稳定（趋势可按句聚合）', () => {
	assert.equal(sampleKey('同一句话'), sampleKey('同一句话'));
	assert.notEqual(sampleKey('甲'), sampleKey('乙'));
});
