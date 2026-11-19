import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// These sources establish observations, not completeness or success of a cycle.
async function ledger(file, match) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (err) {
    return err?.code === 'ENOENT' ? { status: 'unknown', reason: 'source_absent' }
      : { status: 'error', reason: err?.code ?? 'read_failed' };
  }
  let observed = false;
  let invalid = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid = true;
      else if (match(row)) observed = true;
    } catch { invalid = true; }
  }
  if (invalid) return { status: 'incomplete', observed, reason: 'invalid_records' };
  return observed ? { status: 'observed' } : { status: 'unknown', reason: 'no_matching_evidence' };
}

async function recallEvidence(root) {
  const files = [join(root, '.usage.jsonl')];
  let listingError;
  for (const dir of ['.usage', join('.usage', 'archive')]) {
    try {
      for (const name of await readdir(join(root, dir))) {
        if (/^\d{4}-\d{2}\.jsonl$/.test(name)) files.push(join(root, dir, name));
      }
    } catch (err) { if (err?.code !== 'ENOENT') listingError = err?.code ?? 'read_failed'; }
  }
  const results = await Promise.all(files.map((file) => ledger(file, (row) => row.kind === 'recall' && typeof row.href === 'string')));
  const observed = results.some((r) => r.status === 'observed' || r.observed === true);
  const error = results.find((r) => r.status === 'error');
  if (listingError || error) return { status: 'error', observed, reason: listingError ?? error.reason };
  if (results.some((r) => r.status === 'incomplete')) return { status: 'incomplete', observed, reason: 'invalid_records' };
  return observed ? { status: 'observed' } : { status: 'unknown', reason: 'no_recall_evidence' };
}

async function indexEvidence(root) {
  try {
    const text = await readFile(join(root, 'MEMORY.md'), 'utf8');
    return text.trim() ? { status: 'observed', scope: 'index_file_only' } : { status: 'unknown', reason: 'empty_index' };
  } catch (err) {
    return err?.code === 'ENOENT' ? { status: 'unknown', reason: 'source_absent' }
      : { status: 'error', reason: err?.code ?? 'read_failed' };
  }
}

// Keep runtime observations bounded and preserve uncertainty in incomplete snapshots.
async function runtimeEvidence(getRuntimeStatus) {
  let service, snapshot;
  try {
    service = getRuntimeStatus?.();
    if (service == null) return { state: 'missing' };
    if (typeof service.snapshot !== 'function') return { state: 'partial', reason: 'snapshot_method_missing' };
    snapshot = await service.snapshot({ limit: 100 });
  } catch (err) {
    return { state: 'error', reason: 'snapshot_threw', error: String(err?.message ?? err) };
  }
  if (!snapshot || typeof snapshot !== 'object') return { state: 'partial', reason: 'invalid_snapshot' };
  if (['disabled', 'unavailable', 'error'].includes(snapshot.state)) {
    return { state: snapshot.state, ...(typeof snapshot.error === 'string' ? { error: snapshot.error } : {}) };
  }
  if (snapshot.state !== 'ready') return { state: 'partial', reason: 'invalid_state' };
  let partial = !Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 100 ||
    typeof snapshot.truncated !== 'boolean' || !Array.isArray(snapshot.runs) ||
    !snapshot.registeredTasks || !Array.isArray(snapshot.registeredTasks.taskIds) ||
    typeof snapshot.registeredTasks.truncated !== 'boolean';
  const rawRuns = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const rawTasks = Array.isArray(snapshot.registeredTasks?.taskIds) ? snapshot.registeredTasks.taskIds : [];
  if (rawRuns.length > 100 || rawTasks.length > 100) partial = true;
  const runs = [];
  for (const run of rawRuns.slice(0, 100)) {
    const first = run?.unresolved?.first;
    if (!run || typeof run.taskId !== 'string' || typeof run.status !== 'string' ||
      !(run.reason === null || typeof run.reason === 'string') || !Number.isSafeInteger(run.createdAt) ||
      !Number.isSafeInteger(run.updatedAt) || typeof run.registered !== 'boolean' ||
      !Number.isSafeInteger(run.unresolved?.count) || run.unresolved.count < 0 ||
      !(first === null || (first && typeof first.attemptId === 'string' && typeof first.status === 'string'))) {
      partial = true;
      continue;
    }
    runs.push({ taskId: run.taskId, status: run.status, reason: run.reason, createdAt: run.createdAt,
      updatedAt: run.updatedAt, unresolved: { count: run.unresolved.count,
        first: first === null ? null : { attemptId: first.attemptId, status: first.status } }, registered: run.registered });
  }
  const taskIds = rawTasks.slice(0, 100).filter((id) => typeof id === 'string');
  if (taskIds.length !== Math.min(rawTasks.length, 100)) partial = true;
  if (snapshot.truncated === true || snapshot.registeredTasks?.truncated === true) partial = true;
  return { state: partial ? 'partial' : 'ready', sourceState: 'ready',
    limit: Number.isSafeInteger(snapshot.limit) && snapshot.limit >= 1 && snapshot.limit <= 100 ? snapshot.limit : null,
    truncated: typeof snapshot.truncated === 'boolean' ? snapshot.truncated || rawRuns.length > 100 : null,
    runs, registeredTasks: { taskIds, truncated: typeof snapshot.registeredTasks?.truncated === 'boolean'
      ? snapshot.registeredTasks.truncated || rawTasks.length > 100 : null },
    unresolvedCandidates: runs.filter((run) => run.unresolved.count > 0).map((run) => ({
      taskId: run.taskId, status: run.status, unresolved: run.unresolved,
    })) };
}

export async function collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus }) {
  const [distillation, index, recall, governance, runtime] = await Promise.all([
    ledger(join(memoryRoot, '.write-ledger.jsonl'), (r) => r.tool === 'memory-manager' && typeof r.key === 'string' && r.key.startsWith('functions/') && typeof r.hash === 'string'),
    indexEvidence(memoryRoot),
    recallEvidence(memoryRoot),
    ledger(join(storageDir, 'mind-valves.jsonl'), (r) => typeof r.gate === 'string' && r.gate !== 'patrol' && typeof r.outcome === 'string'),
    runtimeEvidence(getRuntimeStatus),
  ]);
  return {
    micro_execution: {
      schedule_delivery: { status: 'unknown', reason: 'no_delivery_source_connected' },
      outcome: { status: 'unknown', reason: 'runtime_snapshot_does_not_establish_outcome' },
      runtime_snapshot: runtime,
    },
    memory: { distillation: { status: distillation.status === 'observed' ? 'unknown' : distillation.status, reason: distillation.status === 'observed' ? 'generic_tracked_write_does_not_identify_distillation' : distillation.reason, tracked_function_write_observed: distillation.status === 'observed' || distillation.observed === true }, index, recall },
    governance: { decisions: governance },
    cross_step_correlation: { status: 'unknown', reason: 'no_shared_cycle_identity_established', note: 'Individual observations do not establish that the same work passed through these steps.' },
  };
}
