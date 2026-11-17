import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { failureCode, jsonSnapshot, requireString, RuntimeContractError, validateTask } from './contracts.js';
import { validateRepairAction } from './analyzer.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const triggers = new Set(['plan_gap', 'decision_abstained', 'execution_error', 'verification_failed',
  'outcome_unknown', 'no_progress', 'decision_protocol_error', 'high_risk']);

/** Large values become task-owned references; required identity and goal are never clipped. */
export function buildExceptionPackage({ task: input, attemptId, trigger, scopeSummary, candidate = null,
  decision = null, executionSummary = null, verification = null, recentTrace = [], evidenceRefs = [],
  putEvidence, maxBytes = 16_384 }) {
  const task = validateTask(input);
  requireString(attemptId, 'attemptId');
  requireString(scopeSummary, 'scopeSummary');
  if (!triggers.has(trigger) || typeof putEvidence !== 'function'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16_384) {
    fail('invalid_exception_package', 'A supported trigger, evidence writer and bounded package limit are required.');
  }
  const value = { schemaVersion: 1, taskId: task.taskId, attemptId, trigger, goal: task.goal, scopeSummary,
    candidate: null, decision: null, executionSummary: null, verification: null,
    recentTrace: [], evidenceRefs: [], truncation: { omittedBytes: 0, fields: [] } };
  if (bytes(value) > maxBytes - 2048) fail('exception_package_too_large', 'Required exception identity exceeds the package limit.');
  const reference = (label, payload) => {
    const stored = putEvidence(label, jsonSnapshot(payload));
    requireString(stored?.ref, 'evidence reference');
    if (!value.evidenceRefs.includes(stored.ref)) value.evidenceRefs.push(stored.ref);
    value.truncation.omittedBytes += bytes(payload);
    if (!value.truncation.fields.includes(label)) value.truncation.fields.push(label);
  };
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => typeof ref !== 'string' || !ref || ref.length > 1024)) {
    fail('invalid_exception_package', 'Evidence references must be bounded strings.');
  }
  const uniqueRefs = [...new Set(evidenceRefs)];
  let refsOmitted = false;
  for (const ref of uniqueRefs) {
    if (value.evidenceRefs.length >= 16) { refsOmitted = true; continue; }
    value.evidenceRefs.push(ref);
    if (bytes(value) > maxBytes - 2048) { value.evidenceRefs.pop(); refsOmitted = true; }
  }
  if (refsOmitted) reference('evidenceRefs', uniqueRefs);
  if (!Array.isArray(recentTrace) || recentTrace.some((item) => typeof item !== 'string')) {
    fail('invalid_exception_package', 'Recent trace must contain textual event identities.');
  }
  const tail = recentTrace.slice(-3);
  const traceFits = tail.every((item) => item.length <= 1024) && bytes({ ...value, recentTrace: tail }) <= maxBytes - 2048;
  if (traceFits) value.recentTrace = tail;
  if (!traceFits || recentTrace.length > 3) reference('recentTrace', recentTrace);
  for (const [label, inputValue] of Object.entries({ candidate, decision, executionSummary, verification })) {
    const payload = inputValue === null ? null : jsonSnapshot(inputValue);
    value[label] = payload;
    if (bytes(value) > maxBytes - 2048) {
      value[label] = null;
      reference(label, payload);
    }
  }
  if (value.evidenceRefs.length > 32 || bytes(value) > maxBytes) {
    fail('exception_package_too_large', 'Evidence metadata exceeds the exception package limit.');
  }
  return jsonSnapshot(value);
}

function exceptionTrigger(run, attempt) {
  if (triggers.has(run.reason)) return run.reason;
  if (run.reason === 'decision_ambiguous' || run.reason === 'decision_provider_unavailable') return 'decision_abstained';
  if (attempt?.verification?.status === 'fail' && attempt.outcome?.status === 'succeeded') return 'verification_failed';
  return 'execution_error';
}

/** This coordinator records proposals only. It never dispatches a suggested action. */
export class AnalysisCoordinator {
  #store;
  #analyzer;
  #agent;
  #now;
  #maxBytes;
  #monotonicNow;

  constructor({ store, analyzer, agent, maxBytes = 16_384, now = Date.now, monotonicNow = () => performance.now() }) {
    if (!store || typeof analyzer?.analyze !== 'function' || !agent
      || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16_384) {
      fail('invalid_analysis_coordinator', 'Store, analyzer, explicit agent and a bounded package limit are required.');
    }
    this.#store = store;
    this.#analyzer = analyzer;
    this.#agent = agent;
    this.#maxBytes = maxBytes;
    this.#now = now;
    this.#monotonicNow = monotonicNow;
  }

