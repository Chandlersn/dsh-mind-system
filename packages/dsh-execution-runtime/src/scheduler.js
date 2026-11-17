import * as fs from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { admitCandidate } from './admission.js';
import { selectUniqueRuleFallback } from './decision-client.js';
import { RuntimeContractError, failureCode, jsonSnapshot, requireString, validateCandidate, validateTask, validateVerification } from './contracts.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const snapshot = (value) => deepFreeze(jsonSnapshot(value));
const within = (root, target) => {
  const name = relative(root, target);
  return name === '' || (name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(name));
};

/** Trusted recipe callbacks are registered by the embedding application, never by a model. */
function registerRecipe(input) {
  requireString(input?.id, 'recipe.id');
  requireString(input.version, 'recipe.version');
  requireString(input.ruleVersion, 'recipe.ruleVersion');
  requireString(input.verifier?.id, 'verifier.id');
  requireString(input.verifier?.version, 'verifier.version');
  if (!Array.isArray(input.allowedTools) || !input.allowedTools.length
    || !Array.isArray(input.requiredPreconditionIds) || !Array.isArray(input.postconditionIds)
    || !input.postconditionIds.length || typeof input.candidates !== 'function'
    || typeof input.verifier.verify !== 'function' || !input.preconditions
    || !Number.isSafeInteger(input.verificationIoReserve) || input.verificationIoReserve < 0) {
    fail('invalid_recipe', 'Recipe callbacks, conditions, tools, and verifier reservation must be registered.');
  }
  for (const id of [...input.allowedTools, ...input.requiredPreconditionIds, ...input.postconditionIds]) requireString(id, 'recipe identifier');
  if (!input.toolEffects || typeof input.toolEffects !== 'object'
    || input.allowedTools.some((name) => !Object.hasOwn(input.toolEffects, name)
      || !['read', 'reversible_write'].includes(input.toolEffects[name]))) {
    fail('invalid_recipe', 'Each tool needs a trusted supported effect declaration.');
  }
  for (const id of input.requiredPreconditionIds) {
    if (typeof input.preconditions[id] !== 'function') fail('invalid_recipe', 'Every mandatory precondition needs a callback.');
  }
  return Object.freeze({ ...input, allowedTools: Object.freeze([...input.allowedTools]),
    requiredPreconditionIds: Object.freeze([...input.requiredPreconditionIds]),
    postconditionIds: Object.freeze([...input.postconditionIds]),
    fallbackRule: input.fallbackRule === undefined ? null : snapshot(input.fallbackRule),
    toolEffects: Object.freeze({ ...input.toolEffects }),
    preconditions: Object.freeze({ ...input.preconditions }), verifier: Object.freeze({ ...input.verifier }) });
}

export class RuntimeScheduler {
  #store;
  #recipes = new Map();
  #executor;
  #tools;
  #validateArguments;
  #decisionClient;
  #decisionPolicy;
  #admit;
  #now;
  #monotonicNow;
  #active = new Set();

