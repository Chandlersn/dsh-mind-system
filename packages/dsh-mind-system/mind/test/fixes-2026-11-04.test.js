/**
 * 2026-11-04 修复的三处缺陷，各有可失败的断言。
 *
 * 来源：superagent 的 worker 自主审查（自己 clone、自己跑）报出 9 条，
 * 我逐条核实，这里钉住成立的那几条。第 1 条（record 重置 claimedObserved）
 * 经实测**不成立** —— 探针能正确改口，故这里不再断言它。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readTrendSync, sampleFilePath } from '../src/sampling.js'
import { explainSituation } from '../src/dispatch.js'

test('趋势：missed 只数 no-signal，与 unknown 分账（2026-11-04 修复）', () => {
	// 缺陷原貌：`missed` 字段声明了、初始化了，却**从没累加**。
	// 于是文件头声称能分开的「词表没覆盖」与「输入本来没内容」在趋势里同形。
	const home = mkdtempSync(join(tmpdir(), 'mind-trend-'))
	const path = sampleFilePath(home)
	mkdirSync(dirname(path), { recursive: true })
	const now = new Date().toISOString()
	const rows = [
		{ t: now, situation: null, unknown: true, reason: 'no-signal', hits: [] },
		{ t: now, situation: null, unknown: true, reason: 'no-signal', hits: [] },
		{ t: now, situation: null, unknown: true, reason: 'nothing-actionable', hits: [] },
		{ t: now, situation: null, unknown: true, reason: 'ambiguous', hits: [] },
		{ t: now, situation: 'diagnose', unknown: false, reason: 'matched', hits: ['no-effect'] },
	]
	writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

	const trend = readTrendSync(home)
	assert.equal(trend.overall.total, 5)
	assert.equal(trend.overall.unknown, 4, 'unknown 是全部未判出')
	// 变异：删掉 `if (e.reason === no-signal) bucket.missed += 1` → 本条变红
	assert.equal(trend.overall.missed, 2, 'missed 只能数 no-signal（该扩词表的那种）')
	assert.equal(trend.days[0].reasons['nothing-actionable'], 1, '空输入要有单独计数，不能混进 missed')
	assert.equal(trend.days[0].reasons.ambiguous, 1, 'ambiguous 也要单独可见')
})

test('词表：保留「修复」，引号内的引用由归一化剥离（2026-11-04 澄清注释）', () => {
	// 注释原先写"用'修好'而不是单字'修'"，读起来像"已经不用'修复'了"，
	// 但实测必须保留：删掉它真祈使句就漏判。真实边界是"引号内 vs 裸文本"。
	const imperative = explainSituation('修复这个 bug')
	assert.notEqual(imperative.unknown, true, '「修复这个 bug」不得判成 unknown')
	assert.equal(imperative.situation, 'execute')

	const polite = explainSituation('请修复登录超时问题')
	assert.equal(polite.situation, 'execute', '「请修复…」也必须是 execute')

	// 引号内的"修复"是被引用文本，归一化要剥掉它
	const quoted = explainSituation('注释写着"修复登录超时"，请解释它的作用')
	assert.equal(quoted.normalization?.quoted, 1, '引号跨度必须被识别')
	assert.notEqual(quoted.situation, 'execute', '引号内的动作词不得当成指令')
})
