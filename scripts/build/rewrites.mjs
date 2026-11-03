/**
 * 合成包产物改写表 —— **纯数据，不含逻辑**。
 *
 * 为什么单独成文件而不是塞进 build.manifest.json：
 * 这些规则里有跨行的（`readIn()` 要插一行再改一行），JSON 里写 `\n` 转义后
 * 就没人能核对了。放这里可以逐字对照产物，评审时 diff 得动。
 *
 * 铁律：**每条 edit 必须命中、且命中次数等于 `count`**。
 * 上游代码一改（比如 ENTRY_FILES 键名变了），构建立刻红，而不是静默产出一份半改的文件。
 * 半改的产物比没改更难查——它会跑起来，只是行为不对。
 *
 * `file` 是**产物里的相对路径**（相对 packages/dsh-mind-system/）。
 *
 * @module scripts/build/rewrites.mjs
 */

export const REWRITES = [
	{
		file: 'memory/client.js',
		why:
			'注册 id 必须等于宿主为该包建的那条客户端行 id（= 包名）。同一份面板在独立包叫 ' +
			'dsh-memory-manager、在聚合包叫 dsh-mind-system。注释已统一成两种装法都成立的写法，' +
			'所以这里只替换一行 id —— 若哪天注释又要分叉，说明设计退化了。',
		edits: [
			{
				find: "\tid: 'dsh-memory-manager',",
				replace: "\tid: 'dsh-mind-system',",
				count: 1
			}
		]
	},
	{
		file: 'clis/index.js',
		why:
			'合成包里 clis 的五个入口注册名是子路径（dsh-mind-system/clis-classifier 等），' +
			'ENTRY_FILES 的 key 必须跟着变，否则热重载按旧名找不到自己的入口。' +
			'注意：同一文件里 `location:`、`plugin:`、`Symbol.for(\'dsh-clis...\')` 三类字样**保持原样**，' +
			'所以这里是逐行精确替换，不是全局改名。',
		edits: [
			{
				find: '  "dsh-clis": "index.js",',
				replace: '  "dsh-mind-system/clis": "index.js",',
				count: 1
			},
			{
				find: '  "dsh-clis/classifier": "clis-classifier.js",',
				replace: '  "dsh-mind-system/clis-classifier": "clis-classifier.js",',
				count: 1
			},
			{
				find: '  "dsh-clis/strategy": "clis-strategy.js",',
				replace: '  "dsh-mind-system/clis-strategy": "clis-strategy.js",',
				count: 1
			},
			{
				find: '  "dsh-clis/feedback": "clis-feedback.js",',
				replace: '  "dsh-mind-system/clis-feedback": "clis-feedback.js",',
				count: 1
			},
			{
				find: '  "dsh-clis/orchestrator": "clis-orchestrator.js"',
				replace: '  "dsh-mind-system/clis-orchestrator": "clis-orchestrator.js"',
				count: 1
			},
			{
				find: 'name2 !== "dsh-clis"',
				replace: 'name2 !== "dsh-mind-system/clis"',
				count: 1
			}
		]
	},
	{
		file: 'meta/test/clis-rule.js',
		why:
			'测试要按真实路径 import clis 的构建产物。独立包时期是 `../../dsh-clis/`（兄弟包），' +
			'合成包里 clis 在 `../clis/`，相对层级没变，只是名字变了。',
		edits: [
			{
				find: "new URL('../../dsh-clis/clis-classifier.js', import.meta.url)",
				replace: "new URL('../../clis/clis-classifier.js', import.meta.url)",
				count: 1
			},
			{
				find: "new URL('../../dsh-clis/chunk-2HMO3QIV.js', import.meta.url)",
				replace: "new URL('../../clis/chunk-2HMO3QIV.js', import.meta.url)",
				count: 1
			}
		]
	},
	{
		file: 'mind/test/interfaces.test.js',
		why:
			'本测试按**包名**读兄弟包的文件（readIn 的第一个参数是包名）。合成包里四个成员是' +
			'四个子目录、不再叫包名，所以要一张 包名→目录 的表。独立包里没有这张表也不需要——' +
			'这是产物与源的**结构性**差异，不是改名，因此这两条最值得盯。',
		edits: [
			{
				find: [
					'function readIn(plugin, rel) {',
					'  const p = join(workspace, plugin, rel);'
				].join('\n'),
				replace: [
					"const MEMBER_DIR = { 'dsh-agent-mind': 'mind', 'dsh-clis': 'clis', 'dsh-meta-framework': 'meta', 'dsh-memory-manager': 'memory' };",
					'function readIn(plugin, rel) {',
					'  const dir = MEMBER_DIR[plugin] ?? plugin;',
					'  const p = join(workspace, dir, rel);'
				].join('\n'),
				count: 1
			},
			{
				find: "join(workspace, 'dsh-agent-mind', imp.replace(/^\\.\\//, ''))",
				replace: "join(workspace, MEMBER_DIR['dsh-agent-mind'], imp.replace(/^\\.\\//, ''))",
				count: 1
			}
		]
	}
];
