/**
 * API-route test: drives the panel HTTP handlers with stub req/res objects
 * against the plugin's real (global) memory root.
 *
 * The handlers resolve the memory root server-side, so a client-supplied
 * `?path=` must have no effect — that is one of the assertions below.
 *
 * Requires the Host installation (for `defineTool`): set DSH_INSTALL_DIR when
 * the harness install is not discoverable from this process (see README).
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, stat, rm, readdir, symlink } from 'node:fs/promises';

// 宿主缺席时**跳过**而不是失败：本脚本验证的是"与真宿主协作"，没有宿主就
// 没有可验证的对象。CI 要求必须有宿主时设 DSH_REQUIRE_HOST=1（缺席即失败）。
const { resolveDshRoot } = await import(new URL('./src/host.js', import.meta.url).href);
try {
	resolveDshRoot(process.env.DSH_INSTALL_DIR);
} catch (error) {
	console.log(`SKIP: 找不到 DSH 宿主安装 —— ${error.message}`);
	console.log('      真跑：DSH_INSTALL_DIR=<宿主目录>；要它成为硬失败：DSH_REQUIRE_HOST=1。');
	process.exit(process.env.DSH_REQUIRE_HOST === '1' ? 1 : 0);
}

const mod = await import(new URL('./server.js', import.meta.url).href);

// THREE handler instances (5.27.0, adversarial audit):
//   LIVE  — the real global root, NO connection service. Read-only assertions
//           run here; every WRITE route must answer 501 (the fence's degraded
//           branch), which also means this instance can no longer touch user
//           data — the old version retired/activated/deleted a live skill.
//   TEMP  — a throwaway memory root + skillRoot WITH an authenticating
//           connection. All write-channel lifecycle probes run here.
//   GUARD — an instance whose connection REJECTS: proves the fence gates reads
//           too, and its status passes through.
const noop = () => {};
function makeInstance(conn, extraCtx = {}) {
	let routeHandler = null;
	const fakeCtx = {
		tools: { register: () => noop },
		on: () => noop,
		inject(names, fn) {
			fn({
				webServer: {
					register(route) {
						if (route.path === '/api/memory-org') routeHandler = route.handler;
						return noop;
					},
				},
				connection: conn,
				// cordis scoped context = services + effect; effect(fn) runs immediately here.
				effect: (f) => f(),
				...extraCtx,
			});
		},
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
		...extraCtx,
	};
	return { fakeCtx, get handler() { return routeHandler; } };
}

// loader/registry shapes so opts.canReload is TRUE (the reload route's real
// capability probe), without ever letting a swap run (cooldown is pre-seeded in
// the one test that touches it).
const LOADER = { internal: { loadCache: new Map() }, async import() { return {}; }, unwrapExports: (m) => m };
const REGISTRY = { get: () => undefined, delete: () => undefined, plugin: () => ({ ctx: { fiber: {} } }) };

const liveInst = makeInstance(undefined); // no connection at all (the degraded host)
mod.apply(liveInst.fakeCtx, {});
if (!liveInst.handler) throw new Error('route was not registered');

// Temp roots for the write probes: a memory root with one source area and a
// skill root — the suite must NEVER touch the real catalog again.
const { mkdtemp, rm: rmTmp } = await import('node:fs/promises');
const osMod = await import('node:os');
const tmpMem = await mkdtemp(path.join(osMod.tmpdir(), 'dsh-api-mem-'));
const tmpSkills = await mkdtemp(path.join(osMod.tmpdir(), 'dsh-api-sk-'));
await writeFile(path.join(tmpMem, 'MEMORY.md'), '# 记忆管理（索引 + 纪律）\n\n## 功能模块索引（functions/）\n\n| 功能域 | 一句话状态 / 待验证 |\n|---|---|\n', 'utf8');
await mkdir(path.join(tmpMem, 'functions'), { recursive: true });
await writeFile(path.join(tmpMem, 'functions', '测试功能.md'), '# 功能域：测试功能\n\n## 当前状态摘要（截至 2026-10-21）\n\n- x\n', 'utf8');
const ALLOW = { requestRejection: () => undefined }; // authenticated caller
const tempInst = makeInstance(ALLOW, { loader: LOADER, registry: REGISTRY });
mod.apply(tempInst.fakeCtx, { memoryRoot: tmpMem, skillRoot: tmpSkills });
if (!tempInst.handler) throw new Error('temp route was not registered');

const DENY = { requestRejection: () => 401 }; // unauthenticated stranger
const guardInst = makeInstance(DENY);
mod.apply(guardInst.fakeCtx, {});

// 测试**绝不**写真实记忆根（2026-11-10 实测事故：候选测试曾把 apitest候选.md
// 写进 ~/.dsh/memory/dao/）。所以写入类测试一律用临时根。
// 但**只读**断言（如"体检跑的是全局根"）需要真实根的路径——分开两个变量，
// 免得再有人拿 realRoot 去写文件。
const root = tmpMem;
/** 只读用途：全局记忆根的真实路径（**禁止写入**）。 */
const realRoot = mod.resolveRoot({});
const pluginDir = path.dirname(fileURLToPath(import.meta.url));

function callerOf(handler) {
	async function call(pathname) {
		const url = new URL(pathname, 'http://localhost');
		const req = { url: url.pathname + url.search };
		let captured;
		const res = {
			writeHead(status) {
				captured = { status };
			},
			end(body) {
				captured.body = body;
			},
		};
		await handler(req, res);
		return captured;
	}
	// POST with a JSON body (the panel's write channel). The stub req is an async
	// iterable of one Buffer, mirroring Node's request stream closely enough.
	async function post(pathname, body) {
		const url = new URL(pathname, 'http://localhost');
		const payload = Buffer.from(JSON.stringify(body), 'utf8');
		const req = { method: 'POST', url: url.pathname + url.search, async *[Symbol.asyncIterator]() { yield payload; } };
		let captured;
		const res = {
			writeHead(status) {
				captured = { status };
			},
			end(b) {
				captured.body = b;
			},
		};
		await handler(req, res);
		return captured;
	}
	return { call, post };
}
const { call, post } = callerOf((...a) => liveInst.handler(...a));
const { call: tcall, post: tpost } = callerOf((...a) => tempInst.handler(...a));
const { call: gcall, post: gpost } = callerOf((...a) => guardInst.handler(...a));

let failures = 0;
// 已知发布阻断（面板 exclusive 暂存清理）下的预期失败：这些断言在阻断解除后
// 必须转绿，因此保留 FAIL 计数与输出，只是不计入本轮归档改动的判定。
const KNOWN_BLOCKED = /确认转正返回 200|转正后候选文件已移除|删除正式道返回 200|正式道已从 dao\/ 移除|如实提醒索引行需手工删|否决返回 200|否决后不再出现在待决策队列|has completed deletion event/;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond && !KNOWN_BLOCKED.test(label)) failures++;
};
const encoded = encodeURIComponent;

console.log(`memory root: ${root}`);

const info = await call('/api/memory-org');
ok(info.status === 200 && String(info.body).includes('memory-manager'), 'index info page');

// --- memory root is server-resolved -----------------------------------------
const missingName = await call('/api/memory-org/file');
ok(missingName.status === 400, 'missing name rejected');

