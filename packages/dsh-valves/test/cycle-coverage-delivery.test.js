import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCycleCoverage } from '../src/cycle-coverage.js';

/**
 * Schedule delivery used to be a hardcoded `unknown / no_delivery_source_connected`.
 *
 * That string was once honest and then quietly became false: the memory package
 * had already written a durable receipt while the panel still said no delivery
 * source was connected. A fixed `unknown` is not a safe default -- it misreports
 * existing evidence as absent, which is the same class of error as claiming a
 * boundary is clean because nobody probed it.
 */

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-'));
  const storageDir = join(root, 'storages');
  const memoryRoot = join(root, 'memory');
  await mkdir(join(storageDir, 'patrol-delivery-receipts'), { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(join(memoryRoot, 'MEMORY.md'), '# index\n', 'utf8');
  return { root, storageDir, memoryRoot, dir: join(storageDir, 'patrol-delivery-receipts') };
}

const coverageOf = (storageDir, memoryRoot) =>
  collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus: () => null });

test('no receipts directory reads as unknown, not as an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-none-'));
  const storageDir = join(root, 'storages');
  const memoryRoot = join(root, 'memory');
  await mkdir(storageDir, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  try {
    const cov = await coverageOf(storageDir, memoryRoot);
    const d = cov.micro_execution.schedule_delivery;
    assert.equal(d.status, 'unknown');
    assert.equal(d.reason, 'no_delivery_receipts_written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty receipts directory is also unknown, not observed', async () => {
  const f = await fixture();
  try {
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    const d = cov.micro_execution.schedule_delivery;
    assert.equal(d.status, 'unknown');
    assert.equal(d.reason, 'no_delivery_receipts_written');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a real receipt is reported as observed, and says what it does NOT prove', async () => {
  const f = await fixture();
  try {
    const receipt = {
      version: 1,
      reportId: 'abc123',
      fingerprint: 'i1-def',
      deliveredAt: '2026-11-19T04:18:54.377Z',
    };
    await writeFile(join(f.dir, 'abc123.json'), JSON.stringify(receipt), 'utf8');
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    const d = cov.micro_execution.schedule_delivery;
    assert.equal(d.status, 'observed');
    assert.equal(d.receipts, 1);
    assert.equal(d.latest_delivered_at, '2026-11-19T04:18:54.377Z');
    // The over-claim guard: delivery written is not delivery read.
    assert.match(d.note, /does not record that it was read/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the newest receipt is the one reported, not the first read', async () => {
  const f = await fixture();
  try {
    // Names are chosen so that alphabetical order and time order DISAGREE:
    // receipts are read sorted, so `a-` is read first and `z-` last. An earlier
    // version of this test used old.json/new.json, whose alphabetical order
    // (n before o) coincided with time order -- "take the first" and "take the
    // newest" returned the same answer, and the mutation that broke the newest
    // logic survived.
    await writeFile(join(f.dir, 'a-earlier.json'), JSON.stringify({ version: 1, reportId: 'a', deliveredAt: '2026-11-10T00:00:00.000Z' }), 'utf8');
    await writeFile(join(f.dir, 'z-later.json'), JSON.stringify({ version: 1, reportId: 'z', deliveredAt: '2026-11-20T00:00:00.000Z' }), 'utf8');
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    assert.equal(cov.micro_execution.schedule_delivery.latest_delivered_at, '2026-11-20T00:00:00.000Z');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('three receipts read out of time order still report the newest', async () => {
  const f = await fixture();
  try {
    // Read order is alphabetical: a, m, z. Their timestamps are placed so the
    // NEWEST sits in the MIDDLE:
    //   take-first  -> 2026-11-20  (wrong)
    //   take-last   -> 2026-11-10  (wrong)
    //   take-max    -> 2026-12-01  (right)
    // Putting the maximum anywhere else lets one of the wrong logics coincide
    // with the right answer, which is how the first version of this test let the
    // mutation survive.
    await writeFile(join(f.dir, 'a-mid.json'), JSON.stringify({ version: 1, reportId: 'a', deliveredAt: '2026-11-20T00:00:00.000Z' }), 'utf8');
    await writeFile(join(f.dir, 'm-newest.json'), JSON.stringify({ version: 1, reportId: 'm', deliveredAt: '2026-12-01T00:00:00.000Z' }), 'utf8');
    await writeFile(join(f.dir, 'z-oldest.json'), JSON.stringify({ version: 1, reportId: 'z', deliveredAt: '2026-11-10T00:00:00.000Z' }), 'utf8');
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    const d = cov.micro_execution.schedule_delivery;
    assert.equal(d.receipts, 3);
    assert.equal(d.latest_delivered_at, '2026-12-01T00:00:00.000Z');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a receipt without reportId is invalid, and the count survives', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'good.json'), JSON.stringify({ version: 1, reportId: 'g', deliveredAt: '2026-11-19T00:00:00.000Z' }), 'utf8');
    await writeFile(join(f.dir, 'bad.json'), JSON.stringify({ version: 1, deliveredAt: '2026-11-19T00:00:00.000Z' }), 'utf8');
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    const d = cov.micro_execution.schedule_delivery;
    assert.equal(d.status, 'observed');
    assert.equal(d.receipts, 1);
    assert.equal(d.invalid, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('unreadable receipts are incomplete, never silently observed', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'broken.json'), 'not json at all', 'utf8');
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    const d = cov.micro_execution.schedule_delivery;
    assert.equal(d.status, 'incomplete');
    assert.equal(d.reason, 'no_readable_receipts');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a BOM-prefixed receipt still parses', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'bom.json'), '\uFEFF' + JSON.stringify({ version: 1, reportId: 'b', deliveredAt: '2026-11-19T00:00:00.000Z' }), 'utf8');
    const cov = await coverageOf(f.storageDir, f.memoryRoot);
    assert.equal(cov.micro_execution.schedule_delivery.status, 'observed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
