/** 覆盖趋势、输入隐私和采样失败时的降级行为。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordSample, readTrend, trendLine, sampleFilePath, sampleKey, redactInput } from '../src/sampling.js';

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

// ——————————————————————————————————————————————
// 脱敏摘要（2026-11-10）：让"该加什么词"可回查，但不落原文
// ——————————————————————————————————————————————

test('redactInput 抹掉路径 / URL / 邮箱 / 凭据，且不留原文', () => {
	const raw = '把 C:\\Users\\lyq\\secret\\app.js 和 https://x.com/a?t=1 一起改，邮件 a@b.com，key sk-abcdefgh12345678';
	const got = redactInput(raw);
	assert.ok(!got.includes('C:\\Users'), 'Windows 路径必须抹掉');
	assert.ok(!got.includes('https://'), 'URL 必须抹掉');
	assert.ok(!got.includes('a@b.com'), '邮箱必须抹掉');
	assert.ok(!got.includes('sk-abcdefgh'), '凭据必须抹掉');
	assert.ok(got.includes('<path>') && got.includes('<url>') && got.includes('<secret>'), '替换成类型标记，便于人读');
});

test('redactInput 截断到 60 字以内（丢掉后半句的具体内容）', () => {
	const got = redactInput('一'.repeat(200));
	assert.ok(got.length <= 61, `实际 ${got.length} 字，应 ≤60 + 省略号`);
	assert.ok(got.endsWith('…'), '截断要有省略号，表明不完整');
});

test('redactInput 抹掉代码片段与长 hex', () => {
	const got = redactInput('看这段 `const k = process.env.SECRET` 和哈希 deceb2e2a1b3c4d5e6f708192a3b4c5d');
	assert.ok(!got.includes('process.env.SECRET'), '代码片段应替换');
	assert.ok(!got.includes('deceb2e2a1b3c4d5e6f708192a3b4c5d'), '长 hex 应替换');
	// 剥掉标记后不能还原原句（长度与内容都已变）
	assert.ok(got.length < '看这段 `const k = process.env.SECRET` 和哈希 deceb2e2a1b3c4d5e6f708192a3b4c5d'.length);
});

test('redactInput 空白输入返回空串（不产生空摘要行）', () => {
	assert.equal(redactInput(''), '');
	assert.equal(redactInput('   \n\t '), '');
});

test('摘要只写在未命中行：命中的判定不记输入', async () => {
	const dir = sandbox();
	try {
		await recordSample(dir, { text: '帮我改这个文件', unknown: false, situation: 'execute', hits: ['do-it'] });
		const raw = readFileSync(sampleFilePath(dir), 'utf8');
		const line = JSON.parse(raw.trim());
		assert.equal(line.digest, undefined, '命中行不记摘要（少存一份就少一份风险）');
		assert.ok(line.hits.includes('do-it'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('摘要写在 no-signal 行：事后能回查是哪句话漏判', async () => {
	const dir = sandbox();
	try {
		await recordSample(dir, { text: '这段话一个信号都没命中', unknown: true, reason: 'no-signal', hits: [] });
		const line = JSON.parse(readFileSync(sampleFilePath(dir), 'utf8').trim());
		assert.equal(line.reason, 'no-signal');
		assert.ok(typeof line.digest === 'string' && line.digest.length > 0, '未命中行必须有摘要');
		assert.ok(line.digest.includes('信号'), '摘要保留可辨认的主题词');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
