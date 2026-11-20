import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';

/**
 * End of the wiring: scan -> probe -> summarize -> report carries the section.
 *
 * The pieces were each tested alone; this closes the seam between them, because a
 * probe that runs and still never reaches the report is exactly the kind of
 * "implemented but not connected" gap that reads as done in a diff.
 */

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'boundary-e2e-'));
  const storageDir = join(root, 'storages');
  const memoryRoot = join(root, 'memory');
  await mkdir(storageDir, { recursive: true });
  await mkdir(join(memoryRoot, 'dao', '_deleted'), { recursive: true });
  await writeFile(join(memoryRoot, 'dao', '_deleted', 'twin-note.md'), 'x', 'utf8');
  return { root, storageDir, memoryRoot };
}

test('a registered searcher reaches the weekly report as a checked probe', async () => {
  const { root, storageDir, memoryRoot } = await fixture();
  try {
    const { scanRecallSubjects, runRecallProbe, summarizeRecallBoundary } =
      await import('../src/patrol.js');

    const runtime = createRuntime({ storageDir, thresholds: {} });
    // The searcher echoes the excluded twin back: that is the violation case, and
    // it must be reported as such rather than silently filtered out.
    runtime.registerRecallSearch(async (q) => ({ ok: true, results: [{ path: `${memoryRoot}/dao/_deleted/${q}.md` }] }));

    const scan = await scanRecallSubjects([memoryRoot]);
    assert.equal(scan.subjects.length, 1, JSON.stringify(scan));

    const probe = await runRecallProbe({ searcher: runtime.recallSearchFn(), subjects: scan.subjects });
    const boundary = summarizeRecallBoundary({ scan, previousSubjects: scan.subjects, probe });

    assert.equal(boundary.summary.probe, 'checked');
    assert.equal(boundary.summary.violations, 1, 'a deleted-twin hit must count as a violation');
    assert.equal(boundary.findings.length, 1);
    assert.equal(boundary.findings[0].kind, 'recall_boundary_violation');

    // The report must actually carry the section, not just compute it.
    const report = await runtime.patrol('weekly', { principles: [], recall_boundary: boundary });
    assert.ok(report?.recall_boundary, 'recall_boundary missing from the written report');
    assert.equal(report.recall_boundary.summary.probe, 'checked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('with no searcher registered the report stays unprobed, never clean', async () => {
  const { root, storageDir, memoryRoot } = await fixture();
  try {
    const { scanRecallSubjects, runRecallProbe, summarizeRecallBoundary } =
      await import('../src/patrol.js');

    const runtime = createRuntime({ storageDir, thresholds: {} });
    const scan = await scanRecallSubjects([memoryRoot]);
    // No registration: exactly the state a host reaches when the peer that owns
    // the search never calls registerRecallSearch.
    const probe = await runRecallProbe({ searcher: runtime.recallSearchFn(), subjects: scan.subjects });
    assert.equal(probe, undefined);

    const boundary = summarizeRecallBoundary({ scan, previousSubjects: scan.subjects, probe });
    assert.equal(boundary.summary.probe, 'not_configured');
    // null, not 0: nothing was verified, so nothing may be reported as clean.
    assert.equal(boundary.summary.violations, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