  #authorize(taskId, authority, signal) {
    if (!(signal instanceof AbortSignal)) fail('invalid_analysis_coordinator', 'An AbortSignal is required.');
    const run = this.#store.getRun(taskId);
    if (!authority || authority.agent !== this.#agent || authority.scopeRef !== run.task.scopeRef
      || typeof authority.workspaceRoot !== 'string' || !Array.isArray(authority.allowedTools)
      || authority.allowedTools.some((name) => typeof name !== 'string' || !name)) {
      fail('analysis_authority_denied', 'Analysis must use the explicit task caller and authorized scope.');
    }
    if (realpathSync(authority.workspaceRoot) !== realpathSync(run.task.workspaceRoot)) {
      fail('analysis_authority_denied', 'Analysis authority belongs to a different workspace.');
    }
    return run;
  }

  readEvidence(taskId, analysisId, ref, { authority, signal = new AbortController().signal, maxBytes = 16_384 } = {}) {
    this.#authorize(taskId, authority, signal);
    signal.throwIfAborted();
    return this.#store.readAnalysisEvidence(taskId, analysisId, ref,
      { expectedVersion: this.#store.getRun(taskId).version, maxBytes });
  }

  async analyze(taskId, { authority, signal = new AbortController().signal } = {}) {
    const run = this.#authorize(taskId, authority, signal);
    if (run.status === 'reconciling') return { status: 'reconciliation_required', run };
    if (run.status !== 'waiting_analysis') return { status: 'not_required', run };
    if (signal.aborted) return { status: 'analysis_cancelled', run };
    const attempt = this.#store.getLatestAttempt(taskId);
    const recentTrace = this.#store.readRecentTrace(taskId).map((event) => `${event.eventId}:${event.kind}`);
    const deadlineMono = this.#monotonicNow() + Math.max(0, run.task.deadlineAt - this.#now());
    const reserved = this.#store.reserveAnalysis(taskId, { expectedVersion: run.version });
    const { analysisId } = reserved;
    const version = () => ({ expectedVersion: this.#store.getRun(taskId).version });
    const putEvidence = (label, payload) => this.#store.putEvidence(taskId, label, payload, version());
    let result;
    let timer;
    try {
      const authorityDetails = { scopeRef: run.task.scopeRef, workspaceRoot: run.task.workspaceRoot,
        allowedTools: [...authority.allowedTools], recipeId: run.task.recipeId, recipeVersion: run.task.recipeVersion };
      const summary = JSON.stringify(authorityDetails);
      const scopeRef = summary.length <= 1000 && Buffer.byteLength(summary) <= 1000 ? null : putEvidence('authority', authorityDetails).ref;
      const packet = buildExceptionPackage({ task: run.task, attemptId: attempt?.attemptId ?? `unexecuted:${randomUUID()}`,
        trigger: exceptionTrigger(run, attempt), scopeSummary: scopeRef ? `Authorized scope details: ${scopeRef}` : summary,
        candidate: attempt?.candidate ?? null, decision: null,
        executionSummary: attempt?.outcome ?? { reason: run.reason }, verification: attempt?.verification ?? null,
        recentTrace, evidenceRefs: [...(scopeRef ? [scopeRef] : []), ...(attempt?.verification?.evidenceRefs ?? [])],
        putEvidence, maxBytes: this.#maxBytes });
      if (scopeRef) { packet.truncation.fields.push('scopeSummary'); packet.truncation.omittedBytes += bytes(authorityDetails); }
      const allowedEvidenceRefs = [...packet.evidenceRefs];
      this.#store.bindAnalysisEvidence(taskId, analysisId, allowedEvidenceRefs, version());
      const controller = new AbortController();
      const remaining = run.task.deadlineAt - this.#now();
      if (remaining <= 0) fail('budget_exceeded', 'The task deadline has elapsed before analysis.');
      timer = setTimeout(() => controller.abort('Task analysis deadline.'), Math.min(2_147_483_647, remaining));
      const combined = AbortSignal.any([signal, controller.signal]);
      this.#store.observe(taskId, 'analysis_submitted', { analysisId, packageBytes: bytes(packet),
        evidenceRefs: packet.evidenceRefs, truncation: packet.truncation }, version());
      result = await this.#analyzer.analyze(jsonSnapshot(packet), { signal: combined });
      if (this.#now() >= run.task.deadlineAt || this.#monotonicNow() >= deadlineMono) {
        result = { status: 'analysis_timeout', error: { code: 'analysis_timeout', message: 'The task deadline elapsed before analysis acceptance.' } };
      } else if (combined.aborted) {
        result = { status: 'analysis_cancelled', error: { code: 'analysis_cancelled', message: 'The analysis was cancelled before acceptance.' } };
      }
      if (!result || !['proposed', 'analysis_parse_failed', 'analysis_timeout', 'analysis_cancelled', 'analysis_failed'].includes(result.status)) {
        fail('analysis_protocol_error', 'The analyzer did not return a recognized result.');
      }
      const expected = result.status === 'proposed' ? ['status', 'repair'] : ['status', 'error'];
      if (Object.keys(result).length !== 2 || expected.some((key) => !Object.hasOwn(result, key))) {
        fail('analysis_protocol_error', 'The analyzer result has an invalid branch shape.');
      }
      if (result.status === 'proposed') {
        result = { status: 'proposed', repair: validateRepairAction(result.repair, { allowedEvidenceRefs }) };
      } else {
        if (!result.error || Object.keys(result.error).length !== 2 || typeof result.error.code !== 'string'
          || typeof result.error.message !== 'string') fail('analysis_protocol_error', 'The analyzer error is malformed.');
        result = { status: result.status, error: { code: failureCode(result.error, result.status),
          message: 'Analysis did not produce an accepted repair proposal.' } };
      }
    } catch (failure) {
      result = { status: 'analysis_package_failed', error: { code: failureCode(failure, 'analysis_package_failed'),
        message: 'The exception could not be safely packaged or accepted.' } };
    } finally { clearTimeout(timer); }
    const next = this.#store.recordAnalysis(taskId, analysisId, result, version());
    return { status: result.status, analysisId, run: next };
  }
}

export async function runWithAnalysis({ scheduler, coordinator, task, options }) {
  const run = await scheduler.run(task, options);
  const analysis = await coordinator.analyze(run.task.taskId, { authority: options?.authority, signal: options?.signal });
  return { run: analysis.run, analysis };
}
