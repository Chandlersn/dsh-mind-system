// Consolidated regression for the temporary safe-delete / safe-rename pause.
//
// A cross-process lost-update race was reproduced against the path-based delete
// (read then unlink). Every destructive entry point now refuses AFTER its
// read-only validation and BEFORE its first side effect, with a stable code:
//   memory_rename (rename and merge)            -> safe_rename_unavailable
//   POST /api/memory-org/axiom-action delete    -> safe_delete_unavailable
//   POST /api/memory-org/axiom-action reject    -> safe_delete_unavailable
//   POST /api/memory-org/axiom-action confirm   -> safe_delete_unavailable
//   POST /api/memory-org/dao-action delete      -> safe_delete_unavailable (503)
//   memory_skill delete (tool and panel route)  -> safe_delete_unavailable
//
// The assertions below are deliberately strict: for each entry point the call
// must reject with the exact code AND leave a byte-identical recursive snapshot
// of the whole temporary root (file bytes plus the full directory set), so no
// archive, staging directory, mkdir or ledger append can have happened.
//
// The HTTP routes run through the real registered handler with a synthetic
// authenticating connection, exactly like the other panel suites. Every data
// root lives below its own mkdtemp directory; the real ~/.dsh is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Markdown body accepted by the dao body-shape gate (三种形态 / 依据展开 / 边界).
const VALID_DAO_BODY = [
	'## 三种形态', '',
	'- 一种：自证。',
	'- 两种：外物。', '',
	'## 依据展开', '',
	'这几条法共同指向同一件事，因此合起来成为一条道。', '',
	'## 边界', '',
	'- 当产出者不在回路之内时，此判据不成立。', '',
].join('\n');

const PROPOSITION = '秩序与混乱会互相转化，各自演化出不同的结构';
const SOURCE_NAMES = ['一', '二', '三', '四', '五'];

function candidateText(title) {
	return [
		`# 候选公理 · ${title}`, '',
		'## 命题', '',
		PROPOSITION, '',
		VALID_DAO_BODY,
		'## 来源法', '',
		...SOURCE_NAMES.map((n) => `- [法${n}](../insights/法${n}.md)`), '',
	].join('\n');
}

const SKILL_FIXTURE = (name) => `---\nname: ${name}\ndescription: "当暂停守卫回归时使用本技能：临时探针"\nagent_created: true\nscope: global\nstatus: active\n---\n\n# ${name}\n\n## 何时使用\n\n- x\n\n## 调用步骤\n\n1. a\n2. b\n`;

// Byte-level recursive snapshot: file bytes keyed by relative path, plus every
// directory path. A new archive directory, staging directory or rewritten byte
// makes the two snapshots differ.
async function snapshot(root) {
	const files = new Map();
	const dirs = [];
	const walk = async (current) => {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const full = path.join(current, entry.name);
			const rel = path.relative(root, full).split(path.sep).join('/');
			if (entry.isDirectory()) {
				dirs.push(rel);
				await walk(full);
			} else if (entry.isFile()) {
				files.set(rel, await readFile(full));
			} else {
				files.set(rel, `special:${entry.isSymbolicLink() ? 'link' : 'other'}`);
			}
		}
	};
	await walk(root);
	return { dirs: dirs.sort(), files };
}

// Runs `action` between two snapshots and proves nothing on disk changed.
async function assertNoSideEffect(root, action) {
	const before = await snapshot(root);
	const result = await action();
	const after = await snapshot(root);
	assert.deepEqual(after.dirs, before.dirs, 'no directory may be created, archived or staged');
	assert.deepEqual([...after.files.keys()].sort(), [...before.files.keys()].sort(), 'no file may appear or disappear');
	for (const [rel, bytes] of before.files) {
		assert.deepEqual(after.files.get(rel), bytes, `${rel} must stay byte-identical`);
	}
	// Spelled out for the paths the paused implementations used to create first.
	for (const rel of ['memory/dao/_deleted', 'memory/dao/_candidates/_rejected', 'memory/.stage', 'memory/functions/_deleted']) {
		assert.ok(!after.dirs.includes(rel), `${rel} must not exist after a paused call`);
	}
	return result;
}

