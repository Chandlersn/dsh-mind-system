import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecallProbe, isExcludedHitPath } from '../src/patrol.js';

/**
 * The recall probe exists to answer one question: did excluded content come back
 * into actual recall results?
 *
 * The failure mode it must not have is answering "no" when it never looked. So the
 * tests are mostly about the difference between "checked and found nothing" and
 * "did not check" — a boundary nobody verified must never report zero violations.
 */

async function subjectWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'probe-'));
  const rel = 'dao/_deleted';
  await mkdir(join(root, rel), { recursive: true });
  for (const f of files) await writeFile(join(root, rel, f), 'x', 'utf8');
  return { root, subjects: [{ root, rel, files: files.length }] };
}

test('no searcher wired means not probed at all, not a clean result', async () => {
  const probe = await runRecallProbe({});
  // undefined is the only value the report turns into `no_probe_configured`
  // (violations: null). Returning { ok: true, hits: [] } here would claim a
  // verified-clean boundary that nobody checked.
  assert.equal(probe, undefined);
});

test('a searcher that answers yields hits, including the excluded twin', async () => {
  const { root, subjects } = await subjectWith(['note-one.md']);
  try {
    const probe = await runRecallProbe({
      subjects,
      searcher: async (q) => ({ ok: true, results: [{ path: `${root}/dao/_deleted/${q}.md` }] }),
    });
    assert.equal(probe.ok, true);
    assert.equal(probe.hits.length, 1);
    // The whole point: this hit is what the weekly report must flag.
    assert.equal(isExcludedHitPath(probe.hits[0]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('queries come from the excluded file names, not from the folder', async () => {
  const { root, subjects } = await subjectWith(['绿灯不携带信息.md', '判据从实测分布中长出.md']);
  try {
    const asked = [];
    await runRecallProbe({
      subjects,
      searcher: async (q) => { asked.push(q); return { ok: true, results: [] }; },
    });
    // Extension stripped, name preserved: that name is the collision the probe hunts.
    assert.deepEqual(asked.sort(), ['判据从实测分布中长出', '绿灯不携带信息'].sort());
    // The folder name itself would only ever match the twin's path, not its content.
    assert.equal(asked.includes('_deleted'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staging artefacts are not used as queries', async () => {
  const { root, subjects } = await subjectWith([
    'real-note.md',
    'real-note.md.stage-abc123.tmp',
    '.hidden.md',
  ]);
  try {
    const asked = [];
    await runRecallProbe({
      subjects,
      searcher: async (q) => { asked.push(q); return { ok: true, results: [] }; },
    });
    // A random temp id as a query measures noise, not the boundary.
    assert.deepEqual(asked, ['real-note']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failing searcher reports the reason and never throws', async () => {
  const { root, subjects } = await subjectWith(['a.md']);
  try {
    const refused = await runRecallProbe({ subjects, searcher: async () => ({ ok: false, reason: 'no_key' }) });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'no_key');

    const thrown = await runRecallProbe({ subjects, searcher: async () => { throw new Error('socket closed'); } });
    assert.equal(thrown.ok, false);
    assert.match(thrown.error, /socket closed/);

    // A malformed answer must not be read as "no hits".
    const shape = await runRecallProbe({ subjects, searcher: async () => ({ results: [] }) });
    assert.equal(shape.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('probe output is bounded, so one pass cannot run away', async () => {
  const files = Array.from({ length: 40 }, (_, i) => `note-${i}.md`);
  const { root, subjects } = await subjectWith(files);
  try {
    let calls = 0;
    await runRecallProbe({
      subjects,
      searcher: async () => { calls++; return { ok: true, results: [] }; },
    });
    assert.ok(calls > 0 && calls <= 10, `expected bounded queries, got ${calls}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty subject list cannot produce a fake clean result', async () => {
  const probe = await runRecallProbe({ subjects: [], searcher: async () => ({ ok: true, results: [] }) });
  // Nothing to query means nothing was verified — the caller must stay at null.
  assert.equal(probe.ok, false);
  assert.equal(probe.error, 'no_query_available');
});
