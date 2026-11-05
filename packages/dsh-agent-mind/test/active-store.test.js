import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * The exported `currentSituationOf` must read the ACTIVE instance's store.
 *
 * Defect (reviewer finding #4, verified):
 *   index.js re-exported it from src/situation.js, whose module-level
 *   defaultStore is never written by apply() - apply() judges into its own
 *   private store. So the published interface always returned "unknown":
 *   a door that looked usable and was silently useless.
 *
 * Mutation: removing `activeStore = situations` in apply() turns this red.
 */
const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '')

test('exported interface reads active instance: not unknown after real input', async () => {
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
		assert.equal(mindMod.currentSituationOf(), 'unknown', 'no input yet must be unknown')

		const agent = { id: 'active-agent' }
		ctx.emit('agent/inbox/claimed', {
			agent,
			turn: 1,
			message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '改了还是没效果，判一下因果结构' }] },
		})
		await new Promise((r) => setTimeout(r, 300))

		const after = mindMod.currentSituationOf(agent)
		assert.notEqual(after, 'unknown', 'must not stay unknown after real input (the fake facade)')
		assert.equal(after, 'diagnose', `should be diagnose, got ${after}`)
	} finally {
		await ctx.fiber.dispose()
	}
})