  constructor({ store, recipes, executor, tools, validateArguments, decisionClient = null,
    decisionPolicy = null, admission = admitCandidate, now = Date.now, monotonicNow = () => performance.now() }) {
    if (!store || !executor || typeof executor.execute !== 'function' || !Array.isArray(recipes)
      || typeof admission !== 'function' || typeof validateArguments !== 'function') {
      fail('invalid_runtime', 'Store, registered recipes, executor, admission and argument validation are required.');
    }
    this.#store = store;
    this.#executor = executor;
    this.#tools = tools;
    this.#validateArguments = validateArguments;
    this.#decisionClient = decisionClient;
    this.#decisionPolicy = decisionPolicy === null ? null : snapshot(decisionPolicy);
    this.#admit = admission;
    this.#now = now;
    this.#monotonicNow = monotonicNow;
    for (const input of recipes) {
      const recipe = registerRecipe(input);
      const key = `${recipe.id}:${recipe.version}`;
      if (this.#recipes.has(key)) fail('duplicate_recipe', 'A recipe version may be registered only once.');
      this.#recipes.set(key, recipe);
    }
  }

  async run(input, { authority, signal = new AbortController().signal, decisionMode = 'rules' } = {}) {
    const task = snapshot(validateTask(input));
    const recipe = this.#recipes.get(`${task.recipeId}:${task.recipeVersion}`);
    if (!recipe) fail('recipe_not_registered', 'The task recipe version is not registered.');
    if (!authority || authority.scopeRef !== task.scopeRef || !Array.isArray(authority.allowedTools)
      || !authority.allowedTools.length || typeof authority.workspaceRoot !== 'string') {
      fail('authority_unavailable', 'Explicit task authority is required before reading task files.');
    }
    if (!authority.agent || this.#executor.agent !== authority.agent) {
      fail('authority_agent_mismatch', 'Admission and dispatch must share the same explicit caller agent.');
    }
    const root = fs.realpathSync(authority.workspaceRoot);
    if (fs.realpathSync(task.workspaceRoot) !== root) fail('scope_denied', 'The task workspace is outside the authorized root.');
    const trustedAuthority = Object.freeze({ ...authority, workspaceRoot: root,
      allowedTools: Object.freeze([...authority.allowedTools]) });
    if (!['rules', 'provider'].includes(decisionMode)) fail('invalid_decision_mode', 'An explicit supported decision mode is required.');
    if (!(signal instanceof AbortSignal)) fail('invalid_runtime', 'A caller-owned AbortSignal is required.');
    if (this.#active.has(task.taskId)) fail('run_in_progress', 'This task is already executing.');
    this.#active.add(task.taskId);
    let created = false;
    const deadlineMono = this.#monotonicNow() + Math.max(0, task.deadlineAt - this.#now());
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    let timer;
    const expired = () => this.#now() >= task.deadlineAt || this.#monotonicNow() >= deadlineMono;
    const armDeadline = () => {
      if (expired()) controller.abort('runtime deadline');
      else timer = setTimeout(armDeadline, Math.max(1, Math.min(2_147_483_647, deadlineMono - this.#monotonicNow())));
    };
    const current = () => this.#store.getRun(task.taskId);
    const version = () => ({ expectedVersion: current().version });
    const check = () => {
      if (expired()) fail('budget_exceeded', 'The runtime deadline has elapsed.');
      if (combinedSignal.aborted) fail('runtime_cancelled', 'The runtime was cancelled.');
    };
    const observe = (kind, payload) => this.#store.observe(task.taskId, kind, payload, version());
    const charge = (kind, amount = 1) => {
      check();
      return this.#store.reserveBudget(task.taskId, kind, amount, version());
    };
    const io = (phase, reservation = null) => {
      const invoke = (operation, target, ...args) => {
        check();
        if (typeof target !== 'string' || !within(root, resolve(target))) fail('scope_denied', 'Recipe I/O must stay inside the authorized root.');
        if (reservation) {
          if (reservation.remaining < 1) fail('io_reservation_exceeded', 'The verifier exceeded its registered I/O reservation.');
          reservation.remaining--;
        } else charge('ioOperations');
        if (operation === 'readFileSync') {
          if (args.length > 1 || (args[0] !== undefined && args[0] !== 'utf8')) {
            fail('invalid_io_options', 'Read-only recipe I/O accepts buffers or UTF-8 text, not custom file flags.');
          }
          if (!within(root, fs.realpathSync(target))) fail('scope_denied', 'Recipe I/O resolved outside the authorized root.');
          if (fs.statSync(target).size > 4 * 1024 * 1024) fail('runtime_io_limit', 'A recipe file exceeds the bounded read size.');
        } else if (args.length) fail('invalid_io_options', 'Recipe metadata operations do not accept custom options.');
        const result = fs[operation](target, ...args);
        if (operation === 'realpathSync' && !within(root, result)) fail('scope_denied', 'A canonical path escaped the authorized root.');
        observe('io_observed', { phase, operation, path: target });
        check();
        return result;
      };
      return Object.freeze(Object.fromEntries(['readFileSync', 'lstatSync', 'realpathSync']
        .map((operation) => [operation, (target, ...args) => invoke(operation, target, ...args)])));
    };
    const unknownVerification = (reason) => ({ status: 'unknown', progress: 'unknown', goalSatisfied: null,
      verifierId: recipe.verifier.id, verifierVersion: recipe.verifier.version, evidenceRefs: [], reason });
    const failVerification = (reason) => ({ ...unknownVerification(reason), status: 'fail', progress: 'unchanged', goalSatisfied: false });
    const stop = (status, reason) => this.#store.stopRun(task.taskId, status, reason, version());
    let attemptId = null;
    try {
      this.#store.createRun(task);
      created = true;
      armDeadline();
      check();
      const initialState = recipe.prepare
        ? await recipe.prepare({ task, io: io('prepare'), signal: combinedSignal }) : {};
      check();
      this.#store.setState(task.taskId, snapshot(initialState), version());
      let noProgress = 0;
      while (current().status === 'running') {
        check();
        const state = snapshot(current().state);
        const generated = await recipe.candidates({ task, state, io: io('candidate'), signal: combinedSignal });
        check();
        if (!Array.isArray(generated) || generated.length === 0) { stop('waiting_analysis', 'plan_gap'); break; }
        const candidates = generated.map((item) => snapshot(validateCandidate(item)));
        if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
          fail('invalid_candidate', 'Generated candidate identities must be unique.');
        }
        for (const candidate of candidates) {
          if (candidate.postconditionIds.some((id) => !recipe.postconditionIds.includes(id))
            || recipe.postconditionIds.some((id) => !candidate.postconditionIds.includes(id))) {
            fail('verifier_binding_mismatch', 'The candidate must use the registered postconditions.');
          }
        }
        observe('candidates_generated', { candidateIds: candidates.map((candidate) => candidate.candidateId) });
        const admissionFor = async (candidate, phase) => {
          let budgetFailure = null;
          const wrappedRecipe = { ...recipe, preconditions: Object.fromEntries(Object.entries(recipe.preconditions)
            .map(([id, condition]) => [id, async (args) => {
              try { return await condition({ ...args, state, io: io(phase) }); }
              catch (failure) {
                if (['budget_exceeded', 'runtime_cancelled'].includes(failureCode(failure))) budgetFailure = failure;
                throw failure;
              }
            }])) };
          const decision = await this.#admit({ task, candidate, authority: trustedAuthority,
            recipe: wrappedRecipe, tools: this.#tools, validateArguments: this.#validateArguments, signal: combinedSignal });
          if (budgetFailure) throw budgetFailure;
          observe('admission_decided', { candidateId: candidate.candidateId, phase, decision: jsonSnapshot(decision) });
          return decision;
        };
        const admitted = [];
        let unavailable = false;
        for (const candidate of candidates) {
          const decision = await admissionFor(candidate, 'candidate_admission');
          if (decision.verdict === 'allow') admitted.push(candidate);
          if (decision.verdict === 'unavailable') unavailable = true;
        }
        check();
        if (!admitted.length) { stop(unavailable ? 'waiting_human' : 'failed', unavailable ? 'admission_unavailable' : 'admission_denied'); break; }
        let decision;
        if (decisionMode === 'rules') {
          if (admitted.length !== 1) { stop('waiting_analysis', 'decision_ambiguous'); break; }
          decision = { selectedCandidateId: admitted[0].candidateId, decisionSource: 'rules', policyVersion: recipe.ruleVersion,
            scores: {}, confidence: null, confidenceSource: 'unavailable' };
        } else {
          const fallback = () => selectUniqueRuleFallback({ candidates: admitted, rule: recipe.fallbackRule, admitted: true });
          if (!this.#decisionClient || !this.#decisionPolicy) {
            decision = fallback();
            if (decision.selectedCandidateId === null) { stop('waiting_analysis', 'decision_provider_unavailable'); break; }
          } else {
            charge('decisionRequests');
            try {
              decision = await this.#decisionClient.decide({ state: { task, state }, candidates: admitted,
                signal: combinedSignal, policy: this.#decisionPolicy });
            } catch (failure) {
              check();
              if (!['decision_transport_error', 'decision_http_error', 'decision_timeout'].includes(failureCode(failure))) throw failure;
              decision = fallback();
              if (decision.selectedCandidateId === null) throw failure;
            }
          }
        }
        check();
        observe('decision_recorded', jsonSnapshot(decision));
        const candidate = admitted.find((item) => item.candidateId === decision.selectedCandidateId);
        if (!candidate) { stop('waiting_analysis', decision.selectedCandidateId === null ? 'decision_abstained' : 'decision_protocol_error'); break; }
        const verificationReservation = { remaining: recipe.verificationIoReserve };
        if (verificationReservation.remaining) charge('ioOperations', verificationReservation.remaining);
        observe('verification_reserved', { verifierId: recipe.verifier.id, ioOperations: verificationReservation.remaining });
        const reserved = this.#store.reserveAttempt(task.taskId, candidate, version());
        attemptId = reserved.attemptId;
        this.#store.markStarted(task.taskId, attemptId, version());
        let outcome;
        try {
          outcome = await this.#executor.execute(candidate, { callId: attemptId, signal: combinedSignal,
            beforeDispatch: async () => {
              check();
              const repeated = await admissionFor(candidate, 'dispatch_admission');
              check();
              if (repeated.verdict !== 'allow') fail('dispatch_admission_denied', 'The selected action no longer satisfies admission.');
            } });
        } catch (failure) {
          outcome = { status: 'outcome_unknown', error: { code: 'executor_unavailable', message: 'The executor failed without an authoritative outcome.' } };
        }
        let verification;
        if (outcome.status === 'succeeded') {
          try {
            check();
            verification = validateVerification(await recipe.verifier.verify({ task, state, candidate,
              io: io('verification', verificationReservation), signal: combinedSignal }));
            check();
            if (verification.verifierId !== recipe.verifier.id || verification.verifierVersion !== recipe.verifier.version) {
              fail('verifier_binding_mismatch', 'Verification must come from the registered verifier version.');
            }
          } catch (failure) { verification = unknownVerification(failureCode(failure, 'verification_unavailable')); }
        } else if (outcome.status === 'not_started' || outcome.status === 'failed') {
          verification = failVerification(outcome.error?.code ?? outcome.status);
        } else verification = unknownVerification(outcome.error?.code ?? 'outcome_unknown');
        let nextState;
        if (recipe.advance && outcome.status === 'succeeded' && verification.status === 'pass') {
          try {
            nextState = snapshot(await recipe.advance({ task, state, candidate,
              outcome: snapshot(outcome), verification: snapshot(verification) }));
            check();
          } catch (failure) {
            verification = { ...unknownVerification(failureCode(failure, 'state_advance_failed')),
              evidenceRefs: verification.evidenceRefs };
            nextState = undefined;
          }
        }
        this.#store.recordOutcome(task.taskId, attemptId, outcome, verification,
          { ...version(), notStartedStatus: combinedSignal.aborted ? 'cancelled' : 'failed', nextState });
        attemptId = null;
        if (current().status !== 'running') break;
        noProgress = verification.progress === 'advanced' ? 0 : noProgress + 1;
        if (noProgress >= 3) { stop('waiting_analysis', 'no_progress'); break; }
      }
    } catch (failure) {
      if (!created) throw failure;
      const reason = failureCode(failure);
      if (current().status === 'running') {
        if (attemptId) {
          this.#store.recordOutcome(task.taskId, attemptId, { status: 'outcome_unknown', error: { code: reason, message: 'The action requires reconciliation.' } },
            unknownVerification(reason), version());
        } else stop(reason === 'runtime_cancelled' ? 'cancelled' : reason === 'budget_exceeded' ? 'failed' : 'waiting_analysis', reason);
      }
    } finally {
      clearTimeout(timer);
      this.#active.delete(task.taskId);
    }
    return this.#store.getRun(task.taskId);
  }
}