// One isolated home per case: memory root, skill root and the panel handler all
// resolve below it. Returns the real tool executors and the real HTTP route.
async function fixture(t) {
	const home = await mkdtemp(path.join(tmpdir(), 'destructive-entry-pause-'));
	const root = path.join(home, 'memory');
	const skills = path.join(home, 'skills');
	const previousHome = process.env.DSH_HOME;
	await mkdir(path.join(root, 'functions'), { recursive: true });
	await mkdir(path.join(root, 'insights'), { recursive: true });
	await mkdir(path.join(root, 'dao', '_candidates'), { recursive: true });
	await mkdir(skills, { recursive: true });
	await writeFile(path.join(root, 'MEMORY.md'), '# 隔离测试索引\n', 'utf8');
	for (const n of SOURCE_NAMES) await writeFile(path.join(root, 'insights', `法${n}.md`), '# 法\n', 'utf8');
	process.env.DSH_HOME = home;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
		assert.ok(path.basename(home).startsWith('destructive-entry-pause-'));
		await rm(home, { recursive: true, force: true });
	});

	const tools = new Map();
	let route;
	let authCalls = 0;
	const noop = () => {};
	const ctx = {
		tools: { register: (definition) => { tools.set(definition.name, definition); return noop; } },
		on: () => noop,
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
		inject(_names, callback) {
			callback({
				webServer: { register(r) { if (r.path === '/api/memory-org') route = r.handler; return noop; } },
				connection: { requestRejection() { authCalls++; return undefined; } },
				effect: (f) => f(),
			});
		},
	};
	const mod = await import('../server.js');
	const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
	if (typeof dispose === 'function') t.after(() => dispose());
	assert.equal(typeof route, 'function', 'the real panel route must be registered');
	const rename = tools.get('memory_rename');
	const skill = tools.get('memory_skill');
	assert.ok(rename?.execute, 'the real memory_rename executor must be registered');
	assert.ok(skill?.execute, 'the real memory_skill executor must be registered');

	// Drive the registered handler exactly as the panel does: a POST with a JSON
	// body, authenticated by the injected connection service.
	async function tpost(url, body) {
		const bytes = Buffer.from(JSON.stringify(body), 'utf8');
		const req = { method: 'POST', url, async *[Symbol.asyncIterator]() { yield bytes; } };
		let status;
		let payload;
		const res = { writeHead(code) { status = code; }, end(value) { payload = value; } };
		await route(req, res);
		assert.equal(authCalls > 0, true, 'the registered route authentication gate must run');
		return { status, body: JSON.parse(payload) };
	}
	return { home, root, skills, rename, skill, tpost };
}

// ---- 1) memory_rename: rename and merge --------------------------------

test('memory_rename 改名 pauses before any write and leaves the root byte-identical', async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.root, 'functions', '来源.md'), '# 来源\n\n## [2026-11-01] 来源记录\n\n- 来源内容。\n', 'utf8');
	await writeFile(path.join(f.root, 'functions', '引用.md'), '# 引用\n\n[来源](来源.md) 不得被改写。\n', 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.rename.execute({ from: '来源', to: '目标' }, {}).then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error }),
	));
	assert.equal(result.ok, false, 'a valid rename must be refused');
	assert.equal(result.error.code, 'safe_rename_unavailable');
	assert.match(result.error.message, /memory_rename 改名/);
	// Concretely: the source is still present, the target was never created.
	assert.deepEqual(await readFile(path.join(f.root, 'functions', '来源.md')), Buffer.from('# 来源\n\n## [2026-11-01] 来源记录\n\n- 来源内容。\n'));
	await assert.rejects(readFile(path.join(f.root, 'functions', '目标.md')), { code: 'ENOENT' }, 'no target may be created');
	assert.equal(await readFile(path.join(f.root, 'functions', '引用.md'), 'utf8'), '# 引用\n\n[来源](来源.md) 不得被改写。\n');
});

test('memory_rename 合并 pauses before any write and leaves the root byte-identical', async (t) => {
	const f = await fixture(t);
	const sourceText = '# 来源\n\n## 早期演化（1 块已折叠）\n\n- [2026-10-18] 早期结论\n';
	const targetText = '# 目标\n\n## [2026-11-10] 目标迭代\n\n- 目标原有结论。\n';
	await writeFile(path.join(f.root, 'functions', '来源.md'), sourceText, 'utf8');
	await writeFile(path.join(f.root, 'functions', '目标.md'), targetText, 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.rename.execute({ from: '来源', to: '目标' }, {}).then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error }),
	));
	assert.equal(result.ok, false, 'a valid merge must be refused');
	assert.equal(result.error.code, 'safe_rename_unavailable');
	assert.match(result.error.message, /memory_rename 合并/);
	assert.equal(await readFile(path.join(f.root, 'functions', '来源.md'), 'utf8'), sourceText, 'the source must survive');
	assert.equal(await readFile(path.join(f.root, 'functions', '目标.md'), 'utf8'), targetText, 'the target must be untouched');
});

// ---- 2/3/4) POST /api/memory-org/axiom-action --------------------------