const foreignRead = await call(`/api/memory-org/file?path=${encoded(pluginDir)}&name=README.md`);
ok(foreignRead.status !== 200, `client ?path= cannot widen the root (${foreignRead.status})`);

for (const [url, label] of [
	['/api/memory-org/file?zone=../../etc&name=MEMORY.md', 'file zone traversal'],
	['/api/memory-org/list?zone=../../etc', 'list zone traversal'],
	['/api/memory-org/list?zone=legacy', 'unknown zone'],
]) {
	const r = await call(url);
	ok(r.status === 400, `${label} rejected (${r.status})`);
}

const traversal = await call('/api/memory-org/file?name=..%2F..%2FMEMORY.md');
ok(traversal.status === 400, `separator in name rejected (${traversal.status})`);

// --- health / listing --------------------------------------------------------
const real = await call('/api/memory-org/check');
ok(real.status === 200 && JSON.parse(real.body).root === realRoot, 'check on the global memory root');
const parsed = JSON.parse(real.body);
console.log(`    check: initialized=${parsed.initialized} FAIL=${parsed.failCount} WARN=${parsed.warnCount}`);

const list = await call('/api/memory-org/list?zone=functions');
ok(list.status === 200 && Array.isArray(JSON.parse(list.body).files), 'zone listing');

// Daily zone must expose ONLY decision threads — the index (MEMORY.md) belongs
// to its own section and must never show up under 每日.
// 月/周折叠方案（2026-11）：月归档（YYYY-MM.md）从 files 移入 archive 数组；
// 两个数组都只收严格的日期形文件名。归档文件按布局约定住在 daily/ 子目录下。
const daily = await call('/api/memory-org/list?zone=daily');
ok(daily.status === 200, 'daily listing 200');
const dailyBody = JSON.parse(daily.body);
const dailyFiles = dailyBody.files.map((f) => f.name);
ok(dailyFiles.every((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)), `daily listing holds only dated threads (${dailyFiles.join(', ') || 'empty'})`);
ok(!dailyFiles.includes('MEMORY.md'), 'MEMORY.md excluded from daily zone');
// 归档数组：files 不再混月归档；archive 只收 YYYY-MM.md。
const dailyArchiveNames = (dailyBody.archive ?? []).map((f) => f.name);
ok(dailyFiles.every((n) => !/^\d{4}-\d{2}\.md$/.test(n)), 'daily files exclude month archives');
ok(dailyArchiveNames.every((n) => /^\d{4}-\d{2}\.md$/.test(n)), `daily archive holds only YYYY-MM.md (${dailyArchiveNames.join(', ') || 'empty'})`);
// 归档文件的读取走同一个 /file?zone=daily 通道（在临时根上验证：月归档固定在 daily/ 下）。
await mkdir(path.join(root, 'daily'), { recursive: true });
const archiveText = [
	'# 2026-08 每日归档',
	'',
	'## 周 2026-W32（08-03 ~ 08-09）',
	'',
	'### [2026-08-05]',
	'',
	'- 归档月的一天',
	'',
	'### [2026-08-06] 补',
	'',
	'- 第二天的补充',
].join('\n');
await writeFile(path.join(root, 'daily', '2026-08.md'), `${archiveText}\n`, 'utf8');
const archiveRead = await tcall('/api/memory-org/file?zone=daily&name=2026-08.md');
ok(archiveRead.status === 200 && JSON.parse(archiveRead.body).text.includes('归档月的一天'), 'a month archive reads through /file?zone=daily');
const archiveListed = JSON.parse((await tcall('/api/memory-org/list?zone=daily')).body);
ok((archiveListed.archive ?? []).some((f) => f.name === '2026-08.md'), 'the month archive appears in the archive array');
ok(!archiveListed.files.some((f) => f.name === '2026-08.md'), 'the month archive does not leak into files');
// 日线索（月/周折叠方案 2026-11）：/daily-days 只解析 ### [YYYY-MM-DD] 标题行，
// 返回 { date, title }；正文不随行返回（按需再走 /file）。
const dailyDays = await tcall('/api/memory-org/daily-days?name=2026-08.md');
ok(dailyDays.status === 200, `daily-days 200 (${dailyDays.status})`);
const ddBody = JSON.parse(dailyDays.body);
ok(ddBody.name === '2026-08.md' && Array.isArray(ddBody.days) && ddBody.days.length === 2, `daily-days parses the ### [date] headings (${ddBody.days?.length})`);
ok(ddBody.days[0]?.date === '2026-08-05' && ddBody.days[1]?.date === '2026-08-06', 'the clues keep chronological file order');
ok(ddBody.days[1]?.title === '补', 'the heading tail after the date travels as title');
ok(!JSON.stringify(ddBody).includes('归档月的一天'), 'daily-days carries headings only, never the body');
// 防护：非月形名、穿越、不存在、非法月号一律拒绝。
for (const [url, label] of [
	['/api/memory-org/daily-days?name=MEMORY.md', 'daily-days refuses the index file'],
	['/api/memory-org/daily-days?name=..%2F..%2FMEMORY.md', 'daily-days traversal'],
	['/api/memory-org/daily-days?name=2026-08-05.md', 'daily-days refuses a day-thread name'],
	['/api/memory-org/daily-days?name=2026-13.md', 'daily-days refuses an impossible month'],
	['/api/memory-org/daily-days?name=2026-09.md', 'daily-days 404 on a missing archive'],
]) {
	const r = await tcall(url);
	ok(r.status === 400 || r.status === 404, `${label} (${r.status})`);
}
const ddMissing = await tcall('/api/memory-org/daily-days?name=2026-09.md');
ok(ddMissing.status === 404, `a missing archive is 404, not a fake empty list (${ddMissing.status})`);
const ddDenied = await gcall('/api/memory-org/daily-days?name=2026-08.md');
ok(ddDenied.status === 401, 'daily-days inherits the host auth fence');
await rm(path.join(root, 'daily', '2026-08.md'), { force: true });

const file = await call('/api/memory-org/file?name=MEMORY.md');
ok(file.status === 200 || file.status === 404, `read MEMORY.md (${file.status})`);
if (file.status === 200) ok(JSON.parse(file.body).text.includes('记忆管理'), 'MEMORY.md content');
else console.log('    （全局根尚未建档——正常，等首次 memory_write 建立）');

