/**
 * III-3 预算缰绳测试。
 *
 * 核心判据：批量执行面超限时**整批终止**，绝不静默截断——部分执行会让账本
 * 看起来完整、实际缺一段，事后无法回溯是哪次跑的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, chunk, DEFAULT_BUDGET, BUDGET_EXCEEDED } from '../src/budget.js';

test('预算内放行：条目数与账本行数都没超', () => {
	const r = check({ items: 44, rows: 100 });
	assert.equal(r.ok, true);
	assert.equal(r.code, undefined);
});

test('实测规模必须放行：44 条提名（2026-11-09 账本真实峰值）不触发终止', () => {
	// 默认值是从这个实测峰值标定的，若默认值低于它，说明标定错了。
	const r = check({ items: 44, rows: 44 });
	assert.equal(r.ok, true, `44 条应放行（默认上限 ${DEFAULT_BUDGET.maxItems}）`);
});

test('超限终止：返回 budget_exceeded 并给出超了多少、超哪个维度', () => {
	const r = check({ items: 500, rows: 500 });
	assert.equal(r.ok, false);
	assert.equal(r.code, BUDGET_EXCEEDED);
	assert.deepEqual(r.detail.exceeded, ['items', 'rows']);
	assert.equal(r.detail.overBy.items, 500 - DEFAULT_BUDGET.maxItems);
	assert.ok(r.detail.maxItems > 0, '必须报出上限，否则调用方不知道该怎么切');
});

test('只超一个维度也终止（行数超但条目没超）', () => {
	const r = check({ items: 10, rows: 9999 });
	assert.equal(r.ok, false);
	assert.deepEqual(r.detail.exceeded, ['rows']);
	assert.equal(r.detail.overBy.items, 0);
});

test('负规模单列错误码：算错了与超预算是两件事', () => {
	const r = check({ items: -1, rows: 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'invalid_scale');
});

test('空输入按 0 处理，不误判超限', () => {
	assert.equal(check({}).ok, true);
	assert.equal(check(undefined).ok, true);
});

test('阈值可覆盖（测试改预算不碰生产常量）', () => {
	// 生产默认值必须不被测试污染：改 options 不影响 DEFAULT_BUDGET。
	const before = DEFAULT_BUDGET.maxItems;
	const tight = check({ items: 5 }, { budget: { maxItems: 3 } });
	assert.equal(tight.ok, false);
	assert.equal(tight.detail.maxItems, 3);
	assert.equal(DEFAULT_BUDGET.maxItems, before, '默认常量不该被 options 改写');
});

test('chunk：切出的批次每批不超上限，且总数不丢', () => {
	const list = Array.from({ length: 250 }, (_, i) => i);
	const batches = chunk(list, { budget: { maxItems: 100 } });
	assert.equal(batches.length, 3);
	for (const b of batches) assert.ok(b.length <= 100, `每批 ${b.length} 应 ≤100`);
	// 一条都不能丢 —— 静默丢数据正是预算缰绳要防的事
	assert.equal(batches.flat().length, 250);
	assert.deepEqual(batches.flat(), list, '顺序也要保持');
});

test('chunk：空清单返回空数组，不造一个空批次', () => {
	assert.deepEqual(chunk([]), []);
	assert.deepEqual(chunk(undefined), []);
});