test('axiom-action delete pauses at HTTP 500 and leaves the root byte-identical', async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.root, 'dao', '_candidates', '测试候选.md'), '## 命题\n\n误写的候选。\n', 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.tpost('/api/memory-org/axiom-action', { action: 'delete', name: '测试候选' }));
	assert.equal(result.status, 500, JSON.stringify(result.body));
	assert.match(String(result.body.error), /safe_delete_unavailable/);
	assert.match(String(result.body.error), /axiom-action:delete/);
	assert.equal(await readFile(path.join(f.root, 'dao', '_candidates', '测试候选.md'), 'utf8'), '## 命题\n\n误写的候选。\n');
});

test('axiom-action reject pauses at HTTP 500 and leaves the root byte-identical', async (t) => {
	const f = await fixture(t);
	const text = candidateText('暂停候选');
	await writeFile(path.join(f.root, 'dao', '_candidates', '暂停候选.md'), text, 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.tpost('/api/memory-org/axiom-action', { action: 'reject', name: '暂停候选', reason: '隔离反例' }));
	assert.equal(result.status, 500, JSON.stringify(result.body));
	assert.match(String(result.body.error), /safe_delete_unavailable/);
	assert.match(String(result.body.error), /axiom-action:reject/);
	assert.equal(await readFile(path.join(f.root, 'dao', '_candidates', '暂停候选.md'), 'utf8'), text, 'the candidate must survive');
});

test('axiom-action confirm pauses at HTTP 500 and leaves the root byte-identical', async (t) => {
	const f = await fixture(t);
	const text = candidateText('转正候选');
	await writeFile(path.join(f.root, 'dao', '_candidates', '转正候选.md'), text, 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.tpost('/api/memory-org/axiom-action', { action: 'confirm', name: '转正候选' }));
	assert.equal(result.status, 500, JSON.stringify(result.body));
	assert.match(String(result.body.error), /safe_delete_unavailable/);
	assert.match(String(result.body.error), /axiom-action:confirm/);
	assert.equal(await readFile(path.join(f.root, 'dao', '_candidates', '转正候选.md'), 'utf8'), text, 'the candidate must survive');
	await assert.rejects(readFile(path.join(f.root, 'dao', '转正候选.md')), { code: 'ENOENT' }, 'no formal dao may be created');
});

// ---- 5) POST /api/memory-org/dao-action delete -------------------------

test('dao-action delete pauses before writing', async (t) => {
	const f = await fixture(t);
	const text = '# dao source\n';
	await writeFile(path.join(f.root, 'dao', 'pause.md'), text, 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.tpost('/api/memory-org/dao-action', { action: 'delete', name: 'pause' }));
	assert.equal(result.status, 503);
	assert.equal(result.body.code, 'safe_delete_unavailable');
});

test('dao-action delete succeeds via rename-first, archives bytes and removes the source', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
	const f = await fixture(t);
	const text = '# 道 · 暂停正式道\n\n## 命题\n\n一条会被安全删除的正式道。\n';
	await writeFile(path.join(f.root, 'dao', '暂停正式道.md'), text, 'utf8');
	// Unlike the five paused entry points, this one is now allowed to mutate
	// disk: assert the concrete success contract instead of a no-op snapshot.
	const result = await f.tpost('/api/memory-org/dao-action', { action: 'delete', name: '暂停正式道' });
	assert.equal(result.status, 200, JSON.stringify(result.body));
	assert.match(result.body.message, /已删除道/);
	assert.equal(result.body.archived, 'dao/_deleted/暂停正式道.md');
	await assert.rejects(readFile(path.join(f.root, 'dao', '暂停正式道.md'), 'utf8'), { code: 'ENOENT' }, 'the dao must be gone');
	const archived = await readFile(path.join(f.root, 'dao', '_deleted', '暂停正式道.md'), 'utf8');
	assert.ok(archived.startsWith(text.trimEnd()), 'the archived dao must preserve every original byte');
	assert.match(archived, /## 删除/);
});

// ---- 6) memory_skill delete: tool and panel route ----------------------

test('memory_skill delete pauses before removing the bundle and keeps every byte', async (t) => {
	const f = await fixture(t);
	const bundle = path.join(f.skills, 'pause-probe');
	await mkdir(bundle, { recursive: true });
	await writeFile(path.join(bundle, 'SKILL.md'), SKILL_FIXTURE('pause-probe'), 'utf8');
	await mkdir(path.join(bundle, 'scripts'), { recursive: true });
	await writeFile(path.join(bundle, 'scripts', 'run.mjs'), '// fixture\n', 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.skill.execute({ action: 'delete', name: 'pause-probe' }, {}).then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error }),
	));
	assert.equal(result.ok, false, 'a valid skill delete must be refused');
	assert.equal(result.error.code, 'safe_delete_unavailable');
	assert.match(result.error.message, /memory_skill\(delete\)/);
	assert.equal(await readFile(path.join(bundle, 'SKILL.md'), 'utf8'), SKILL_FIXTURE('pause-probe'));
	assert.equal(await readFile(path.join(bundle, 'scripts', 'run.mjs'), 'utf8'), '// fixture\n');
});

