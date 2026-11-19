import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalIssueIdentity, stableIssueFingerprint } from '../health-inbox.js';

const QUEUES = Symbol.for('dsh-memory-manager.patrol-delivery-queues.v1');
const queues = globalThis[QUEUES] ??= new Map();

function candidates(report) {
  const coverage = report?.cycle_coverage;
  if (!report || typeof report.at !== 'string' || !Number.isFinite(Date.parse(report.at)) ||
      !coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return null;
  const lines = [];
  const delivery = coverage.micro_execution?.schedule_delivery;
  const correlation = coverage.cross_step_correlation;
  if (delivery?.reason === 'no_delivery_source_connected') lines.push('调度投递证据尚未接入');
  if (correlation?.reason === 'no_shared_cycle_identity_established') lines.push('跨步骤缺少共同的工作身份，无法关联');
  for (const [name, value] of Object.entries({
    'memory.distillation': coverage.memory?.distillation, 'memory.index': coverage.memory?.index,
    'memory.recall': coverage.memory?.recall, 'governance.decisions': coverage.governance?.decisions,
    'runtime.snapshot': coverage.micro_execution?.runtime_snapshot,
  })) {
    if (value?.status === 'error' || value?.state === 'error') lines.push(`${name} 读取失败：${String(value.reason ?? value.error ?? 'unknown').slice(0, 160)}`);
  }
  const runtime = coverage.micro_execution?.runtime_snapshot;
  if (Array.isArray(runtime?.unresolvedCandidates)) {
    for (const item of runtime.unresolvedCandidates.slice(0, 100)) {
      if (typeof item?.taskId === 'string' && item.taskId && Number.isSafeInteger(item.unresolved?.count) && item.unresolved.count > 0 &&
          typeof item.unresolved.first?.attemptId === 'string' && item.unresolved.first.attemptId) {
        lines.push(`待核查的运行尝试 ${item.taskId.slice(0, 120)} / ${item.unresolved.first.attemptId.slice(0, 120)}（${item.unresolved.count} 个未决）`);
      }
    }
  }
  return lines;
}

export function createPatrolReportDelivery({ getValves, inbox, home, intervalMs = 30000, writeReceipt = writeFile }) {
  let state = { status: 'starting' };
  let stopped = false;
  let pending;
  const directory = join(home, 'storages', 'patrol-delivery-receipts');
  const queueKey = resolve(inbox.filePath()).toLowerCase();
  async function execute() {
    if (stopped) return;
    try {
      const valves = getValves();
      if (!valves || typeof valves.lastPatrol !== 'function') { state = { status: 'unavailable' }; return; }
      const report = await valves.lastPatrol('weekly');
      if (report == null) { state = { status: 'unknown', reason: 'report_absent_or_unreadable' }; return; }
      const items = candidates(report);
      if (items === null) { state = { status: 'unsupported_report' }; return; }
      const id = createHash('sha256').update(JSON.stringify(report)).digest('hex');
      if (!items.length) { state = { status: 'no_candidates', reportId: id }; return; }
      const receipt = join(directory, `${id}.json`);
      try {
        const stored = JSON.parse(await readFile(receipt, 'utf8'));
        if (stored?.version !== 1 || stored.reportId !== id) throw new Error('invalid delivery receipt');
        state = { status: 'delivered', reportId: id }; return;
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const issueId = createHash('sha256').update(JSON.stringify([...items].sort())).digest('hex');
      const finding = { from: 'dsh-valves', code: 'weekly-cycle-coverage', severity: 'warn',
        message: `周检 ${report.at}：发现待核查的证据缺口或未决尝试：${items.join('；')}`,
        hint: '这是待核查线索；写入收件箱不代表用户已经查看或确认。',
        identity: { scope: 'weekly-patrol', subtype: 'coverage-candidate', subject: issueId } };
      const fingerprint = stableIssueFingerprint(canonicalIssueIdentity(finding));
      const existing = await inbox.list();
      if (!existing.some((item) => item.fingerprint === fingerprint)) {
        await inbox.post(finding);
        if (!(await inbox.list()).some((item) => item.fingerprint === fingerprint)) throw new Error('inbox_readback_missing');
      }
      await mkdir(directory, { recursive: true });
      const temporary = `${receipt}.${randomUUID()}.tmp`;
      try {
        await writeReceipt(temporary, JSON.stringify({ version: 1, reportId: id, fingerprint, deliveredAt: new Date().toISOString() }), { flag: 'wx' });
        await rename(temporary, receipt);
      } finally { await unlink(temporary).catch(() => {}); }
      state = { status: 'delivered', reportId: id };
    } catch (error) {
      state = { status: 'retrying', error: String(error?.message ?? error).slice(0, 300) };
    }
  }
  function reconcile() {
    if (pending) return pending;
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const current = previous.then(execute, execute);
    pending = current;
    queues.set(queueKey, current);
    void current.finally(() => {
      if (queues.get(queueKey) === current) queues.delete(queueKey);
      if (pending === current) pending = undefined;
    });
    return current;
  }
  const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.min(intervalMs, 2147483647) : 30000;
  const timer = setInterval(() => { void reconcile(); }, delay);
  timer.unref?.();
  void reconcile();
  return { reconcile, status: () => ({ ...state }), dispose: () => { stopped = true; clearInterval(timer); } };
}
