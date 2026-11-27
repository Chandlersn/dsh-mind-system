// Rename-first daily archive protocol (5.30.0): one top-level YYYY-MM-DD.md is
// MOVED into .stage/daily-archive/ and only then merged into daily/YYYY-MM.md.
// The point of the protocol is that no live source path is ever read-then-
// unlinked, so an appender holding an open handle cannot lose bytes.
//
// Everything here runs on an isolated mkdtemp root. No real memory root, no
// build step, no live configuration is read. The concurrency test spawns a real
// independent child process (`node -e`) so the race is genuinely cross-process,
// not an in-process promise interleave.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, access,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	archiveDayRenameFirst, readArchivedDayStrict, AUTO_DAILY_ARCHIVE_ENABLED,
} from '../src/daily-archive.js';

const STAGE_REL = path.join('.stage', 'daily-archive');
const archiveFile = (root, month) => path.join(root, 'daily', `${month}.md`);
const stageDir = (root) => path.join(root, STAGE_REL);

const exists = async (file) => {
	try { await access(file); return true; } catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
		throw error;
	}
};

/** A staged file name the protocol itself would create for `date`. */
const stagedName = (date, uuid) => `${date}.${uuid ?? '11111111-2222-3333-4444-555555555555'}.moved`;

async function fixture(t, prefix = 'daily-rename-first-') {
	const root = await mkdtemp(path.join(tmpdir(), prefix));
	t.after(async () => {
		assert.equal(path.dirname(root), path.resolve(tmpdir()));
		assert.ok(path.basename(root).startsWith(prefix));
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack, needle) {
	let n = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
	return n;
}

test('the automatic scheduler stays disabled: this is a primitive, not a trigger', () => {
	// Guard against the tempting "fix": flipping the switch here would enable
	// automatic deletion of real daily logs, which is a separate decision.
	assert.equal(AUTO_DAILY_ARCHIVE_ENABLED, false);
});

test('happy path: source is renamed and merged, staging removed, neighbours untouched', async (t) => {
	const root = await fixture(t);
	const source = path.join(root, '2026-10-07.md');
	const sibling = path.join(root, '2026-10-08.md');
	await writeFile(source, '# 2026-10-07 记录\n\n## 一个主题\n\n- 第一行\n- 第二行\n', 'utf8');
	await writeFile(sibling, '# 另一天\n\n- 不要动我\n', 'utf8');

	const result = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(result.status, 'archived', JSON.stringify(result));
	assert.equal(result.ok, true);
	assert.equal(result.date, '2026-10-07');
	assert.equal(result.month, '2026-10');
	assert.equal(result.stagedRemoved, true);

	// The source entry is gone and no staging copy remains.
	assert.equal(await exists(source), false, 'source must be gone after a successful archive');
	assert.deepEqual(await readdir(stageDir(root)), [], 'staging dir must be empty after a successful archive');

	// The archive parses under the strict reader, with the source H1 stripped and
	// interior topic headings preserved verbatim.
	const archived = await readArchivedDayStrict(root, '2026-10-07');
	assert.equal(archived.status, 'found', JSON.stringify(archived));
	assert.match(archived.text, /### \[2026-10-07\]/);
	assert.match(archived.text, /## 一个主题\n\n- 第一行\n- 第二行/, archived.text);
	assert.doesNotMatch(archived.text, /# 2026-10-07 记录/, 'the source H1 is stripped, not merged');

	// The unrelated day is byte-identical, and no archive was created for it.
	assert.equal(await readFile(sibling, 'utf8'), '# 另一天\n\n- 不要动我\n');
	assert.equal(await exists(archiveFile(root, '2026-10-08')), false);

	// The archive carries a week section the strict parser accepts.
	const text = await readFile(archiveFile(root, '2026-10'), 'utf8');
	assert.match(text, /^## 周 2026-W41（10-07 ~ 10-07）$/m, text);
});

test('a second run for an already-archived day reports already_archived and appends nothing', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, '2026-10-07.md'), '- 只此一行\n', 'utf8');
	const first = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(first.status, 'archived');
	const before = await readFile(archiveFile(root, '2026-10'), 'utf8');

	// Source is gone, so there is nothing left to re-stage.
	const second = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(second.status, 'not_found', JSON.stringify(second));
	assert.equal(second.ok, false);
	assert.equal(await readFile(archiveFile(root, '2026-10'), 'utf8'), before, 'no bytes may be appended');
	assert.equal(count(before, '### [2026-10-07]'), 1);
});

test('crash recovery: a leftover staging file is merged on re-run and never duplicated', async (t) => {
	const root = await fixture(t);
	// Simulate a crash after the rename but before the merge: the source is gone
	// and its bytes sit in the staging directory.
	await mkdir(stageDir(root), { recursive: true });
	const leftover = path.join(stageDir(root), stagedName('2026-10-07'));
	await writeFile(leftover, '# 2026-10-07\n\n- 崩溃前已搬走的字节\n', 'utf8');

	const recovered = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(recovered.status, 'archived', JSON.stringify(recovered));
	assert.equal(recovered.staged, leftover, 'the leftover must be adopted, not re-created');
	assert.match((await readArchivedDayStrict(root, '2026-10-07')).text, /崩溃前已搬走的字节/);
	assert.equal(await exists(leftover), false, 'the adopted staging file is removed once merged');

	// A second run must not duplicate the day section.
	const before = await readFile(archiveFile(root, '2026-10'), 'utf8');
	const again = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(again.status, 'not_found', JSON.stringify(again));
	const after = await readFile(archiveFile(root, '2026-10'), 'utf8');
	assert.equal(after, before);
	assert.equal(count(after, '### [2026-10-07]'), 1, 'exactly one day section may survive');
});

test('crash recovery when the day is already archived: identical bytes report already_archived', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, '2026-10-07.md'), '# H1\n\n- 正文甲\n', 'utf8');
	assert.equal((await archiveDayRenameFirst(root, '2026-10-07')).status, 'archived');
	const before = await readFile(archiveFile(root, '2026-10'), 'utf8');

	// A leftover whose bytes are exactly what the archive already holds: this is
	// the "crash after merge, before staging unlink" case. It must NOT append.
	await mkdir(stageDir(root), { recursive: true });
	const leftover = path.join(stageDir(root), stagedName('2026-10-07', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
	await writeFile(leftover, '# H1\n\n- 正文甲\n', 'utf8');

	const recovered = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(recovered.status, 'already_archived', JSON.stringify(recovered));
	assert.equal(recovered.ok, true);
	const after = await readFile(archiveFile(root, '2026-10'), 'utf8');
	assert.equal(after, before, 'already_archived must not write');
	assert.equal(count(after, '### [2026-10-07]'), 1);
});

test('ambiguous: a leftover whose bytes differ from the archived section requires manual reconcile', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, '2026-10-07.md'), '- 版本甲\n', 'utf8');
	assert.equal((await archiveDayRenameFirst(root, '2026-10-07')).status, 'archived');
	const before = await readFile(archiveFile(root, '2026-10'), 'utf8');

	// Two different versions of the same day exist. Guessing which one is right
	// could drop real content, so nothing is appended and the file is kept.
	await mkdir(stageDir(root), { recursive: true });
	const leftover = path.join(stageDir(root), stagedName('2026-10-07', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'));
	await writeFile(leftover, '- 版本乙（与归档不同）\n', 'utf8');

	const result = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(result.status, 'manual_reconcile_required', JSON.stringify(result));
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'day_present_with_different_bytes');
	assert.equal(await readFile(archiveFile(root, '2026-10'), 'utf8'), before, 'nothing may be appended');
	assert.equal(count(await readFile(archiveFile(root, '2026-10'), 'utf8'), '### [2026-10-07]'), 1);
	assert.equal(await readFile(leftover, 'utf8'), '- 版本乙（与归档不同）\n', 'the disputed bytes must be preserved');
});

