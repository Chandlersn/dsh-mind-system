import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * 对外的 `currentSituationOf` 必须读到**活跃实例**的处境。
 *
 * 缺陷原貌（superagent 审查第 4 条，我核实成立）：
 *   index.js 导出的 currentSituationOf 来自 src/situation.js 的模块级 defaultStore，
 *   而 apply() 判的是它自己的私有 store —— 两者从不互通，
 *   于是这个对外接口**永远返回 unknown**：一个看着能用、其实恒假的门面。
 *
 * 变异：删掉 apply() 里的 `activeStore = situations` 登记，本条变红。
 */
const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '')

test('导出接口读活跃实例：有真实输入后不得仍是 unknown', async () => {
	process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'mind-active-'))
	const hostRequire = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`)
	const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href)
	const spMod = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
	const SystemPrompt = spMod.default ?? spMod.SystemPrompt
	const mindMod = await import(new URL('../index.js', import.meta.url).href)

	const TOOLS = ['clis_classify', 'clis_run', 'meta_reframe', 'memory_read', 'bash', 'read']
	class ToolsService extends host.Service {
		constructor(ctx) { super(ctx, 'tools'); this.registered = [] }
		register(tool) { this.registered.push(tool); return () => {} }
	}

	const ctx = new host.Context()
	await ctx.plugin(SystemPrompt)
	ctx.plugin(ToolsService)
	ctx.systemPrompt.tools(() => ({ schemas: TOOLS.map((n) => ({ name: n, description: n, parameters: {} })) }))
	await ctx.plugin(mindMod)

	try {
		assert.equal(mindMod.currentSituationOf(), 'unknown', '还没输入时必须是 unknown')

		const agent = { id: 'active-agent' }
		ctx.emit('agent/inbox/claimed', {
			agent,
			turn: 1,
			message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '改了还是没效果，判一下因果结构' }] },
		})
		await new Promise((r) => setTimeout(r, 300))

		const after = mindMod.currentSituationOf(agent)
		assert.notEqual(after, 'unknown', '有真实输入后不得仍是 unknown（恒假门面的判据）')
		assert.equal(after, 'diagnose', `应判成 diagnose，实际 ${after}`)
	} finally {
		await ctx.fiber.dispose()
	}
})
