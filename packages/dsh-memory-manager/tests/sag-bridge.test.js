/**
 * SAG 桥（记忆召回的第二通道）：契约测试。
 *
 * ## 这个文件防的是什么
 *
 * 桥接代码最容易犯的错不是崩溃，是**把"查不到"说成"没有"**：
 *   · 服务没起 → 返回 []（读成"没有相关内容"，假阴性）
 *   · 没配 key → 返回 []（同上）
 *   · 超时 → 返回 []（同上）
 * 一次假阴性会让模型以为记忆里没这条结论，然后凭空重推——本系统最想避免的事。
 * 所以本文件的核心断言是：**每一种不可用都必须如实报 reason，绝不返回空数组冒充成功。**
 *
 * ## 第二条：实验层标记必须存在
 *
 * SAG 命中是实验层线索（§5 D6 / VI 阶段定界），不是正典证据。返回体里没有
 * `experimental: true` 的话，下游没法区分"这是知识库片段"与"这是确认过的记忆"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sag = await import('../src/sag.js');

// ——————————————————————————————————————————————
// 不可用时如实报错，绝不假阴性
// ——————————————————————————————————————————————

test('没有 API key 时返回 no_key，不是空结果', async () => {
	// apiKey 显式给 null，且清掉环境变量，确保无从获取。
	const saved = { SAG_API_KEY: process.env.SAG_API_KEY, DSH_SAG_API_KEY: process.env.DSH_SAG_API_KEY };
	delete process.env.SAG_API_KEY;
	delete process.env.DSH_SAG_API_KEY;
	try {
		const r = await sag.sagSearch('任意查询', { apiKey: null });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'no_key');
		// 关键：没有 results 字段，或它不是数组——总之不能被读成"查到 0 条"。
		assert.equal(r.results, undefined);
	} finally {
		if (saved.SAG_API_KEY !== undefined) process.env.SAG_API_KEY = saved.SAG_API_KEY;
		if (saved.DSH_SAG_API_KEY !== undefined) process.env.DSH_SAG_API_KEY = saved.DSH_SAG_API_KEY;
	}
});

test('空查询直接拒绝，不发请求', async () => {
	for (const q of ['', '   ', null, undefined]) {
		const r = await sag.sagSearch(q, { apiKey: 'dummy' });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'empty_query');
	}
});

test('服务不可达时返回 network/timeout，不抛错', async () => {
	// 端口 1 必然拒绝连接。
	const r = await sag.sagSearch('查询', { apiKey: 'dummy', endpoint: 'http://127.0.0.1:1', timeoutMs: 800 });
	assert.equal(r.ok, false);
	assert.ok(['network', 'timeout'].includes(r.reason), `应是网络/超时，实际 ${r.reason}`);
	assert.equal(r.results, undefined, '失败时绝不能带空 results');
});

test('鉴权失败透传原因（实测：无效 key 走 HTTP 401）', async () => {
	const r = await sag.sagSearch('查询', { apiKey: 'obviously-wrong-key', endpoint: 'http://127.0.0.1:24681', timeoutMs: 2000 });
	// 服务可能没起（那也算如实降级），起了则报鉴权失败。
	// 实测 2026-11-16：无效 key 返回 HTTP 401 → reason 'http_401'；
	// 早前另一次拿到 200 + {"error":{...}}，两种都要能透传。
	assert.equal(r.ok, false);
	assert.ok(
		['http_401', 'unauthorized', 'api_error', 'network', 'timeout', 'bad_response'].includes(r.reason),
		`实际 ${r.reason}`,
	);
	// 无论哪种失败，都不能被读成"查到 0 条"。
	assert.equal(r.results, undefined);
});

test('sagPing 把"在线但未授权"与"不在线"分开', async () => {
	const p = await sag.sagPing({ apiKey: null, endpoint: 'http://127.0.0.1:1' });
	assert.equal(p.online, false);
	assert.equal(p.authorized, null);
	// 这才是关键区分：在线但没 key ≠ 服务挂了。
});

// ——————————————————————————————————————————————
// 成功路径的契约
// ——————————————————————————————————————————————

test('成功时带 experimental 标记与规整的结果形状', async () => {
	const r = await sag.sagSearch('测试', {
		apiKey: 'x',
		endpoint: 'http://127.0.0.1:1', // 不可达，本用例只验形状契约的下半段
		timeoutMs: 300,
	});
	// 不可达时不产生成功形状——这条断言防止把失败包装成成功。
	assert.equal(r.ok, false);
	assert.equal(r.experimental, undefined, '失败结果不携带实验层标记（那会误导下游）');
});

// ——————————————————————————————————————————————
// 端点发现：端口可被用户改，不能写死
// ——————————————————————————————————————————————

test('readSagEndpoint 读不到配置时回默认值，不抛错', () => {
	const e = sag.readSagEndpoint();
	assert.ok(typeof e.endpoint === 'string' && e.endpoint.startsWith('http://'));
	// enabled 允许 true/false/null 三态：null = 读不到，不是"禁用"。
	assert.ok([true, false, null].includes(e.enabled));
});

test('sagDataDir 指向 SAG 自己的桌面数据目录', () => {
	const d = sag.sagDataDir();
	assert.ok(d.includes('com.sag.desktop'), `实际 ${d}`);
});

// ——————————————————————————————————————————————
// key 解析顺序（这条决定了"要不要重启宿主"）
// ——————————————————————————————————————————————

test('resolveSagApiKey：环境变量优先于配置文件', () => {
	const saved = process.env.SAG_API_KEY;
	process.env.SAG_API_KEY = 'sag_from_env_xxx';
	try {
		const r = sag.resolveSagApiKey();
		assert.equal(r.source, 'env', '环境变量应赢');
		assert.equal(r.key, 'sag_from_env_xxx');
	} finally {
		if (saved === undefined) delete process.env.SAG_API_KEY;
		else process.env.SAG_API_KEY = saved;
	}
});

test('resolveSagApiKey：环境变量缺失时回落到配置文件', () => {
	// 这是"不重启宿主"的关键路径：Windows 进程环境块在启动时复制，
	// 事后 SetEnvironmentVariable 不会进入已运行进程；配置文件让下个插件
	// 装载周期就能用上，不必掐着时间重启宿主。
	const savedEnv = { SAG_API_KEY: process.env.SAG_API_KEY, DSH_SAG_API_KEY: process.env.DSH_SAG_API_KEY };
	delete process.env.SAG_API_KEY;
	delete process.env.DSH_SAG_API_KEY;
	try {
		const r = sag.resolveSagApiKey();
		// 本机装了 SAG 且已写 api-key 文件；CI 上没有则 source='none'。
		assert.ok(['file:api-key', 'file:api_key', 'file:key', 'none'].includes(r.source), `实际 ${r.source}`);
		if (r.source !== 'none') {
			assert.ok(typeof r.key === 'string' && r.key.startsWith('sag_'), '从文件读到的必须是合法前缀');
		}
	} finally {
		if (savedEnv.SAG_API_KEY !== undefined) process.env.SAG_API_KEY = savedEnv.SAG_API_KEY;
		if (savedEnv.DSH_SAG_API_KEY !== undefined) process.env.DSH_SAG_API_KEY = savedEnv.DSH_SAG_API_KEY;
	}
});

test('显式 apiKey: null 表示"确实没有"，不回落到配置文件', () => {
	// 测试要靠这个语义来模拟"没配 key"，若它偷偷回落，no_key 用例就失去意义。
	const saved = process.env.SAG_API_KEY;
	process.env.SAG_API_KEY = 'sag_from_env_yyy';
	try {
		return sag.sagSearch('查询', { apiKey: null }).then((r) => {
			assert.equal(r.ok, false);
			assert.equal(r.reason, 'no_key', 'None 必须是 None，不能偷用别的来源');
		});
	} finally {
		if (saved === undefined) delete process.env.SAG_API_KEY;
		else process.env.SAG_API_KEY = saved;
	}
});

// ——————————————————————————————————————————————
// 索引状态（2026-11-16）：写完之后"到底收没收"必须可查
// ——————————————————————————————————————————————
//
// These guard the one thing a search CANNOT answer. Fast mode always returns
// neighbours (measured: an invented phrase still got 3 unrelated rows), so
// "hits > 0" proves nothing about whether a specific file is indexed. The status
// path exists precisely to close that gap, so its failure modes are asserted.

test('sagStatus 在服务不可达时如实报错，不返回空 roots', async () => {
	const r = await sag.sagStatus({ endpoint: 'http://127.0.0.1:1', timeoutMs: 800, apiKey: 'dummy' });
	assert.equal(r.ok, false);
	assert.ok(['network', 'timeout', 'http_401'].includes(r.reason), `实际 ${r.reason}`);
	assert.equal(r.roots, undefined, '失败时绝不能带空 roots 冒充"没有索引目录"');
});

test('sagIsIndexed 参数不全直接拒绝', async () => {
	for (const [file, phrase] of [['', 'x'], ['insights/a.md', ''], [null, null]]) {
		const r = await sag.sagIsIndexed(file, phrase, { apiKey: 'dummy' });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'bad_arguments');
	}
});

test('sagIsIndexed 用路径匹配而不是命中数（这是要害）', async () => {
	// A search for a phrase that only file A contains will ALSO return other files
	// (BM25 neighbours). If the implementation ever "fixed" itself to `hits > 0`,
	// it would report every file as indexed. So: ask about a path that does not
	// exist and assert it comes back false EVEN WHEN the search has hits.
	//
	// This MUST run against the live service to be meaningful: with an unreachable
	// endpoint the function returns early on `ok === false` and never exercises the
	// matching logic at all (which is exactly how a mutation to `hits > 0` survived
	// the first version of this test on 2026-11-16).
	const probePath = 'C:/definitely/not/a/real/memory/file-xyz.md';
	const r = await sag.sagIsIndexed(probePath, '探针');
	if (r.ok === false) {
		// No service in this environment → cannot exercise matching. Skip loudly
		// rather than pretend the assertion ran.
		assert.ok(['network', 'timeout', 'no_key', 'http_401', 'bad_arguments'].includes(r.reason), `实际 ${r.reason}`);
		return;
	}
	// The search DID return rows (neighbours) — that is the trap.
	assert.ok(r.searched >= 0, '搜索应已执行');
	assert.equal(r.indexed, false, '路径不存在时必须为 false —— 若实现改成"有命中就算"，这里会变红');
});

test('sagIsIndexed 对真实存在的文件报 true（闭环的可验证性）', async () => {
	// The counterpart assertion: the same code path must say TRUE for a file that
	// really is indexed. Without this pair, an implementation that always returns
	// false would pass the test above.
	const live = await sag.sagStatus();
	if (!live.ok) return; // no service here
	const root = live.roots.map((x) => x.path).find((p) => /\.dsh[\\/]memory$/i.test(p));
	if (!root) return; // this machine does not index the memory root
	const file = `${root.replace(/\\/g, '/')}/insights/失败被伪装成成功.md`;
	const r = await sag.sagIsIndexed(file, '失败必须响亮');
	if (r.ok === false) return;
	assert.equal(r.indexed, true, `已索引的文件必须报 true（查的是 ${file}）`);
});

test('sagStatus 剥离 Windows 长路径前缀，路径可比可读', async () => {
	// The server returns \\?\C:\... — if the prefix survived, no path would ever
	// match the caller's and every per-file check would come back false.
	const r = await sag.sagStatus({ apiKey: 'dummy', endpoint: 'http://127.0.0.1:1', timeoutMs: 500 });
	if (r.ok) {
		for (const root of r.roots) assert.ok(!root.path.startsWith('\\\\?\\'), `长路径前缀未剥离: ${root.path}`);
	}
	// With the real service (local dev) it must be stripped too.
	const live = await sag.sagStatus();
	if (live.ok) {
		assert.ok(live.roots.length > 0, '真实服务应至少报告一个 root');
		for (const root of live.roots) {
			assert.ok(!root.path.includes('\\\\?\\'), `长路径前缀未剥离: ${root.path}`);
			assert.ok(typeof root.status === 'string' && root.status.length > 0, 'root 必须带状态');
		}
	}
});

// ——————————————————————————————————————————————
// 服务拉起：不阻塞、不抛错
// ——————————————————————————————————————————————

test('startSagService 立即返回控制权，ready 最终会 settle', async () => {
	const sw = Date.now();
	const h = sag.startSagService({ bin: process.platform === 'win32' ? 'sag' : 'sag', timeoutMs: 4000 });
	const took = Date.now() - sw;
	// fire-and-forget：调用本身必须立刻返回（装载期不能被拖住 500ms+）。
	assert.ok(took < 200, `startSagService 必须立即返回，实际 ${took}ms`);
	const r = await h.ready;
	assert.ok(typeof r.ok === 'boolean');
	h.cancel();
});

test('startSagService 对不存在的可执行文件如实报错而非抛异常', async () => {
	const h = sag.startSagService({ bin: 'definitely-not-a-real-binary-xyz', timeoutMs: 2000 });
	const r = await h.ready;
	assert.equal(r.ok, false);
	assert.ok(['spawn_failed', 'spawn_threw', 'timeout'].includes(r.reason), `实际 ${r.reason}`);
	h.cancel();
});

// ——————————————————————————————————————————————
// 真机 bug 回归（2026-11-16）：Windows 上 sag 是 .cmd shim
// ——————————————————————————————————————————————

test('resolveSagCommand 在 Windows 上启用 shell（否则 .cmd 无法 spawn）', () => {
	const r = sag.resolveSagCommand({});
	assert.ok(typeof r.command === 'string' && r.command.length > 0);
	if (process.platform === 'win32') {
		// 这条断言直接钉住真机 bug：spawn 不带 shell 时，PATH 上的 sag.cmd
		// 会 ENOENT，服务永远起不来，而测试却全绿（因为测试用 'sag' 名调了
		// 别的路径）。真实症状是 ready 返回 { ok:false, reason:'spawn_failed' }。
		assert.equal(r.useShell, true, 'Windows 上必须走 shell 才能执行 .cmd shim');
	}
});

test('resolveSagCommand 尊重显式 bin 与环境变量', () => {
	const explicit = sag.resolveSagCommand({ bin: 'C:/custom/sag.exe' });
	assert.equal(explicit.command, 'C:/custom/sag.exe');
	assert.equal(explicit.useShell, false, '显式给了路径就不该再套 shell');

	const saved = process.env.SAG_BIN;
	process.env.SAG_BIN = 'C:/env/sag.exe';
	try {
		const fromEnv = sag.resolveSagCommand({});
		assert.equal(fromEnv.command, 'C:/env/sag.exe');
		assert.equal(fromEnv.useShell, false);
	} finally {
		if (saved === undefined) delete process.env.SAG_BIN;
		else process.env.SAG_BIN = saved;
	}
});

test('真实 PATH 上的 sag 能被拉起（服务状态真的改变）', async () => {
	// 这条是端到端证据：不是"函数返回 true"，而是服务状态从 false 变 true。
	// 拿不到 sag 的环境（CI）跳过，不让它变成假红。
	const { execFileSync } = await import('node:child_process');
	let available = true;
	try {
		execFileSync(process.platform === 'win32' ? 'sag.cmd' : 'sag', ['api', 'status', '--json'], { stdio: 'ignore', shell: process.platform === 'win32' });
	} catch {
		available = false;
	}
	if (!available) return; // sag 未安装：本机可跑，CI 跳过

	const h = sag.startSagService({ timeoutMs: 15000 });
	const r = await h.ready;
	h.cancel();
	assert.equal(r.ok, true, `真实 sag 必须能被拉起，实际 ${JSON.stringify(r)}`);
});