test('two staged copies for one day are never guessed between', async (t) => {
	const root = await fixture(t);
	await mkdir(stageDir(root), { recursive: true });
	await writeFile(path.join(stageDir(root), stagedName('2026-10-07', '11111111-1111-1111-1111-111111111111')), 'copy one\n', 'utf8');
	await writeFile(path.join(stageDir(root), stagedName('2026-10-07', '22222222-2222-2222-2222-222222222222')), 'copy two\n', 'utf8');

	const result = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(result.status, 'manual_reconcile_required', JSON.stringify(result));
	assert.equal(result.reason, 'multiple_staged_copies');
	assert.equal(Array.isArray(result.staged), true);
	assert.equal(result.staged.length, 2);
	assert.equal(await exists(archiveFile(root, '2026-10')), false, 'nothing may be written');
	assert.deepEqual((await readdir(stageDir(root))).length, 2, 'both staged copies must be preserved');
});

test('an ambiguous archive is refused without writing or moving anything', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	const ambiguous = '### [2026-10-01]\nfirst\n### [2026-10-01]\nsecond\n';
	await writeFile(archiveFile(root, '2026-10'), ambiguous, 'utf8');
	const source = path.join(root, '2026-10-07.md');
	await writeFile(source, '- 新的内容\n', 'utf8');

	const result = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(result.status, 'ambiguous_archive', JSON.stringify(result));
	assert.equal(result.ok, false);
	assert.equal(await readFile(archiveFile(root, '2026-10'), 'utf8'), ambiguous, 'the archive must not be modified');
	// The source was already renamed before the archive was inspected, so it now
	// lives in staging — that is the protocol keeping the bytes, not losing them.
	assert.equal(await exists(source), false);
	const staged = await readdir(stageDir(root));
	assert.equal(staged.length, 1, JSON.stringify(staged));
	assert.match(await readFile(path.join(stageDir(root), staged[0]), 'utf8'), /新的内容/);
});