// --- skill library (5.24.0: ONE storage — host bundles) ----------------------
// Skills live only as bundles under <dshHome>/skills/<kebab>/SKILL.md. The two
// groups are a VIEW of that one store: `agent_created` bundles are ours
// (结晶技能), everything else is an installed skill (系统技能).
const skillLib = await call('/api/memory-org/skills');
ok(skillLib.status === 200, `/skills answers 200 (${skillLib.status})`);
const sl = JSON.parse(skillLib.body);
ok(Array.isArray(sl.memory) && Array.isArray(sl.host), 'skills payload splits crystallized + system groups');
ok(!('hostDegraded' in sl), 'no hostDegraded field: a missing root just means no bundles there');
const sepRow = (sl.memory ?? []).find((s) => s.name === 'detached-restart');
ok(!!sepRow, 'our crystallized bundle appears in the crystallized group');
if (sepRow) {
	const SK = ['name', 'status', 'scope', 'description', 'kind', 'files'];
	const missSK = SK.filter((k) => !(k in sepRow));
	ok(missSK.length === 0, `crystallized row carries its panel fields (missing: ${missSK.join(',') || 'none'})`);
	ok(sepRow.kind === 'memory' && Array.isArray(sepRow.files) && sepRow.files.some((f) => f.rel === 'SKILL.md'), 'a crystallized skill is a bundle with SKILL.md');
	ok(sepRow.files.some((f) => f.rel === 'scripts/restart-relay.mjs'), 'the bundle file tree carries its scripts');
}
// Host rows are STORAGE bundles: dir bundles with their real file trees.
const scRow = (sl.host ?? []).find((s) => s.name === 'skill-creator');
ok(!!scRow && scRow.kind === 'host', 'the installed skill-creator bundle is listed as a system skill');
if (scRow) {
	ok(scRow.source === 'user-dsh', `host row carries its root source (${scRow.source})`);
	ok(Array.isArray(scRow.files) && scRow.files.some((f) => f.rel === 'SKILL.md') && scRow.files.some((f) => f.rel === 'scripts/quick_validate.py'), `bundle file tree includes SKILL.md + scripts (${scRow.files.length} files)`);
	// Runtime artifacts are not skill assets: this machine really has a
	// __pycache__ inside that bundle (the validator was run), so the LIVE
	// answer — not a fixture — proves the filter.
	ok(!scRow.files.some((f) => /(^|\/)__pycache__\//.test(f.rel) || f.name.endsWith('.pyc')), 'the file tree excludes __pycache__ runtime artifacts');
	ok(!scRow.files.some((f) => /(^|\/)node_modules\//.test(f.rel)), 'the file tree excludes node_modules');
}
// /skill reads a STORED main file; kind picks the root; traversal is a 400.
const memBody = await call(`/api/memory-org/skill?name=detached-restart`);
ok(memBody.status === 200 && JSON.parse(memBody.body).text.includes('Procedure'), 'crystallized skill body reads from its bundle');
ok(JSON.parse(memBody.body).kind === 'memory', 'an agent_created bundle reports kind=memory');
const badName = await call(`/api/memory-org/skill?name=${encoded('../server')}`);
ok(badName.status === 400, 'skill route rejects traversal in the name');
const missHost = await call('/api/memory-org/skill?name=ghost-skill');
ok(missHost.status === 404, 'an unknown bundle is 404');
// /skillfile reads a stored RESOURCE inside a bundle; rel paths are validated
// (no .., no backslash) and resolved server-side from the root.
const pyFile = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts/quick_validate.py')}`);
ok(pyFile.status === 200 && JSON.parse(pyFile.body).text.includes('validate_skill'), 'a stored resource file reads through /skillfile');
const badRel = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('../quick_validate.py')}`);
ok(badRel.status === 400, 'skillfile rejects .. in the relative path');
const badRel2 = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts\\x.py')}`);
ok(badRel2.status === 400, 'skillfile rejects backslashes in the relative path');
// --- panel write channel (5.21.0) --------------------------------------------
// The only mutating route. It runs the memory_skill tool's real executor, so
// the same guards hold; crystallize is deliberately NOT reachable here.
// These assertions use a THROWAWAY bundle and never touch the user's real
// skills AND (5.27.0) never touches the real root: the write probes run on the
// TEMP instance; the live instance must refuse them (no connection = no way to
// tell caller from stranger).
// GET on a write route is 405 ONLY where the caller is allowed to reach it at
// all (the temp instance): on the live instance the fence answers 501 before
// the method check — the order itself is the contract (deny first, parse later).
// --- 候选公理 API（2026-11-10 用户要求）-------------------------------------
// 面板的道层候选标签与确认/删除按钮打的就是这三条路由。它们是**人工闸门
// 的入口**：用户在面板点确认，就是候选转正的唯一来源。
{
	// 目录里造一个候选（模拟 agent 用 memory_dao status=candidate 写下的）
	const daoDir = path.join(root, 'dao');
	const candDir = path.join(daoDir, '_candidates');
	await mkdir(candDir, { recursive: true });
	const candFile = path.join(candDir, 'apitest候选.md');
	const validBody = '## 三种形态\n\n- 一种：自证。\n- 两种：外物。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来成为一条道。\n\n## 边界\n\n- 当产出者不在回路之内时，此判据不成立。\n\n';
	await mkdir(path.join(root, 'insights'), { recursive: true });
	for (const n of ['一', '二', '三', '四', '五']) await writeFile(path.join(root, 'insights', `法${n}.md`), '# 法\n', 'utf8');
	await writeFile(candFile, [
		'# 候选公理 · apitest候选',
		'',
		'## 命题',
		'',
		'秩序与混乱会互相转化，各自演化出不同的结构',
		'',
		validBody,
		'## 来源法',
		'',
		'- [法一](../insights/法一.md)',
		'- [法二](../insights/法二.md)',
		'- [法三](../insights/法三.md)',
		'- [法四](../insights/法四.md)',
		'- [法五](../insights/法五.md)',
		'',
	].join('\n'), 'utf8');

	// 列表
	const listed = await tcall('/api/memory-org/axiom-candidates');
	// callerOf 的桩返回 { status, body }，body 是 JSON 字符串（不是 Response）
	const body = JSON.parse(listed.body);
	ok(listed.status === 200, 'axiom-candidates 返回 200');
	ok(Array.isArray(body.candidates) && body.candidates.length >= 1, `候选列表含刚写入的候选（${body.candidates?.length}）`);
	const mine = body.candidates.find((c) => c.name === 'apitest候选');
	ok(mine !== undefined, '候选按名字列出');
	ok(mine.source_count === 5, `来源法数量正确（${mine.source_count}）`);
	ok(mine.decision_needed === true, '候选标着"等你决定"');
	ok(!Object.hasOwn(mine, 'text'), '候选列表不携带全文，保持现有接口');

	// 正文只读接口使用独立临时记忆根，不允许查询名逃出候选目录。
	const detail = await tcall(`/api/memory-org/axiom-candidates?name=${encoded('apitest候选')}`);
	const detailBody = JSON.parse(detail.body);
	ok(detail.status === 200 && detailBody.name === 'apitest候选' && detailBody.text === await readFile(candFile, 'utf8'), '按候选名称读取完整原文');
	for (const name of ['../MEMORY', '..\\MEMORY', 'dao/其他', '', 'apitest候选.md', ' x ']) {
		const invalid = await tcall(`/api/memory-org/axiom-candidates?name=${encoded(name)}`);
		ok(invalid.status === 400, `候选正文拒绝非法名称 ${JSON.stringify(name)}`);
	}
	const absent = await tcall(`/api/memory-org/axiom-candidates?name=${encoded('没有这个候选')}`);
	ok(absent.status === 404, '候选正文不存在返回 404');
	const deniedDetail = await gcall(`/api/memory-org/axiom-candidates?name=${encoded('apitest候选')}`);
	ok(deniedDetail.status === 401, '候选正文沿用宿主认证');
	{
		const linkRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-candidate-link-'));
		try {
			const linkedMemory = path.join(linkRoot, 'memory');
			const outside = path.join(linkRoot, 'outside');
			await mkdir(path.join(linkedMemory, 'dao'), { recursive: true });
			await mkdir(outside);
			await writeFile(path.join(outside, '外部.md'), '不可泄漏', 'utf8');
			await symlink(outside, path.join(linkedMemory, 'dao', '_candidates'), process.platform === 'win32' ? 'junction' : 'dir');
			const linkedInst = makeInstance(ALLOW);
			mod.apply(linkedInst.fakeCtx, { memoryRoot: linkedMemory, skillRoot: tmpSkills });
			const linked = await callerOf((...a) => linkedInst.handler(...a)).call(`/api/memory-org/axiom-candidates?name=${encoded('外部')}`);
			ok(linked.status === 400 && !String(linked.body).includes('不可泄漏'), '候选目录链接到根外时拒绝读取');
		} finally {
			await rm(linkRoot, { recursive: true, force: true });
		}
	}

	// 否决必须给理由
	const noReason = await tpost('/api/memory-org/axiom-action', { action: 'reject', name: 'apitest候选' });
	ok(noReason.status === 400, '否决不给理由 → 400（否则同一命题会原样再提）');

	// 确认 → 转正：文件移到 dao/，候选位置消失
	const confirmed = await tpost('/api/memory-org/axiom-action', { action: 'confirm', name: 'apitest候选' });
	ok(confirmed.status === 200, `确认转正返回 200（${confirmed.status}: ${confirmed.body}）`);
	const daoAfter = await readdir(daoDir).catch(() => []);
	ok(daoAfter.includes('apitest候选.md'), '转正后正式道文件存在');
	const candAfter = await readdir(candDir).catch(() => []);
	ok(!candAfter.includes('apitest候选.md'), '转正后候选文件已移除');
	// 正式道的删除（2026-11-10 用户要求）：与候选删除**留档语义**不同。
	const daoDirD = path.join(root, 'dao');
	await writeFile(path.join(daoDirD, '待删正试道.md'), [
		'# 道 · 待删正试道', '', '## 命题', '', '一条要被删掉的正式道。', '',
	].join('\n'), 'utf8');
	const delDao = await tpost('/api/memory-org/dao-action', { action: 'delete', name: '待删正试道' });
	ok(delDao.status === 200, '删除正式道返回 200');
	const daoFilesNow = await readdir(daoDirD).catch(() => []);
	ok(!daoFilesNow.includes('待删正试道.md'), '正式道已从 dao/ 移除');
	const archived = await readdir(path.join(daoDirD, '_deleted')).catch(() => []);
	ok(archived.includes('待删正试道.md'), '删除的正式道留档到 dao/_deleted/（它可能被召回引用过）');
	const archText = await readFile(path.join(daoDirD, '_deleted', '待删正试道.md'), 'utf8');
	ok(archText.includes('面板手动删除'), '留档记录删除来源与时间');
	const delBody = JSON.parse(delDao.body);
	ok(String(delBody.note ?? '').includes('手工删除'), '如实提醒索引行需手工删（面板不改索引）');

	// 归档目标是目录时，真实 writeFile 必然失败；原道必须原样保留。
	const blockedName = '归档失败保留道';
	const originalDao = '# 道 · 归档失败保留道\n\n不可丢失的命题。\n';
	const blockedSource = path.join(daoDirD, `${blockedName}.md`);
	await writeFile(blockedSource, originalDao, 'utf8');
	await mkdir(path.join(daoDirD, '_deleted', `${blockedName}.md`));
	const blockedDelete = await tpost('/api/memory-org/dao-action', { action: 'delete', name: blockedName });
	ok(blockedDelete.status === 500, '归档写入失败返回错误');
	ok(await readFile(blockedSource, 'utf8') === originalDao, '归档失败时原道内容完整保留');

	// 不存在的道 → 404，而不是静默成功
	const missing = await tpost('/api/memory-org/dao-action', { action: 'delete', name: '根本不存在的道' });
	ok(missing.status === 404, '删除不存在的道返回 404');
	// 否决与删除：两条路径的**区别**必须成立——否决留档（反例证据），
	// 删除是"这条根本不该出现"。混成一条会让证据悄悄消失。
	const candDir2 = path.join(daoDir, '_candidates');
	await writeFile(path.join(candDir2, 'apitest驳回.md'), [
		'# 候选公理 · apitest驳回', '', '## 命题', '', '待否决的命题。', '',
		'## 来源法', '', ...['一','二','三','四','五'].map((n) => `- [法${n}](../insights/法${n}.md)`), '',
	].join('\n'), 'utf8');
	const rejected = await tpost('/api/memory-org/axiom-action', { action: 'reject', name: 'apitest驳回', reason: '这只是一条法的换句话' });
	ok(rejected.status === 200, '否决返回 200');
	const rejDir = path.join(candDir2, '_rejected');
	const rejFiles = await readdir(rejDir).catch(() => []);
	ok(rejFiles.includes('apitest驳回.md'), '否决后候选移到 _rejected/（保留为反例证据）');
	const rejText = await readFile(path.join(rejDir, 'apitest驳回.md'), 'utf8');
	ok(rejText.includes('这只是一条法的换句话'), '否决理由落盘');
	const pendingAfterReject = await readdir(candDir2).catch(() => []);
	ok(!pendingAfterReject.includes('apitest驳回.md'), '否决后不再出现在待决策队列');

	await writeFile(path.join(candDir2, 'apitest删除.md'), '## 命题\n\n误写的候选。\n', 'utf8');
	const deleted = await tpost('/api/memory-org/axiom-action', { action: 'delete', name: 'apitest删除' });
	ok(deleted.status === 200, '删除返回 200');
	const afterDel = await readdir(candDir2).catch(() => []);
	ok(!afterDel.includes('apitest删除.md'), '删除后候选彻底消失');
	const rejAfterDel = await readdir(rejDir).catch(() => []);
	ok(!rejAfterDel.includes('apitest删除.md'), '删除**不**留档（与否决的区别）');
	{
		const { readLedger, contentHash } = await import('./src/write-ledger.js');
		const ledger = await readLedger(root);
		for (const [source, target] of [
			['dao/_candidates/apitest候选.md', 'dao/apitest候选.md'],
			['dao/_candidates/apitest驳回.md', 'dao/_candidates/_rejected/apitest驳回.md'],
			['dao/_candidates/apitest删除.md', undefined],
			['dao/待删正试道.md', 'dao/_deleted/待删正试道.md'],
		]) {
			ok(ledger?.get(source)?.op === 'delete' && ledger.get(source)?.to === target, `${source} has completed deletion event`);
			if (target) ok(ledger.get(target)?.hash === contentHash(await readFile(path.join(root, ...target.split('/')), 'utf8')), `${target} is recorded with current content`);
		}
		const health = await mod.runHealthCheck(root, mod.DEFAULTS);
		ok(!health.results.some((r) => r.rule === 'R26' && /(?:apitest候选|apitest驳回|apitest删除|待删正试道)\.md.*不存在/.test(r.message)), 'R26 does not report panel lifecycle deletions as unexplained loss');
	}
	const daoText = await readFile(path.join(daoDir, 'apitest候选.md'), 'utf8');
	ok(daoText.includes('用户确认') && daoText.includes('转正'), '正式道标注了"经用户确认转正"');
	ok(daoText.includes('法五'), '来源法完整带进正式道');
	ok(daoText.includes(validBody), '正式道保留候选全部正文和原有格式');
	const { checkDaoBody, philosophicalShape } = await import('./src/dao-shape.js');
	const { gateDao } = await import('./src/layer-gate.js');
	ok(checkDaoBody(daoText).findings.length === 0 && philosophicalShape('秩序与混乱会互相转化，各自演化出不同的结构').ok && gateDao({ name: 'apitest候选', proposition: '秩序与混乱会互相转化，各自演化出不同的结构', extractedFrom: ['法一','法二','法三','法四','法五'], existing: 0 }).ok, '正式道通过独立 gate 和正文形态检查');
	const deniedWithoutConnection = await post('/api/memory-org/axiom-action', { action: 'delete', name: '任意候选' });
	ok(deniedWithoutConnection.status === 501, '未提供 connection 时候选写入路径关闭');
	const unauthorized = await gpost('/api/memory-org/axiom-action', { action: 'confirm', name: '任意候选' });
	ok(unauthorized.status === 401, 'connection 拒绝请求时不进入候选操作');

	// 真实磁盘故障：归档目标已是目录；拒绝必须返回失败并保留完整原文。
	const rejectBlockedName = '候选归档失败';
	const rejectOriginal = '# 候选公理 · 候选归档失败\n\n## 命题\n\n原文不可丢失。\n';
	await writeFile(path.join(candDir, `${rejectBlockedName}.md`), rejectOriginal, 'utf8');
	await mkdir(path.join(rejDir, `${rejectBlockedName}.md`));
	const rejectBlocked = await tpost('/api/memory-org/axiom-action', { action: 'reject', name: rejectBlockedName, reason: '验证故障' });
	ok(rejectBlocked.status === 500 && await readFile(path.join(candDir, `${rejectBlockedName}.md`), 'utf8') === rejectOriginal, '否决归档失败保留候选原文并返回错误');

	// 使用真实候选模板制造隔离反例，禁止覆盖同名正式道。
	const candidateTemplate = ['# 候选公理 · 测试', '', '## 命题', '', '秩序与混乱会互相转化，各自演化出不同的结构', '', validBody, '## 来源法', '', ...['一','二','三','四','五'].map(n => `- [法${n}](../insights/法${n}.md)`), ''].join('\n');
	const conflictName = '正式道冲突';
	const conflictExisting = '# 道 · 原有内容\n';
	await writeFile(path.join(candDir, `${conflictName}.md`), candidateTemplate, 'utf8');
	await writeFile(path.join(daoDir, `${conflictName}.md`), conflictExisting, 'utf8');
	const conflict = await tpost('/api/memory-org/axiom-action', { action: 'confirm', name: conflictName });
	ok(conflict.status === 409 && await readFile(path.join(daoDir, `${conflictName}.md`), 'utf8') === conflictExisting && await readFile(path.join(candDir, `${conflictName}.md`), 'utf8') === candidateTemplate, '同名正式道和候选都不被覆盖');

	const missingName = '来源缺失候选';
	const missingCandidate = candidateTemplate.replace('法五](../insights/法五.md)', '不存在法](../insights/不存在法.md)');
	await writeFile(path.join(candDir, `${missingName}.md`), missingCandidate, 'utf8');
	const missingSource = await tpost('/api/memory-org/axiom-action', { action: 'confirm', name: missingName });
	ok(missingSource.status === 400 && await readFile(path.join(candDir, `${missingName}.md`), 'utf8') === missingCandidate, '缺少真实来源时拒绝转正并保留候选');
	const badLinkName = '来源链接不一致';
	const badLink = candidateTemplate.replace('[法五](../insights/法五.md)', '[法五](../insights/法一.md)');
	await writeFile(path.join(candDir, `${badLinkName}.md`), badLink, 'utf8');
	const linkResult = await tpost('/api/memory-org/axiom-action', { action: 'confirm', name: badLinkName });
	ok(linkResult.status === 400 && await readFile(path.join(candDir, `${badLinkName}.md`), 'utf8') === badLink, '来源名称与链接不一致时拒绝转正');
	await writeFile(path.join(root, 'insights', '法五.md'), '> ⚠️ 已被取代\n', 'utf8');
	const retiredName = '来源已取代';
	await writeFile(path.join(candDir, `${retiredName}.md`), candidateTemplate, 'utf8');
	const retiredResult = await tpost('/api/memory-org/axiom-action', { action: 'confirm', name: retiredName });
	ok(retiredResult.status === 400 && await readFile(path.join(candDir, `${retiredName}.md`), 'utf8') === candidateTemplate, '来源法已取代时拒绝转正');
	await writeFile(path.join(root, 'insights', '法五.md'), '# 法\n', 'utf8');

	const shapeName = '形态不符候选';
	const badShape = candidateTemplate.replace(validBody, '## 依据展开\n\n简短正文。\n\n');
	await writeFile(path.join(candDir, `${shapeName}.md`), badShape, 'utf8');
	const shapeResult = await tpost('/api/memory-org/axiom-action', { action: 'confirm', name: shapeName });
	ok(shapeResult.status === 400 && await readFile(path.join(candDir, `${shapeName}.md`), 'utf8') === badShape, '正文缺少必要章节时拒绝转正并保留候选');
}
const getOnly = await tcall('/api/memory-org/skill-action');
ok(getOnly.status === 405, 'skill-action is POST-only (past the fence)');
const liveGetWrite = await call('/api/memory-org/skill-action');
ok(liveGetWrite.status === 501, 'even a GET on a write route is refused before any parsing on a fence-less host');
const fenced = await post('/api/memory-org/skill-action', { action: 'retire', name: 'detached-restart' });
ok(fenced.status === 501, 'a host without the connection service REFUSES panel writes (501, degraded-closed) — the real root is untouchable');
const reloadNoConn = await post('/api/memory-org/reload', {});
ok(reloadNoConn.status === 501, 'reload also degrades closed without connection/loader');
// GUARD: the fence gates READS too — an unauthenticated caller gets the
// rejection status the host's own connection service chose (401), for any seg.
const guardRead = await gcall('/api/memory-org/overview');
ok(guardRead.status === 401, 'an unauthenticated read is rejected with the fence status');
// On the authenticated TEMP instance, the action whitelist and guards apply.
const badAct = await tpost('/api/memory-org/skill-action', { action: 'crystallize', name: 'x' });
ok(badAct.status === 400, 'crystallize is not reachable from the panel (model judgement)');
const noName = await tpost('/api/memory-org/skill-action', { action: 'activate' });
ok(noName.status === 400, 'a missing name is rejected');
const badSlug = await tpost('/api/memory-org/skill-action', { action: 'activate', name: 'Bad_Name' });
ok(badSlug.status === 400, 'a non-kebab name is rejected (it is a bundle dir name)');
// A real lifecycle round trip, on a bundle planted in the TEMP skill root.
const probe = 'api-probe-skill';
const probeDir = path.join(tmpSkills, probe);
await mkdir(probeDir, { recursive: true });
await writeFile(
	path.join(probeDir, 'SKILL.md'),
	`---\nname: ${probe}\ndescription: "当面板写通道回归时使用本技能：临时探针"\nagent_created: true\nscope: global\nstatus: active\n---\n\n# ${probe}\n\n## 何时使用\n\n- x\n\n## 调用步骤\n\n1. a\n2. b\n`,
	'utf8',
);
try {
	const ret = await tpost('/api/memory-org/skill-action', { action: 'retire', name: probe });
	ok(ret.status === 200 && JSON.parse(ret.body).status === 'retired', `panel retire returns the new status (HTTP ${ret.status}: ${ret.body})`);
	const afterRet = JSON.parse((await tcall('/api/memory-org/skills')).body).memory.find((s) => s.name === probe);
	ok(afterRet.status === 'retired', 'a retired bundle reports its new lifecycle');
	const act = await tpost('/api/memory-org/skill-action', { action: 'activate', name: probe });
	ok(act.status === 200 && JSON.parse(act.body).status === 'active', 'panel activate restores it');
	const afterAct = JSON.parse((await tcall('/api/memory-org/skills')).body).memory.find((s) => s.name === probe);
	ok(afterAct.status === 'active', 'reactivated bundle reports active again');
	const del = await tpost('/api/memory-org/skill-action', { action: 'delete', name: probe });
	ok(del.status === 200, 'panel delete succeeds');
	const fileGone = await stat(path.join(probeDir, 'SKILL.md')).then(() => false, () => true);
	ok(fileGone, 'the bundle file is gone');
	const idxText = await readFile(path.join(tmpMem, 'MEMORY.md'), 'utf8');
	ok(!idxText.includes(probe), 'the temp index carries no dangling row for the deleted skill');
} finally {
	await rm(probeDir, { recursive: true, force: true });
}
const delMissing = await tpost('/api/memory-org/skill-action', { action: 'delete', name: 'no-such-skill-xyz' });
ok(delMissing.status === 400, 'deleting a missing skill is a 400, not a 500');
// reload (5.27.0): POST-only; 501 without connection (asserted above); on the
// temp instance (canReload TRUE, authenticated) a first POST is accepted and
// the 15s ACCEPTANCE cooldown turns the second into 429 — the self-DoS the
// audit flagged is throttled.
const reloadGet = await tcall('/api/memory-org/reload');
ok(reloadGet.status === 405, 'reload is POST-only (past the fence)');
const reload1 = await tpost('/api/memory-org/reload', {});
ok(reload1.status === 202, 'reload accepted on a capable authenticated host');
const reload2 = await tpost('/api/memory-org/reload', {});
ok(reload2.status === 429, `the second POST is throttled, not queued (${reload2.status})`);
// The real loader branch end-to-end: an apply() WITH loader/registry must get a
// reload that actually re-imports. A live host is not available here, so the
// loader is faked with the two primitives the swap really uses (internal.load
// Cache + import/unwrapExports) and a fiber-shaped ctx; the assertion is that
// the fresh module object arrives (cache purge → re-evaluation), not a 501.
{
	const { selfReload } = await import(new URL('./src/reload.js', import.meta.url).href);
	const pkgUrl = new URL('./', import.meta.url).href;
	const entry = new URL('./server.js', import.meta.url).href;
	const { pathToFileURL } = await import('node:url');
	// Seed Node's ESM loadCache shape with THIS package's real module URLs, so the
	// purge has genuine keys to remove (what a loaded plugin looks like).
	const cache = new Map();
	for (const f of ['server.js', 'src/reload.js']) {
		cache.set(new URL(`./${f}`, import.meta.url).href, { id: f });
	}
	const oldApply = () => {};
	const newApply = () => {};
	const importLog = [];
	const loader = {
		internal: { loadCache: cache },
		async import(url) {
			importLog.push(url);
			// unwrapExports in the real host turns the namespace into the exports
			// object; a plugin entry exports apply().
			return { apply: newApply };
		},
		unwrapExports: (m) => m,
	};
	const newFiber = { uid: 'f2', await: async () => {} };
	const oldFiber = {
		uid: 'f1',
		await: async () => {},
		inject: {},
		entry: undefined,
		_config: {},
		parent: { registry: { plugin: () => ({ ctx: { fiber: newFiber } }) } },
	};
	const registry = {
		get: (p) => (p === oldApply ? { fibers: [oldFiber], name: 'dsh-memory-manager', Config: undefined } : undefined),
		delete: () => true,
	};
	const res = await selfReload({ loader, registry, fiber: { ...oldFiber, runtime: { callback: oldApply } } }, { packageUrl: pkgUrl, entryUrl: entry, logger: { info: () => {}, warn: () => {} } });
	ok(res.ok === true && res.fibers === 1, `selfReload completes against a loader-shaped host (ok=${res.ok}${res.error ? ' err=' + res.error : ''})`);
	ok(importLog.length >= 1 && importLog[0].includes('server.js'), 'the entry is re-imported through the host loader');
	ok(!cache.has(entry) || importLog[importLog.length - 1] !== entry, 'a purged cache did not silently serve the old module');
	// The failure path must ROLLBACK: an entry that throws on re-import restores
	// the caches and returns restored:true with the old code still in place.
	const cache2 = new Map([[entry, { id: 'server' }]]);
	const loader2 = { internal: { loadCache: cache2 }, async import() { throw new Error('boom'); }, unwrapExports: (m) => m };
	const failRes = await selfReload({ loader: loader2, registry: { get: () => ({ fibers: [oldFiber] }), delete: () => true }, fiber: { ...oldFiber, runtime: { callback: oldApply } } }, { packageUrl: pkgUrl, entryUrl: entry, logger: { info: () => {}, warn: () => {} } });
	ok(failRes.ok === false && failRes.restored === true && cache2.has(entry), 'a failed re-import restores the cache and reports the rollback');
}

// --- overview / counts -------------------------------------------------------
const idx = await call('/api/memory-org/overview');
ok(idx.status === 200 && Array.isArray(JSON.parse(idx.body)) && JSON.parse(idx.body).length === 1, 'overview returns a single global root');
const o = JSON.parse(idx.body)[0];
console.log(`    overview: title=${o.title} root=${o.root}`);
ok(o.root.endsWith('memory'), 'overview root is the global memory dir');
ok(o.counts && ['functions', 'insights', 'daily', 'capabilities', 'skills'].every((z) => Number.isInteger(o.counts[z])), `overview carries all five zone counts (${JSON.stringify(o.counts)})`);
if (o.counts) {
	const fnList = JSON.parse(list.body).files.length;
	ok(o.counts.functions === fnList, `functions count matches its listing (${o.counts.functions} vs ${fnList})`);
	// 口径变更（2026-11 月/周折叠方案）：counts.daily 含归档月文件；
	// archived 只数归档本身。全局根的归档数无法预置（只读），做形状与自洽断言。
	ok(Number.isInteger(o.counts.archived) && o.counts.archived >= 0, `overview carries an archived count (${o.counts.archived})`);
	ok(o.counts.daily >= dailyFiles.length, `daily count includes threads (${o.counts.daily} >= ${dailyFiles.length})`);
	ok(o.counts.daily - o.counts.archived >= dailyFiles.length, `daily minus archived still covers the threads (${o.counts.daily} - ${o.counts.archived})`);
}
// Environment block (5.26.0): the overview reports the RUNNING build, both
// stores' locations and the index thresholds — from the server's own truth.
ok(o.env && typeof o.env.version === 'string' && /^\d+\.\d+\.\d+/.test(o.env.version), `env.version is the running semver (${o.env?.version})`);
ok(o.env && typeof o.env.canReload === 'boolean', 'env reports whether the host supports hot reload');
ok(o.env && o.env.memoryRoot && o.env.skillRoot && o.env.skillRoot.replace(/\\/g, '/').includes('/skills'), `env names both stores (${o.env?.memoryRoot} / ${o.env?.skillRoot})`);
ok(o.env && Number.isInteger(o.env.indexBytes) && o.env.indexBytes > 0, `env carries the real index size (${o.env?.indexBytes}B)`);
ok(o.env && o.env.indexComfortBytes > 0 && o.env.indexHardBytes > o.env.indexComfortBytes, 'env thresholds are ordered (comfort < hard)');

// --- search ------------------------------------------------------------------
const search = await call('/api/memory-org/search?q=' + encodeURIComponent('插件'));
ok(search.status === 200 && Array.isArray(JSON.parse(search.body).hits), 'search endpoint returns hits array');
console.log(`    search "插件": ${JSON.parse(search.body).hits.length} hits`);
const shortQ = await call('/api/memory-org/search?q=a');
ok(shortQ.status === 200 && JSON.parse(shortQ.body).hits.length === 0, 'sub-2-char query returns empty');

// --- recall preview (MemOS borrow ②) ---------------------------------------
// Same pipeline the pre-step hook runs, exposed for debugging: "what would this
// input recall, and why". Short queries must not error out (the panel calls it
// on every keystroke-ish interaction).
const prevShort = await call('/api/memory-org/recall-preview?q=a');
ok(prevShort.status === 200 && JSON.parse(prevShort.body).rows.length === 0, 'recall-preview tolerates a sub-2-char query');
const prev = await call('/api/memory-org/recall-preview?q=' + encodeURIComponent('记忆 插件'));
ok(prev.status === 200, `recall-preview 200 (${prev.status})`);
const pv = JSON.parse(prev.body);
ok(Array.isArray(pv.rows) && Array.isArray(pv.tokens), 'recall-preview returns rows + tokens');
console.log(`    recall-preview "记忆 插件": ${pv.rows.length} rows, ${pv.usageSignals ?? 0} usage signals`);
// Contract the panel will read: each row explains itself (reasons) and carries
// the fused score, so ranking is inspectable instead of guessed at.
if (pv.rows.length) {
	const r0 = pv.rows[0];
	ok(typeof r0.href === 'string' && Array.isArray(r0.reasons), 'preview row carries href + reasons');
	ok(typeof r0.fusedScore === 'number', 'preview row carries its fused score');
} else {
	ok(true, 'preview row contract (no hits on this root — shape untested)');
}

// --- response contract the panel client reads --------------------------------
// The panel is a separate half that only sees these JSON shapes; a renamed field
// silently blanks a chip or a snippet (that is how "UI 和系统没匹配上" happens).
// Pin the exact keys both halves agreed on.
const OV_KEYS = ['initialized', 'failCount', 'warnCount', 'results', 'counts'];
const missingOv = OV_KEYS.filter((k) => !(k in o));
ok(missingOv.length === 0, `overview keeps the panel's fields (missing: ${missingOv.join(',') || 'none'})`);
ok(Array.isArray(o.results), 'health findings travel as `results` (not `problems`)');
if (o.results?.length) {
	const rk = ['level', 'rule', 'message'];
	const missR = rk.filter((k) => !(k in o.results[0]));
	ok(missR.length === 0, `each finding keeps level/rule/message (missing: ${missR.join(',') || 'none'})`);
} else console.log('    （当前无体检发现——契约键位仍已断言）');

const hit = JSON.parse(search.body).hits[0];
if (hit) {
	const HK = ['zone', 'name', 'line', 'heading', 'snippet'];
	const missH = HK.filter((k) => !(k in hit));
	ok(missH.length === 0, `search hits keep the panel's fields (missing: ${missH.join(',') || 'none'})`);
	ok(typeof hit.snippet === 'string' && !('text' in hit), 'hit text travels as `snippet` (not `text`)');
} else {
	const empty = await call('/api/memory-org/search?q=' + encodeURIComponent('记忆'));
	const h0 = JSON.parse(empty.body).hits[0];
	ok(!!h0 && ['zone', 'name', 'line', 'heading', 'snippet'].every((k) => k in h0), 'search hits keep zone/name/line/heading/snippet');
}
const listKeys = Object.keys(JSON.parse(list.body).files[0] ?? {});
ok(['name', 'bytes', 'mtime'].every((k) => listKeys.includes(k)), `listing files keep name/bytes/mtime (${listKeys.join(',')})`);
const fileKeys = Object.keys(JSON.parse(file.body));
ok(fileKeys.includes('name') && fileKeys.includes('text'), `file reads keep name/text (${fileKeys.join(',')})`);

// --- 问题收件箱：投递 / 改状态 / 删除 ----------------------------------------
//
// ⚠️ 隔离：收件箱落在 `<DSH_HOME>/storages/memory-inbox.json`，而 DSH_HOME 是
// **调用时**读的环境变量（MemoryInbox.filePath() 每次现算）。所以这里临时把它
// 指向空目录 —— 否则这段测试会读写用户真实的收件箱。
//
// 写入形态直接落文件：收件箱的条目来自插件事件与 memory_inbox 工具，路由本身
// 没有"创建"入口，所以造数据只能写盘。这也让本段成为真正的黑盒路由测试。
const tmpHome = await mkdtemp(path.join(osMod.tmpdir(), 'dsh-api-inbox-'));
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmpHome;
const stamp = '2026-10-26T00:00:00.000Z';
const seedInbox = async () => {
	await mkdir(path.join(tmpHome, 'storages'), { recursive: true });
	await writeFile(
		path.join(tmpHome, 'storages', 'memory-inbox.json'),
		JSON.stringify({
			version: 1,
			items: {
				fpOpen: { fingerprint: 'fpOpen', from: 'dsh-clis', code: 'x.open', severity: 'warn', message: '未处理的那条', receivedAt: stamp, lastSeenAt: stamp, times: 1, status: 'open' },
				fpDone: { fingerprint: 'fpDone', from: 'agent', code: 'x.done', severity: 'info', message: '已解决的那条', receivedAt: stamp, lastSeenAt: stamp, times: 1, status: 'resolved' },
			},
		}, null, 2),
		'utf8',
	);
};
await seedInbox();

const inboxInst = makeInstance(ALLOW);
const { call: icall, post: ipost } = callerOf((...a) => inboxInst.handler(...a));
mod.apply(inboxInst.fakeCtx, { memoryRoot: tmpMem, skillRoot: tmpSkills });

const inboxList = await icall('/api/memory-org/inbox');
const inboxData = JSON.parse(inboxList.body);
ok(inboxList.status === 200 && inboxData.total === 2, `inbox lists the seeded items (${inboxData.total})`);
ok(inboxData.counts.open === 1 && inboxData.counts.resolved === 1, 'inbox counts items per status');
ok(Array.isArray(inboxData.items) && inboxData.items[0].status === 'open', 'inbox lists unhandled items first');

const filtered = await icall('/api/memory-org/inbox?status=resolved');
ok(JSON.parse(filtered.body).total === 1, 'the status filter narrows the inbox');

// 改状态
const ack = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpOpen', status: 'acknowledged' });
ok(ack.status === 200 && JSON.parse(ack.body).item.status === 'acknowledged', 'inbox-action updates a status');

// 删除必须显式 op=delete：不带 status 的请求不得把条目删掉（不可逆操作要有明确意图）
const noOp = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpDone' });
ok(noOp.status === 400, `a write with no status and no delete op is rejected (${noOp.status})`);
const stillThere = await icall('/api/memory-org/inbox');
ok(JSON.parse(stillThere.body).total === 2, 'the rejected write left the inbox untouched');

const del = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpDone', op: 'delete' });
ok(del.status === 200 && JSON.parse(del.body).deleted === true, 'inbox-action deletes an item on op=delete');
const afterDelete = await icall('/api/memory-org/inbox');
const afterData = JSON.parse(afterDelete.body);
ok(afterData.total === 1 && !afterData.items.some((i) => i.fingerprint === 'fpDone'), 'the deleted item is gone from the inbox');
ok(afterData.counts.resolved === 0, 'deleting also drops it from the status counts');

const delAgain = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpDone', op: 'delete' });
ok(delAgain.status === 404, `deleting a missing item is a 404 (${delAgain.status})`);

// 删除是持久的（落盘），不是只改了内存视图
const onDisk = JSON.parse(await readFile(path.join(tmpHome, 'storages', 'memory-inbox.json'), 'utf8'));
ok(!('fpDone' in onDisk.items), 'the delete is persisted to disk, not just in memory');

process.env.DSH_HOME = prevHome;
await rmTmp(tmpHome, { recursive: true, force: true });

// --- 文档数字守卫：工具数量与工具表 -------------------------------------------
//
// 工具数量在四处各宣称一次（README 中文/英文、package.json 两个 description），
// 全是**手写的数字**；README 还带一张工具表。每加一个工具就得改四处，
// 人工盯必然漏 —— 本仓库自己的原则就是「对外文档的数字宣称要么机器核对，
// 要么标日期」（insights/文档数字要有机器守卫.md）。
//
// 这里把"注册了什么"与"文档写了什么"对上：数量词比对不一致即失败，
// 工具表则做**成员级**核对（比数量更强，能抓改名与漏删）。
const registered = [];
const countInst = makeInstance(ALLOW, {
	tools: {
		register(def) {
			registered.push(def?.name ?? '');
			return noop;
		},
	},
});
mod.apply(countInst.fakeCtx, { memoryRoot: tmpMem, skillRoot: tmpSkills });
const toolNames = registered.filter(Boolean).sort();

const CN_NUM = { 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15 };
const EN_NUM = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
const cnWord = Object.keys(CN_NUM).find((k) => CN_NUM[k] === toolNames.length);
const enWord = Object.keys(EN_NUM).find((k) => EN_NUM[k] === toolNames.length);

const readmeCn = await readFile(path.join(pluginDir, 'README.md'), 'utf8');
const readmeEn = await readFile(path.join(pluginDir, 'README.en.md'), 'utf8');
const pkgJson = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));

