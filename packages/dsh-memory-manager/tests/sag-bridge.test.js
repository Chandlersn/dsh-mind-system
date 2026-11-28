/** Contract tests for read-only SAG retrieval and observable failure modes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sag = await import('../src/sag.js');

test('countDiskFiles is bounded and skips hidden/large dirs', () => {
	const root = mkdtempSync(join(tmpdir(), 'sag-disk-count-'));
	try {
		mkdirSync(join(root, 'sub'));
		mkdirSync(join(root, '.git'));
		writeFileSync(join(root, 'a.md'), 'a');
		writeFileSync(join(root, 'sub', 'b.md'), 'b');
		writeFileSync(join(root, '.git', 'hidden'), 'h');
		assert.equal(sag.countDiskFiles(root), 2, 'hidden dir excluded, two visible files');
		assert.equal(sag.countDiskFiles(root, { maxFiles: 1 }), null, 'over the bound must be unknown, not a number');
		assert.equal(sag.countDiskFiles(join(root, 'missing')), null, 'unreadable root is unknown');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('normalizeSagScope defaults to empty arrays and bounds user filters', () => {
	assert.deepEqual(sag.normalizeSagScope(), { paths: [], exclude: [] });
	assert.deepEqual(sag.normalizeSagScope({ paths: 'not-an-array' }), { paths: [], exclude: [] });
	const result = sag.normalizeSagScope({
		paths: ['  C:\\root\\docs  ', '', 42, 'x'.repeat(5000)],
		exclude: ['C:\\root\\collide'],
	});
	assert.deepEqual(result.paths, ['  C:\\root\\docs  ']);
	assert.deepEqual(result.exclude, ['C:\\root\\collide']);
	const many = sag.normalizeSagScope({ paths: Array.from({ length: 50 }, (_, i) => `p${i}`) });
	assert.equal(many.paths.length, 32, 'scope filters must be bounded');
});

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

test('服务不可达时返回 network/timeout，不抛错', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
	const r = await sag.sagSearch('查询', { apiKey: 'dummy', endpoint: 'http://127.0.0.1', timeoutMs: 800 });
	assert.equal(r.ok, false);
	assert.ok(['network', 'timeout'].includes(r.reason), `应是网络/超时，实际 ${r.reason}`);
	assert.equal(r.results, undefined, '失败时绝不能带空 results');
});

test('returns the HTTP 401 reason from an isolated server', async () => {
	const { createServer } = await import('node:http');
	const server = createServer((_req, res) => {
		res.writeHead(401);
		res.end();
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	try {
		const { port } = server.address();
		const r = await sag.sagSearch('查询', { apiKey: 'obviously-wrong-key', endpoint: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'http_401');
		assert.equal(r.results, undefined);
	} finally {
		await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
	}
});

test('sagPing 把"在线但未授权"与"不在线"分开', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
	const p = await sag.sagPing({ apiKey: null, endpoint: 'http://127.0.0.1' });
	assert.equal(p.online, false);
	assert.equal(p.authorized, null);
	// 这才是关键区分：在线但没 key ≠ 服务挂了。
});

// ——————————————————————————————————————————————
// 成功路径的契约
// ——————————————————————————————————————————————

test('scoped retrieval keeps original paths, line ranges and separate timings', async (t) => {
	const memory = String.raw`\\?\C:\memory\functions\task.md`;
	const project = 'D:/project/notes.md';
	t.mock.method(globalThis, 'fetch', async (_url, request) => {
		assert.equal(request.redirect, 'error');
		assert.deepEqual(JSON.parse(request.body).paths, ['c:/memory', 'D:/project']);
		return Response.json({ elapsed_ms: 8, results: [
			{ path: memory, heading: 'Task', start_line: 4, end_line: 8, content: 'Procedure' },
			{ path: project, content: 'Research note' },
		] });
	});
	const r = await sag.sagSearch('task', { apiKey: 'dummy', paths: ['c:/memory', 'D:/project'] });
	assert.deepEqual(r.results.map(x => x.path), [memory, project]);
	assert.deepEqual(r.results[0], { path: memory, heading: 'Task', content: 'Procedure', startLine: 4, endLine: 8 });
	assert.equal(r.elapsedMs, 8);
	assert.ok(Number.isInteger(r.hostElapsedMs));
	assert.equal(Object.hasOwn(r, 'experimental'), false);
});

test('rejects out-of-scope passages and malformed responses', async (t) => {
	let data;
	t.mock.method(globalThis, 'fetch', async () => Response.json(data));
	for (const path of ['C:/memory2/file.md', 'C:/memory/excluded/a.md', 'C:/memory/../else/a.md']) {
		data = { results: [{ path, content: 'outside' }] };
		const r = await sag.sagSearch('q', { apiKey: 'x', paths: ['C:/memory'], exclude: ['C:/memory/excluded'] });
		assert.equal(r.reason, 'scope_mismatch');
		assert.equal(r.results, undefined);
	}
	data = {};
	assert.equal((await sag.sagSearch('q', { apiKey: 'x' })).reason, 'bad_response');
	assert.equal((await sag.sagSearch('q', { apiKey: 'x', paths: [''] })).reason, 'invalid_scope');
});

test('caps a streamed response without a Content-Length header', async (t) => {
	let cancelled = false;
	t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
		pull(stream) { stream.enqueue(new Uint8Array(32)); },
		cancel() { cancelled = true; },
	})));
	const r = await sag.sagSearch('q', { apiKey: 'x', maxResponseBytes: 48 });
	assert.equal(r.reason, 'response_too_large');
	assert.equal(cancelled, true);
});

test('forwards host cancellation to a pending fetch', async (t) => {
	const stop = new AbortController();
	t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_, reject) => {
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
		stop.abort();
	}));
	const r = await sag.sagSearch('q', { apiKey: 'x', signal: stop.signal });
	assert.equal(r.reason, 'aborted');
	assert.ok(Number.isInteger(r.hostElapsedMs));
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
	process.env.SAG_API_KEY = 'synthetic-test-placeholder';
	try {
		const r = sag.resolveSagApiKey();
		assert.equal(r.source, 'env', '环境变量应赢');
		assert.equal(r.key, 'synthetic-test-placeholder');
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

test('sagStatus 在服务不可达时如实报错，不返回空 roots', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
	const r = await sag.sagStatus({ endpoint: 'http://127.0.0.1', timeoutMs: 800, apiKey: 'dummy' });
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

test('sagIsIndexed matches paths rather than hit counts', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [{ path: 'C:/memory/other.md', content: 'neighbour' }] }));
	const r = await sag.sagIsIndexed('C:/memory/target.md', 'probe', { apiKey: 'dummy', endpoint: 'http://127.0.0.1' });
	assert.deepEqual(r, { ok: true, indexed: false, searched: 1 });
});

test('sagIsIndexed recognizes a matching path', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [{ path: 'C:/memory/target.md', content: 'match' }] }));
	const r = await sag.sagIsIndexed('C:/memory/target.md', 'probe', { apiKey: 'dummy', endpoint: 'http://127.0.0.1' });
	assert.deepEqual(r, { ok: true, indexed: true, searched: 1 });
});

test('live SAG reports an indexed memory file', { skip: process.env.DSH_TEST_LIVE_SAG !== '1' && 'Set DSH_TEST_LIVE_SAG=1 to enable live SAG tests' }, async (t) => {
	const live = await sag.sagStatus();
	if (!live.ok) { t.skip(`SAG status unavailable: ${live.reason}`); return; }
	const root = live.roots.map((x) => x.path).find((p) => /\.dsh[\\/]memory$/i.test(p));
	if (!root) { t.skip('SAG does not index the memory root'); return; }
	const file = `${root.replace(/\\/g, '/')}/insights/失败被伪装成成功.md`;
	const r = await sag.sagIsIndexed(file, '失败必须响亮');
	if (!r.ok) { t.skip(`SAG search unavailable: ${r.reason}`); return; }
	assert.equal(r.indexed, true);
});

test('sagStatus strips the Windows long path prefix', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ roots: [{ path: '\\\\?\\C:\\memory', status: 'ready' }] }));
	const r = await sag.sagStatus({ apiKey: 'dummy', endpoint: 'http://127.0.0.1' });
	assert.equal(r.ok, true);
	assert.equal(r.roots[0].path, 'C:\\memory');
	assert.equal(r.roots[0].status, 'ready');
});

// ——————————————————————————————————————————————
// 服务拉起：不阻塞、不抛错
// ——————————————————————————————————————————————

test('startSagService 立即返回控制权，ready 最终会 settle', async () => {
	const sw = Date.now();
	const h = sag.startSagService({ bin: process.execPath, timeoutMs: 4000 });
	const took = Date.now() - sw;
	// fire-and-forget：调用本身必须立刻返回（装载期不能被拖住 500ms+）。
	assert.ok(took < 200, `startSagService 必须立即返回，实际 ${took}ms`);
	const r = await h.ready;
	assert.ok(typeof r.ok === 'boolean');
	h.cancel();
});

test('startSagService 对不存在的可执行文件如实报错而非抛异常', async () => {
	const root = mkdtempSync(join(tmpdir(), 'sag-missing-bin-'));
	try {
		const h = sag.startSagService({ bin: join(root, 'missing'), timeoutMs: 2000 });
		const r = await h.ready;
		assert.equal(r.ok, false);
		assert.ok(['spawn_failed', 'spawn_threw', 'timeout'].includes(r.reason), `实际 ${r.reason}`);
		h.cancel();
	} finally { rmSync(root, { recursive: true, force: true }); }
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

test('真实 PATH 上的 sag 能被拉起（服务状态真的改变）', { skip: process.env.DSH_TEST_LIVE_SAG !== '1' && 'Set DSH_TEST_LIVE_SAG=1 to enable live SAG tests' }, async (t) => {
	const { execFileSync } = await import('node:child_process');
	let available = true;
	try {
		execFileSync(process.platform === 'win32' ? 'sag.cmd' : 'sag', ['api', 'status', '--json'], { stdio: 'ignore', shell: process.platform === 'win32' });
	} catch {
		available = false;
	}
	if (!available) { t.skip('SAG CLI is unavailable'); return; }

	const h = sag.startSagService({ timeoutMs: 15000 });
	const r = await h.ready;
	h.cancel();
	assert.equal(r.ok, true, `真实 sag 必须能被拉起，实际 ${JSON.stringify(r)}`);
});