test('invalid sources are refused: bad date, directory, symlink, missing file', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, '2026-10-07.md'), { recursive: true }); // a directory in the way

	for (const bad of ['2026-13-01', '2026-02-30', 'nonsense', '', '2026-10-7', '  ']) {
		const result = await archiveDayRenameFirst(root, bad);
		assert.equal(result.status, 'invalid_source', `${JSON.stringify(bad)} -> ${JSON.stringify(result)}`);
		assert.equal(result.reason, 'invalid_date', JSON.stringify(result.reason));
	}
	// A non-string date is a refusal, not a throw.
	assert.equal((await archiveDayRenameFirst(root, undefined)).status, 'invalid_source');
	assert.equal((await archiveDayRenameFirst(root, null)).status, 'invalid_source');

	// A directory at the source path: refused, and it is still a directory.
	const dirResult = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(dirResult.status, 'invalid_source', JSON.stringify(dirResult));
	assert.equal(dirResult.reason, 'source_not_regular_file');
	assert.equal((await stat(path.join(root, '2026-10-07.md'))).isDirectory(), true);
	assert.equal(await exists(archiveFile(root, '2026-10')), false);

	// A missing file: not_found, nothing written.
	const missing = await archiveDayRenameFirst(root, '2026-10-09');
	assert.equal(missing.status, 'not_found', JSON.stringify(missing));
	assert.equal(await exists(archiveFile(root, '2026-10')), false);

	// A symlink at the source path is refused and left in place.
	const linkDay = '2026-10-10';
	const target = path.join(root, 'real-target.txt');
	await writeFile(target, 'target bytes\n', 'utf8');
	try {
		await symlink(target, path.join(root, `${linkDay}.md`), 'file');
	} catch (error) {
		if (error?.code === 'EPERM' || error?.code === 'EACCES') {
			t.diagnostic('symlink creation not permitted; symlink refusal not exercised');
			return;
		}
		throw error;
	}
	const linkResult = await archiveDayRenameFirst(root, linkDay);
	assert.equal(linkResult.status, 'invalid_source', JSON.stringify(linkResult));
	assert.equal(linkResult.reason, 'source_is_symlink');
	assert.equal(await readFile(target, 'utf8'), 'target bytes\n');
	assert.equal(await exists(archiveFile(root, '2026-10')), false);
});

test('an invalid root is a refusal, not a throw', async () => {
	for (const bad of ['', '   ', undefined, null, 42]) {
		const result = await archiveDayRenameFirst(bad, '2026-10-07');
		assert.equal(result.status, 'invalid_source', JSON.stringify(result));
		assert.equal(result.reason, 'invalid_root');
	}
});