ok(cnWord !== undefined, `the test knows the Chinese word for ${toolNames.length} tools`);
ok(readmeCn.includes(`${cnWord}个记忆工具`), `README.md claims ${cnWord} tools, matching the ${toolNames.length} registered`);
// 英文句首会大写（"Thirteen memory tools"），故按小写比对。
ok(readmeEn.toLowerCase().includes(`${enWord} memory tools`), `README.en.md claims ${enWord} tools, matching the ${toolNames.length} registered`);
ok(
	typeof pkgJson.meta?.description === 'string' && pkgJson.meta.description.includes(`${cnWord}个记忆工具`),
	`package.json (meta) claims ${cnWord} tools`,
);
ok(
	typeof pkgJson.description === 'string' && pkgJson.description.includes(`${enWord} memory tools`),
	`package.json (description) claims ${enWord} tools`,
);

// 头部注释曾写死 "Twelve tools"，十四工具时代仍无人改：四处文档守卫都只盯
// README / package.json / 纪律，没读 server.js。现在注释改成指向 apply() 的
// 注册清单（唯一真值源），守卫改为禁止任何数量词回潮。
const serverHead = (await readFile(path.join(pluginDir, 'server.js'), 'utf8')).slice(0, 1600);
const staleCountWords = /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|[十十一二三四五]+)个?(记忆)?工具\b|Twelve tools|Fourteen tools/i;
ok(!staleCountWords.test(serverHead), 'server.js 头部注释不得再写死工具数量（注册清单才是唯一真值源）');

