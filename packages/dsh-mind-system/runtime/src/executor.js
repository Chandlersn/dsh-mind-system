import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { jsonSnapshot, requireString, RuntimeContractError, validateCandidate } from './contracts.js';

function requireSignal(signal) {
  if (!(signal instanceof AbortSignal)) {
    throw new RuntimeContractError('executor_config', 'A caller-owned AbortSignal is required.');
  }
  return signal;
}

function errorSummary(error, fallback = 'tool_failed') {
  const code = error?.code ?? error?.info?.code;
  return {
    code: typeof code === 'string' ? code : fallback,
    message: typeof error?.message === 'string' ? error.message : String(error ?? 'Tool execution failed.'),
  };
}

/** Dispatch admitted candidates exclusively through the public host pipeline. */
export class HostExecutor {
  #context;
  #tools;
  #agent;
  #signal;
  #rootCallId;
  #parent;
  #active = new Set();
  #observers = new Set();
  #closed = false;
  #disposal;

  constructor({ context, tools, agent, signal, rootCallId, parent }) {
    if (typeof context?.on !== 'function' || typeof tools?.execute !== 'function' || !agent) {
      throw new RuntimeContractError('executor_config', 'Host context, public tools runtime, and explicit caller agent are required.');
    }
    if (signal !== undefined) requireSignal(signal);
    if (rootCallId !== undefined) requireString(rootCallId, 'rootCallId');
    if (parent !== undefined && typeof parent !== 'symbol') {
      throw new RuntimeContractError('executor_config', 'parent must be an actual host execution token.');
    }
    this.#context = context;
    this.#tools = tools;
    this.#agent = agent;
    Object.defineProperty(this, 'agent', { value: agent, enumerable: true });
    this.#signal = signal;
    this.#rootCallId = rootCallId;
    this.#parent = parent;
  }

  get agent() { return this.#agent; }

  async execute(candidate, { callId, signal, beforeDispatch } = {}) {
    if (this.#closed) throw new RuntimeContractError('executor_disposed', 'The executor is disposed.');
    requireString(callId, 'callId');
    const callerSignal = requireSignal(signal ?? this.#signal);
    if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') {
      throw new RuntimeContractError('executor_config', 'beforeDispatch must be a function.');
    }
    const value = validateCandidate(candidate);
    const fused = this.#signal && signal && this.#signal !== signal
      ? AbortSignal.any([this.#signal, signal]) : callerSignal;
    // A private host ID prevents another caller's events from changing our evidence.
    const hostCallId = `${callId}:${randomUUID()}`;
    const work = this.#run(value, { callId, hostCallId, signal: fused, beforeDispatch });
    this.#active.add(work);
    try { return await work; } finally { this.#active.delete(work); }
  }

  async #run(candidate, { callId, hostCallId, signal, beforeDispatch }) {
    let dispatchEntered = false;
    let hookError;
    let cancelled = signal.aborted;
    const onAbort = () => { cancelled = true; };
    signal.addEventListener('abort', onAbort, { once: true });
    let remove;
    let removeBinding;
    let ownedExecution;
    const verifyBinding = (exec) => {
      if (exec.callId !== hostCallId || exec.agent !== this.#agent || exec.name !== candidate.toolName
        || (this.#rootCallId !== undefined && exec.rootCallId !== this.#rootCallId)
        || exec.parent !== this.#parent || !isDeepStrictEqual(exec.arguments, candidate.arguments)) {
        throw new RuntimeContractError('execution_binding_mismatch', 'The live host call differs from the admitted action.');
      }
    };
    try {
      // Bind only our private execution before ordinary policies and around wrappers.
      removeBinding = this.#context.on('tools/pre-execute', async (exec, next) => {
        if (exec.callId !== hostCallId) return next();
        try {
          verifyBinding(exec);
          ownedExecution = exec;
          for (const key of ['callId', 'rootCallId', 'name', 'agent', 'parent', 'arguments', 'token']) {
            Object.defineProperty(exec, key, { value: exec[key], enumerable: Object.hasOwn(exec, key),
              writable: false, configurable: false });
          }
        } catch (error) { hookError = errorSummary(error, 'execution_binding_mismatch'); throw error; }
        return next();
      }, { prepend: true, global: true });
      this.#observers.add(removeBinding);
      remove = this.#context.on('tools/execute', async (exec, next) => {
        if (exec !== ownedExecution) return next();
        try {
          verifyBinding(exec);
          if (beforeDispatch) await beforeDispatch();
          verifyBinding(exec);
          // Cancellation during the hook must not initiate a tool body.
          signal.throwIfAborted();
        } catch (error) {
          hookError = errorSummary(error, signal.aborted ? 'ABORTED_BEFORE_DISPATCH' : 'before_dispatch_failed');
          throw error;
        }
        dispatchEntered = true;
        return next();
      });
      this.#observers.add(remove);
      const input = {
        callId: hostCallId, name: candidate.toolName, arguments: candidate.arguments,
        agent: this.#agent, signal,
        ...(this.#rootCallId === undefined ? {} : { rootCallId: this.#rootCallId }),
        ...(this.#parent === undefined ? {} : { parent: this.#parent }),
      };
      // Await the complete host pipeline, including post policies and cancellation drain.
      const raw = await this.#tools.execute(input);
      const base = { callId, hostCallId, dispatchEntered, cancelled };
      if (!raw || typeof raw.isError !== 'boolean') throw new Error('Host returned an invalid execution result.');
      if (hookError || raw.isError) {
        const error = hookError ?? errorSummary(raw.error ?? {
          message: raw.content?.map((part) => part.text ?? '').join('\n') || 'Tool execution failed.',
        });
        return { ...base, status: this.#failureStatus(candidate, dispatchEntered), error };
      }
      if (!dispatchEntered) return { ...base, status: 'outcome_unknown',
        error: { code: 'dispatch_not_observed', message: 'The host returned success without the owned dispatch admission hook.' } };
      return { ...base, status: 'succeeded', ...(raw.value === undefined ? {} : { output: jsonSnapshot(raw.value) }) };
    } catch (error) {
      return {
        callId, hostCallId, dispatchEntered, cancelled,
        status: this.#failureStatus(candidate, dispatchEntered),
        error: hookError ?? errorSummary(error, 'host_execution_failed'),
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      for (const dispose of [remove, removeBinding]) {
        if (dispose) { await dispose(); this.#observers.delete(dispose); }
      }
    }
  }

  #failureStatus(candidate, entered) {
    if (!entered) return 'not_started';
    return candidate.effect === 'read' ? 'failed' : 'outcome_unknown';
  }

  /** Stop accepting calls, drain every owned execution, then remove observers. */
  dispose() {
    if (!this.#disposal) {
      this.#closed = true;
      this.#disposal = (async () => {
        await Promise.allSettled([...this.#active]);
        for (const remove of this.#observers) await remove();
        this.#observers.clear();
      })();
    }
    return this.#disposal;
  }
}