test('a body that would corrupt the archive structure is kept in staging instead', async (t) => {
	const root = await fixture(t);
	// A daily log that itself contains a day heading or an unclosed fence would
	// either collide with the heading this function writes (the strict parser
	// rejects duplicate days outright) or swallow the rest of the month file.
	for (const [body, reason] of [
		['### [2026-10-01]\nforeign heading\n', 'body_contains_day_heading'],
		['## 周 2026-W40（09-28 ~ 10-04）\nforeign week\n', 'body_contains_week_heading'],
		['```js\nunclosed\n', 'body_has_unclosed_fence'],
		['   \n\n', 'body_is_empty'],
	]) {
		const day = '2026-10-07';
		const source = path.join(root, `${day}.md`);
		await rm(stageDir(root), { recursive: true, force: true });
		await rm(archiveFile(root, '2026-10'), { force: true });
		await writeFile(source, body, 'utf8');

		const result = await archiveDayRenameFirst(root, day);
		assert.equal(result.status, 'manual_reconcile_required', `${reason}: ${JSON.stringify(result)}`);
		assert.equal(result.reason, reason);
		assert.equal(await exists(archiveFile(root, '2026-10')), false, `${reason}: no archive may be written`);
		const staged = await readdir(stageDir(root));
		assert.equal(staged.length, 1, `${reason}: the bytes must be preserved in staging`);
	}
});

test('a fenced heading inside the body is content, not structure', async (t) => {
	const root = await fixture(t);
	// A day heading inside a closed fence is not a heading; it must merge as text
	// and leave the archive parseable.
	await writeFile(
		path.join(root, '2026-10-07.md'),
		'- 示例：\n\n```md\n### [2026-09-01]\n```\n\n- 结束\n',
		'utf8',
	);
	const result = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(result.status, 'archived', JSON.stringify(result));
	const archived = await readArchivedDayStrict(root, '2026-10-07');
	assert.equal(archived.status, 'found', JSON.stringify(archived));
	assert.match(archived.text, /```md\n### \[2026-09-01\]\n```/);
});