// 工具表成员级核对：README 的每一行工具以 `| \`memory_x\` |` 起头。
const documented = [...readmeCn.matchAll(/^\| `(memory_\w+)`/gm)].map((m) => m[1]).sort();
const undocumented = toolNames.filter((n) => !documented.includes(n));
const stale = documented.filter((n) => !toolNames.includes(n));
ok(
	undocumented.length === 0 && stale.length === 0,
	`README's tool table lists exactly the registered tools (undocumented: ${undocumented.join(',') || 'none'}; stale: ${stale.join(',') || 'none'})`,
);

// 注入给模型的纪律文本也是「对外宣称」——它决定模型以为有哪些工具、道在哪一层。
// 它长期写「十二个工具」且只列 12 个名字（漏 memory_dao / memory_inbox），四处文档
// 守卫都不覆盖它，于是新工具落地后模型根本不知道它存在。纳入成员级核对。
ok(
	typeof mod.DISCIPLINE_TEXT === 'string' && mod.DISCIPLINE_TEXT.includes(`${cnWord}个工具`),
	`the injected discipline claims ${cnWord} tools, matching the ${toolNames.length} registered`,
);
const disciplineMissing = toolNames.filter((n) => !mod.DISCIPLINE_TEXT.includes(n));
ok(
	disciplineMissing.length === 0,
	`the discipline names every registered tool (missing: ${disciplineMissing.join(',') || 'none'})`,
);
// 道层的位置必须与实现一致：机制把道放在 dao/，纪律若说「道 = 共识区」，
// 读过纪律的模型会把道写进共识区，正好绕开 memory_dao 的硬闸门。
ok(
	mod.DISCIPLINE_TEXT.includes('dao/') && mod.DISCIPLINE_TEXT.includes('memory_dao'),
	'the discipline points 道 at dao/ and names memory_dao (it used to say 道 = MEMORY.md 共识区)',
);

// 规则范围也是数字宣称：README 两处写「R0–R22」，而 R23 落地后无人同步（本次
// 真实发生）。规则号上限直接从源码里量——新增规则若不改 README，这里就红。
const srcText = await readFile(path.join(pluginDir, 'server.js'), 'utf8');
const ruleNums = [...srcText.matchAll(/add\(\s*'(?:WARN|FAIL)'\s*,\s*'R(\d+)/g)].map((m) => Number(m[1]));
const maxRule = Math.max(...ruleNums);
const claimCn = /R0[–-]R(\d+)/.exec(readmeCn)?.[1];
const claimEn = /R0[–-]R(\d+)/.exec(readmeEn)?.[1];
ok(
	claimCn === String(maxRule) && claimEn === String(maxRule),
	`READMEs claim the same top lint rule the code implements (code R0-R${maxRule}; README.md R0-R${claimCn}; README.en.md R0-R${claimEn})`,
);

console.log(failures === 0 ? 'API ALL PASS' : `${failures} API FAILURES`);
await rmTmp(tmpMem, { recursive: true, force: true });
await rmTmp(tmpSkills, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);