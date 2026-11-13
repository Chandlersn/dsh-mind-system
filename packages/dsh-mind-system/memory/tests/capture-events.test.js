import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCaptureMarker, hasCaptureMarker, selectCaptureEvents } from '../src/capture-events.js';

const msg = (id, ...texts) => ({ id, role: 'user', source: { kind: 'user' }, content: texts.map((text) => ({ type: 'text', text })) });

test('相同文本不同 ID 是独立事件，标记只匹配完整行', () => {
	const out = selectCaptureEvents([msg('a', '一样'), msg('b', '一样')]);
	assert.equal(out.events.length, 2);
	assert.notEqual(out.events[0].marker, out.events[1].marker);
	assert.equal(out.events[0].marker, makeCaptureMarker('a'));
	assert.ok(hasCaptureMarker(`header\n${out.events[0].marker}\n`, out.events[0].marker));
	assert.ok(!hasCaptureMarker(`> ${out.events[0].marker}`, out.events[0].marker));
	assert.ok(!hasCaptureMarker(`header\n${out.events[0].marker}\n`, out.events[1].marker));
	assert.ok(!hasCaptureMarker('一样', out.events[0].marker));
	assert.ok(!hasCaptureMarker(null, out.events[0].marker));
});

test('同 ID 同内容合并；任何不同内容使整个 ID 冲突而不采集', () => {
	const out = selectCaptureEvents([msg('same', '一', '二'), msg('same', '一二'), msg('conflict', '不同 1'), msg('conflict', '不同 2'), msg('safe', '仍然处理')]);
	assert.deepEqual(out.events.map((e) => [e.id, e.text]), [['same', '一二'], ['safe', '仍然处理']]);
	assert.equal(out.skipped.duplicate, 1);
	assert.equal(out.skipped.conflict, 1);
	assert.deepEqual(out.conflicts, [{ id: 'conflict', reason: 'same-id-different-content' }]);
	const collision = selectCaptureEvents([msg('x', 'sk-' + 'A'.repeat(32)), msg('x', 'sk-' + 'B'.repeat(32))]);
	assert.equal(collision.events.length, 0, '不同凭据脱敏为同样文本也不能掩盖冲突');
});

test('先拼接消息内 text blocks，先脱敏再按 Unicode 截断', () => {
	const secret = 'sk-' + 'A'.repeat(32);
	const out = selectCaptureEvents([msg('s', '前', secret.slice(0, 9), secret.slice(9), '😀后')], { maxChars: 100 });
	assert.equal(out.events[0].text, '前[REDACTED:openai-key]😀后');
	assert.ok(!out.events[0].text.includes(secret));
	assert.deepEqual(out.events[0].redactions, ['openai-key']);
	const truncated = selectCaptureEvents([msg('u', '甲😀乙')], { maxChars: 2 });
	assert.equal(truncated.events[0].text, '甲😀…');
	assert.equal(selectCaptureEvents([msg('u', '😀')], { maxChars: 0 }).events[0].text, '…');
	const cutSecret = selectCaptureEvents([msg('s', secret)], { maxChars: 3 });
	assert.equal(cutSecret.events[0].text, '[RE…');
});

test('插件召回、角色、缺 ID、无文本及坏类型均可观察，合法消息不受影响', () => {
	const broken = Object.create(null, { role: { get() { throw new Error('bad'); } } });
	const input = [null, 3, broken, { role: 'assistant' }, { id: 'recall', role: 'user', source: { kind: 'memory-manager/recall' }, content: [{ type: 'text', text: '插件' }] }, msg('', '无 ID'), msg('   ', '空白 ID'), msg('empty', '  '), { id: 'image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', url: 'x' }] }, { id: 'mixed', role: 'user', source: { kind: 'user' }, content: [null, { type: 'text', text: 12 }, { type: 'text', text: '有效' }] }];
	const out = selectCaptureEvents(input);
	assert.deepEqual(out.events.map((e) => e.id), [], '含非法文本块的消息不能被截取部分内容后当作完整事件');
	assert.deepEqual(out.conflicts, [{ id: 'mixed', reason: 'invalid-content' }]);
	assert.equal(out.skipped.invalidMessage, 3);
	assert.equal(out.skipped.nonUser, 1);
	assert.equal(out.skipped.nonUserSource, 1);
	assert.equal(out.skipped.missingId, 2);
	assert.equal(out.skipped.noText, 2);
	assert.equal(out.skipped.nonTextBlock, 1);
	assert.equal(out.skipped.invalidBlock, 2);
	assert.equal(selectCaptureEvents(null).skipped.invalidMessage, 1);
	const hostileArray = new Proxy([], { get(_target, prop) { if (prop === 'length') throw new Error('bad length'); return undefined; } });
	assert.equal(selectCaptureEvents(hostileArray).skipped.invalidMessage, 1);
	const conflictingEmpty = selectCaptureEvents([msg('id', '真实内容'), msg('id', '')]);
	assert.equal(conflictingEmpty.events.length, 0);
	assert.equal(conflictingEmpty.skipped.conflict, 1);
	const unreadable = { id: 'id', role: 'user', source: { kind: 'user' }, get content() { throw new Error('bad content'); } };
	const result = selectCaptureEvents([msg('id', '真实内容'), unreadable, msg('other', '仍可收集')]);
	assert.deepEqual(result.events.map((event) => event.id), ['other']);
	assert.deepEqual(result.conflicts, [{ id: 'id', reason: 'unreadable-content' }]);
});

test('输入不变，ID 按长度及 UTF-16 原始编码区分', () => {
	const input = [msg('x', 'one', 'two')];
	const before = structuredClone(input);
	Object.freeze(input[0].content[0]); Object.freeze(input[0].content); Object.freeze(input[0]); Object.freeze(input);
	selectCaptureEvents(input);
	assert.deepEqual(input, before);
	assert.notEqual(makeCaptureMarker('a'), makeCaptureMarker('a\0'));
	assert.notEqual(makeCaptureMarker('\ud800'), makeCaptureMarker('\ufffd'));
	assert.equal(makeCaptureMarker('  '), null);
	assert.equal(makeCaptureMarker(1), null);
	assert.equal(hasCaptureMarker('<!-- memory-capture:v1:abc -->', '<!-- memory-capture:v1:abc -->'), false);
});