test('two days in the same ISO week share one week heading, both parseable', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, '2026-10-07.md'), '- 周三\n', 'utf8');
	await writeFile(path.join(root, '2026-10-08.md'), '- 周四\n', 'utf8');
	assert.equal((await archiveDayRenameFirst(root, '2026-10-07')).status, 'archived');
	const second = await archiveDayRenameFirst(root, '2026-10-08');
	assert.equal(second.status, 'archived', JSON.stringify(second));

	const text = await readFile(archiveFile(root, '2026-10'), 'utf8');
	assert.equal((text.match(/^## 周 /gm) ?? []).length, 1, `one week heading expected: ${text}`);
	assert.equal((text.match(/^### \[/gm) ?? []).length, 2);
	assert.equal((await readArchivedDayStrict(root, '2026-10-07')).status, 'found');
	assert.equal((await readArchivedDayStrict(root, '2026-10-08')).status, 'found');
	// Same file, distinct sections: neither day swallowed the other's body.
	assert.match((await readArchivedDayStrict(root, '2026-10-07')).text, /周三/);
	assert.match((await readArchivedDayStrict(root, '2026-10-08')).text, /周四/);
});

test('an empty archive file is replaced with a header rather than appended blindly', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(archiveFile(root, '2026-10'), '', 'utf8');
	await writeFile(path.join(root, '2026-10-07.md'), '- 正文\n', 'utf8');

	const result = await archiveDayRenameFirst(root, '2026-10-07');
	assert.equal(result.status, 'archived', JSON.stringify(result));
	const text = await readFile(archiveFile(root, '2026-10'), 'utf8');
	assert.match(text, /^# 每日归档 2026-10/, JSON.stringify(text.slice(0, 40)));
	assert.equal((await readArchivedDayStrict(root, '2026-10-07')).status, 'found');
});

// ---------------------------------------------------------------------------
// Cross-process race: an independent child appends to the live source path
// while this process runs the protocol. The appended bytes must survive
// somewhere — archive or staging — and must never be lost.
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[1], source = process.argv[2], payload = process.argv[3];
fs.writeFileSync(path.join(dir, 'ready'), '');
const until = Date.now() + 15000;
while (Date.now() < until) {
	if (fs.existsSync(path.join(dir, 'go'))) break;
}
// Append through a handle opened NOW (so it targets whatever the path resolves
// to at this instant) only after the parent says go; some iterations open the
// handle before the parent's rename instead, which is the dangerous case.
let fd = null;
if (process.argv[4] === 'pre') {
	try { fd = fs.openSync(source, 'a'); } catch (e) { fs.writeFileSync(path.join(dir, 'open-error'), String(e.code)); }
}
const before = fs.existsSync(source);
try {
	if (fd === null) fs.appendFileSync(source, payload);
	else fs.writeSync(fd, Buffer.from(payload));
	if (fd !== null) fs.closeSync(fd);
	fs.writeFileSync(path.join(dir, 'done'), JSON.stringify({ existedBefore: before, mode: process.argv[4] }));
} catch (e) {
	fs.writeFileSync(path.join(dir, 'error'), String(e && e.code));
}
`;

/** Spawn the child that appends to the source path, coordinated by flag files. */
function spawnAppender(dir, source, payload, mode) {
	const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, dir, source, payload, mode], {
		stdio: 'ignore', windowsHide: true,
	});
	const done = new Promise((resolve) => {
		child.once('error', (error) => resolve({ code: null, error: String(error) }));
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	const waitFor = async (name, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await exists(path.join(dir, name))) return true;
			await new Promise((r) => setTimeout(r, 5));
		}
		return false;
	};
	return { child, done, waitFor };
}

for (const mode of ['post', 'pre']) {
	test(`concurrent appender (${mode === 'pre' ? 'handle opened before the rename' : 'opens after the rename'}) never loses its bytes`, { timeout: 120000 }, async (t) => {
		const ITERATIONS = 6;
		const root = await fixture(t, `daily-race-${mode}-`);
		const control = await mkdtemp(path.join(tmpdir(), 'daily-race-ctl-'));
		t.after(async () => {
			assert.equal(path.dirname(control), path.resolve(tmpdir()));
			await rm(control, { recursive: true, force: true });
		});

		for (let i = 0; i < ITERATIONS; i++) {
			const day = '2026-10-07';
			const month = '2026-10';
			const source = path.join(root, `${day}.md`);
			const payload = `RACE-${mode}-${i}-APPENDED\n`;
			// Reset the fixture for each iteration: one fresh day, one fresh root.
			await rm(path.join(root, 'daily'), { recursive: true, force: true });
			await rm(stageDir(root), { recursive: true, force: true });
			await rm(source, { force: true });
			for (const flag of ['ready', 'go', 'done', 'error', 'open-error']) {
				await rm(path.join(control, flag), { force: true });
			}
			await writeFile(source, `# ${day}\n\n- 原始字节 ${i}\n`, 'utf8');

			const appender = spawnAppender(control, source, payload, mode);
			const ready = await appender.waitFor('ready', 15000);
			assert.equal(ready, true, `iteration ${i}: child never became ready`);

			// Release the child immediately before the protocol reaches its rename.
			// Both orders occur across iterations, and every element is time-bounded
			// so a lost race cannot hang the suite.
			await new Promise((r) => setTimeout(r, i % 2 === 0 ? 0 : 3));
			await writeFile(path.join(control, 'go'), 'go');
			const result = await archiveDayRenameFirst(root, day);
			const outcome = await appender.done;
			assert.equal(outcome.code, 0, `iteration ${i}: child failed ${JSON.stringify(outcome)}`);

			// The appended bytes must exist somewhere: in the archive, in staging,
			// or in a fresh file re-created at the old source path (a post-rename
			// creator writes new data, which is not a loss).
			const archiveText = await exists(archiveFile(root, month)) ? await readFile(archiveFile(root, month), 'utf8') : '';
			const stagedNames = await exists(stageDir(root)) ? await readdir(stageDir(root)) : [];
			let stagedText = '';
			for (const name of stagedNames) stagedText += await readFile(path.join(stageDir(root), name), 'utf8');
			const freshText = await exists(source) ? await readFile(source, 'utf8') : '';
			const haystack = `${archiveText}\n${stagedText}\n${freshText}`;

			assert.ok(
				haystack.includes(payload.trim()),
				`iteration ${i}: appended bytes lost. status=${JSON.stringify(result)} archive=${JSON.stringify(archiveText)} staged=${JSON.stringify(stagedText)} fresh=${JSON.stringify(freshText)}`,
			);
			// The original bytes must also survive regardless of which branch ran.
			assert.ok(
				haystack.includes(`原始字节 ${i}`),
				`iteration ${i}: original bytes lost. status=${JSON.stringify(result)} archive=${JSON.stringify(archiveText)} staged=${JSON.stringify(stagedText)}`,
			);
			// Whatever the interleaving, a successful archive reports ok and leaves
			// the day parseable; a refused one reports it explicitly.
			if (result.ok) {
				const archived = await readArchivedDayStrict(root, day);
				assert.ok(archived.status === 'found' || archived.status === 'empty' || archived.status === 'missing',
					`iteration ${i}: archive must stay parseable, got ${JSON.stringify(archived)}`);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// The deterministic dangerous order.
//
// The loop above releases the child against a live protocol call, so which side
// wins is up to the scheduler. This test removes that luck: the child opens its
// handle on the real source, then the parent MOVES that source to staging, and
// only AFTER the directory entry has moved does the parent tell the child to
// write. A handle that predates the rename is exactly the case that loses bytes
// through read-then-unlink; here its bytes must land inside the staged file and
// reach the archive.
// ---------------------------------------------------------------------------

const HANDLE_CHILD = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[1], source = process.argv[2], payload = process.argv[3];
// Open the handle FIRST, before the parent renames anything.
const fd = fs.openSync(source, 'a');
fs.writeFileSync(path.join(dir, 'opened'), '');
const until = Date.now() + 15000;
while (Date.now() < until) {
	if (fs.existsSync(path.join(dir, 'go'))) break;
}
try {
	const n = fs.writeSync(fd, Buffer.from(payload));
	fs.closeSync(fd);
	fs.writeFileSync(path.join(dir, 'written'), String(n));
} catch (error) {
	fs.writeFileSync(path.join(dir, 'write-error'), String(error && error.code));
}
`;

test('a handle opened before the rename keeps writing to the moved bytes, and they reach the archive', { timeout: 30000 }, async (t) => {
	const root = await fixture(t, 'daily-handle-pre-');
	const control = await mkdtemp(path.join(tmpdir(), 'daily-handle-ctl-'));
	t.after(async () => {
		assert.equal(path.dirname(control), path.resolve(tmpdir()));
		await rm(control, { recursive: true, force: true });
	});
	const day = '2026-10-07';
	const source = path.join(root, `${day}.md`);
	const payload = 'PRE-RENAME-HANDLE-BYTES\n';
	await writeFile(source, '# 2026-10-07\n\n- 原始\n', 'utf8');

	const child = spawn(process.execPath, ['-e', HANDLE_CHILD, control, source, payload], {
		stdio: 'ignore', windowsHide: true,
	});
	const done = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
	const waitFor = async (name, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await exists(path.join(control, name))) return true;
			await new Promise((r) => setTimeout(r, 5));
		}
		return false;
	};

	assert.equal(await waitFor('opened', 15000), true, 'child must open its handle on the live source first');

	// Move the entry while the child's handle is open. On the same filesystem
	// this is atomic, and the open handle keeps pointing at the same bytes.
	const stagedPath = path.join(stageDir(root), stagedName(day, 'cccccccc-dddd-eeee-ffff-000000000000'));
	await mkdir(stageDir(root), { recursive: true });
	const { rename } = await import('node:fs/promises');
	await rename(source, stagedPath);
	assert.equal(await exists(source), false, 'the source entry must be gone after the move');

	// Only now let the child write through the pre-move handle.
	await writeFile(path.join(control, 'go'), 'go');
	assert.equal(await done, 0, 'the writing child must exit cleanly');
	assert.equal(await exists(path.join(control, 'write-error')), false,
		`the pre-rename handle must still be writable: ${await exists(path.join(control, 'write-error')) ? await readFile(path.join(control, 'write-error'), 'utf8') : ''}`);

	// The bytes went to the moved inode, not to a re-created file at the old path.
	assert.equal(await exists(source), false, 'a pre-rename handle must NOT resurrect the old path');
	assert.match(await readFile(stagedPath, 'utf8'), /PRE-RENAME-HANDLE-BYTES/, 'the append must be inside the staged file');

	// A re-run adopts the staged file (crash recovery path) and archives it.
	const recovered = await archiveDayRenameFirst(root, day);
	assert.equal(recovered.status, 'archived', JSON.stringify(recovered));
	const archived = await readArchivedDayStrict(root, day);
	assert.equal(archived.status, 'found', JSON.stringify(archived));
	assert.match(archived.text, /PRE-RENAME-HANDLE-BYTES/, `appended bytes must reach the archive: ${archived.text}`);
	assert.match(archived.text, /原始/, 'original bytes must survive too');
	assert.equal(await exists(stagedPath), false, 'staging is removed only after the archive is confirmed');
	assert.equal(count(await readFile(archiveFile(root, '2026-10'), 'utf8'), '### [2026-10-07]'), 1);
});