test('panel skill-action delete pauses at HTTP 400 and keeps every byte', async (t) => {
	const f = await fixture(t);
	const bundle = path.join(f.skills, 'panel-pause');
	await mkdir(bundle, { recursive: true });
	await writeFile(path.join(bundle, 'SKILL.md'), SKILL_FIXTURE('panel-pause'), 'utf8');
	const result = await assertNoSideEffect(f.home, () => f.tpost('/api/memory-org/skill-action', { action: 'delete', name: 'panel-pause' }));
	assert.equal(result.status, 400, JSON.stringify(result.body));
	assert.match(String(result.body.error), /safe_delete_unavailable/);
	assert.equal(await readFile(path.join(bundle, 'SKILL.md'), 'utf8'), SKILL_FIXTURE('panel-pause'), 'the bundle must survive');
});

// ---- invalid input keeps its original error ---------------------------

test('invalid input keeps its original error on every paused entry point', async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.root, 'functions', '来源.md'), '# 来源\n', 'utf8');
	await mkdir(path.join(f.skills, 'foreign-skill'), { recursive: true });
	await writeFile(path.join(f.skills, 'foreign-skill', 'SKILL.md'), '---\nname: foreign-skill\n---\n\n# foreign\n', 'utf8');

	// memory_rename: same path and a missing source are rejected before the guard.
	await assert.rejects(f.rename.execute({ from: '来源', to: '来源' }, {}), /同一路径/);
	await assert.rejects(f.rename.execute({ from: '不存在', to: '目标' }, {}), /不存在/);

	// axiom-action: the action whitelist and the candidate read keep their codes.
	const badAction = await f.tpost('/api/memory-org/axiom-action', { action: 'archive', name: '任意候选' });
	assert.equal(badAction.status, 400);
	assert.match(String(badAction.body.error), /action must be confirm\|reject\|delete/);
	const missingCandidate = await f.tpost('/api/memory-org/axiom-action', { action: 'delete', name: '根本没有的候选' });
	assert.equal(missingCandidate.status, 404);
	// reject without a reason is a validation error, not the pause.
	await writeFile(path.join(f.root, 'dao', '_candidates', '无理由候选.md'), candidateText('无理由候选'), 'utf8');
	const noReason = await f.tpost('/api/memory-org/axiom-action', { action: 'reject', name: '无理由候选' });
	assert.equal(noReason.status, 400);
	assert.match(String(noReason.body.error), /理由/);
	// confirm against an existing formal dao still reports the conflict.
	await writeFile(path.join(f.root, 'dao', '_candidates', '冲突候选.md'), candidateText('冲突候选'), 'utf8');
	await writeFile(path.join(f.root, 'dao', '冲突候选.md'), '# 道 · 原有内容\n', 'utf8');
	const conflict = await f.tpost('/api/memory-org/axiom-action', { action: 'confirm', name: '冲突候选' });
	assert.equal(conflict.status, 409);
	assert.match(String(conflict.body.error), /已存在/);

	// dao-action: a missing dao is still a 404, not the pause.
	const missingDao = await f.tpost('/api/memory-org/dao-action', { action: 'delete', name: '根本不存在的道' });
	assert.equal(missingDao.status, 404);

	// memory_skill delete: the kebab-case rule, the missing bundle and the
	// ownership gate all keep their own messages.
	await assert.rejects(f.skill.execute({ action: 'delete', name: 'Bad_Name' }, {}), /kebab-case/);
	await assert.rejects(f.skill.execute({ action: 'delete', name: 'no-such-skill-xyz' }, {}), /技能库里没有/);
	await assert.rejects(f.skill.execute({ action: 'delete', name: 'foreign-skill' }, {}), /agent_created/);
	const panelBadName = await f.tpost('/api/memory-org/skill-action', { action: 'delete', name: 'Bad_Name' });
	assert.equal(panelBadName.status, 400);
	assert.match(String(panelBadName.body.error), /kebab-case/);
	// The non-owned bundle must still be on disk after all refusals.
	assert.equal(await readFile(path.join(f.skills, 'foreign-skill', 'SKILL.md'), 'utf8'), '---\nname: foreign-skill\n---\n\n# foreign\n');
});
