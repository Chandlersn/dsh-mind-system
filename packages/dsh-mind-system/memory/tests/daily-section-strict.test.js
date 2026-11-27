import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as archive from '../src/daily-archive.js';

async function fixture(t, text) {
  const home = await mkdtemp(path.join(tmpdir(), 'daily-section-strict-'));
  const dir = path.join(home, 'daily');
  await mkdir(dir);
  const file = path.join(dir, '2026-10.md');
  if (text !== undefined) await writeFile(file, text);
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('daily-section-strict-'));
    await rm(home, { recursive: true, force: true });
  });
  return { home, file };
}

test('preserves topic headings and stops at the next day or week', async (t) => {
  const text = '# Archive\n\n## 周 2026-W40（10-01 ~ 10-02）\n\n### [2026-10-01]\n\n## Topic\nfirst\n\n### [2026-10-02]\nsecond\n\n## 周 2026-W41（10-05 ~ 10-05）\n\n### [2026-10-05]\nthird\n';
  const { home, file } = await fixture(t, text);
  const first = await archive.readArchivedDay(home, '2026-10-01');
  assert.match(first.text, /## Topic\nfirst/);
  assert.doesNotMatch(first.text, /second|third/);
  const second = await archive.readArchivedDay(home, '2026-10-02');
  assert.match(second.text, /second/);
  assert.doesNotMatch(second.text, /third|2026-W41/);
  assert.equal(await readFile(file, 'utf8'), text);
});

test('strict results distinguish empty, missing and valid sections', async (t) => {
  const { home } = await fixture(t, '### [2026-10-01]\n \n### [2026-10-02]\nnext\n');
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-01')).status, 'empty');
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-02')).status, 'found');
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-03')).status, 'missing');
});

test('ignores headings inside fenced code and rejects unterminated fences', async (t) => {
  const text = '### [2026-10-01]\n```md\n### [2026-10-02]\n## 周 2026-W41（10-05 ~ 10-05）\n```\nreal first\n### [2026-10-02]\nreal second\n';
  const { home, file } = await fixture(t, text);
  const first = await archive.readArchivedDayStrict(home, '2026-10-01');
  assert.equal(first.status, 'found');
  assert.match(first.text, /real first/);
  assert.doesNotMatch(first.text, /real second/);
  assert.match((await archive.readArchivedDayStrict(home, '2026-10-02')).text, /real second/);
  await writeFile(file, '### [2026-10-01]\n```\n### [2026-10-31]\n```\nreal first\n### [2026-10-02]\nreal second\n');
  assert.equal((await archive.latestArchivedDay(home)).date, '2026-10-02');
  await writeFile(file, '### [2026-10-01]\n```\n### [2026-10-02]\n');
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-01')).status, 'ambiguous');
});

test('duplicate and malformed day headings are ambiguous', async (t) => {
  const { home, file } = await fixture(t, '### [2026-10-01]\nfirst\n### [2026-10-01]\nsecond\n');
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-01')).status, 'ambiguous');
  assert.equal(await archive.readArchivedDay(home, '2026-10-01'), undefined);
  await writeFile(file, '### [2026-10-01]\nfirst\n### [2026-10-02] extra\nsecond\n');
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-01')).status, 'ambiguous');
});

test('archive does not confuse a fenced date with an existing day', async (t) => {
  const { home, file } = await fixture(t, '### [2026-10-01]\n```\n### [2026-10-02]\n```\n');
  const source = path.join(home, '2026-10-02.md');
  await writeFile(source, '# Daily\n\nactual second day\n');
  await utimes(source, new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
  const result = await archive.archiveDailyMonths(home, { today: '2026-11-24' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.archived.length, 1);
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-02')).status, 'found');
  assert.match(await readFile(file, 'utf8'), /actual second day/);
  await assert.rejects(readFile(source), { code: 'ENOENT' });
});

test('ambiguous archive prevents writes and preserves all source days', async (t) => {
  const archiveText = '### [2026-10-01]\nfirst\n### [2026-10-01]\nsecond\n';
  const { home, file } = await fixture(t, archiveText);
  for (const day of ['2026-10-02', '2026-10-03']) {
    const source = path.join(home, `${day}.md`);
    await writeFile(source, `source ${day}\n`);
    await utimes(source, new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
  }
  const result = await archive.archiveDailyMonths(home, { today: '2026-11-24' });
  assert.equal(result.archived.length, 0);
  assert.equal(result.errors.length, 2);
  assert.equal(await readFile(file, 'utf8'), archiveText);
  for (const day of ['2026-10-02', '2026-10-03']) assert.equal(await readFile(path.join(home, `${day}.md`), 'utf8'), `source ${day}\n`);
});

test('an ambiguous later month prevents earlier month writes', async (t) => {
  const { home, file } = await fixture(t, '### [2026-10-01]\nfirst\n### [2026-10-01]\nsecond\n');
  const september = path.join(home, '2026-09-02.md');
  const october = path.join(home, '2026-10-02.md');
  for (const source of [september, october]) {
    await writeFile(source, 'preserve source\n');
    await utimes(source, new Date('2026-09-02T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));
  }
  const before = await readFile(file, 'utf8');
  const result = await archive.archiveDailyMonths(home, { today: '2026-11-24' });
  assert.equal(result.archived.length, 0);
  assert.equal(result.errors[0].code, 'MEMORY_ARCHIVE_AMBIGUOUS');
  assert.equal(await readFile(file, 'utf8'), before);
  for (const source of [september, october]) assert.equal(await readFile(source, 'utf8'), 'preserve source\n');
  await assert.rejects(readFile(path.join(home, 'daily', '2026-09.md')), { code: 'ENOENT' });
});

test('a broken ancestor is unavailable and a genuinely absent archive is missing', async (t) => {
  const { home } = await fixture(t);
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-01')).status, 'missing');
  await rm(path.join(home, 'daily'), { recursive: true });
  await writeFile(path.join(home, 'daily'), 'not a directory');
  const result = await archive.readArchivedDayStrict(home, '2026-10-01');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'MEMORY_READ_STATE_UNKNOWN');
});

test('a dangling archive directory is unavailable', async (t) => {
  const { home } = await fixture(t);
  await rm(path.join(home, 'daily'), { recursive: true });
  try {
    await symlink(path.join(home, 'missing-target'), path.join(home, 'daily'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlink creation is not permitted');
    throw error;
  }
  const result = await archive.readArchivedDayStrict(home, '2026-10-01');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'MEMORY_READ_STATE_UNKNOWN');
});

test('read errors are observable and legacy read stays nonthrowing', async (t) => {
  const { home, file } = await fixture(t);
  await mkdir(file);
  assert.equal((await archive.readArchivedDayStrict(home, '2026-10-01')).status, 'unavailable');
  assert.equal(await archive.readArchivedDay(home, '2026-10-01'), undefined);
});
