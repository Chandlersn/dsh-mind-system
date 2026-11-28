const MAX_ACTIVE = 1024;
const MAX_SUBSCRIBERS = 128;
const ACTIVE_TIMEOUT_MS = 60_000;
const MIN_TTL_MS = 5_000;
const DEFAULT_TTL_MS = 120_000;
const MAX_TTL_MS = 300_000;
const DIRECT = new Map([
  ['memory_write', 'e2'], ['memory_insight', 'e3'],
]);

function edgeFor(exec) {
  if (!exec || typeof exec !== 'object') return null;
  const direct = DIRECT.get(exec.name);
  if (direct) return direct;
  const args = exec.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (exec.name === 'memory_dao' && (args.status === undefined || args.status === 'active' || args.status === 'candidate')) return 'e4';
  if (exec.name === 'memory_read' && args.kind === 'index') return 'e11';
  if (exec.name === 'memory_index') return args.zone === 'functions' ? 'e6' : args.zone === 'insights' ? 'e7' : null;
  if (exec.name === 'memory_usage' && args.action === 'record') return 'e14';
  if (exec.name === 'memory_sag' && (args.action === undefined || args.action === 'search')) return 'e15';
  return null;
}

/** Track execution observations only; snapshots never contain calls or results. */
export function createLiveFlow({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const ttl = Number.isFinite(ttlMs) ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs)) : MIN_TTL_MS;
  const active = new Map();
  const recent = new Map();
  let dropped = 0;
  const countDrop = () => { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); };
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite number');
    return value;
  };
  const remember = (edge, phase, at, details) => {
    const previous = recent.get(edge);
    if (!previous || at >= previous.at) recent.set(edge, { phase, at, expiresAt: at + ttl, ...details });
  };
  const expire = time => {
    for (const [id, call] of active) {
      if (time >= call.expiresAt) {
        active.delete(id);
        remember(call.edge, 'unknown', call.expiresAt, call.details);
      }
    }
    for (const [edge, entry] of recent) if (time >= entry.expiresAt) recent.delete(edge);
  };
  const validToken = token => typeof token === 'symbol';
  const subscribers = new Set();
  const snapshot = () => {
    const time = clock();
    expire(time);
    const edges = {};
    for (const [edge, entry] of recent) edges[edge] = { ...entry };
    for (const call of active.values()) {
      const current = edges[call.edge];
      if (!current || current.phase !== 'active' || call.at >= current.at) {
        edges[call.edge] = { phase: 'active', at: call.at, expiresAt: call.expiresAt, ...call.details };
      }
    }
    return { edges, dropped };
  };
  const notify = () => {
    for (const listener of subscribers) {
      try { listener(snapshot()); } catch { /* Observers cannot affect execution. */ }
    }
  };
  const begin = (edge, token, details) => {
    const time = clock();
    expire(time);
    if (!validToken(token) || active.has(token) || active.size >= MAX_ACTIVE) {
      countDrop();
      notify();
      return false;
    }
    active.set(token, { edge, at: time, expiresAt: time + ACTIVE_TIMEOUT_MS, details });
    notify();
    return true;
  };
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      if (subscribers.size >= MAX_SUBSCRIBERS) throw new Error('live flow subscriber limit reached');
      const subscription = value => listener(value);
      subscribers.add(subscription);
      return () => subscribers.delete(subscription);
    },
    start(exec) {
      const edge = edgeFor(exec);
      if (edge) begin(edge, exec.token);
    },
    automaticSagStarted() {
      const token = Symbol();
      const source = 'automatic';
      if (!begin('e15', token, { source })) return;
      return outcome => {
        const time = clock();
        expire(time);
        if (!active.delete(token)) return;
        if (!['success', 'failed', 'timeout', 'cancelled'].includes(outcome)) outcome = 'unknown';
        const phase = outcome === 'success' ? 'finished' : outcome === 'failed' || outcome === 'timeout' ? 'failed' : 'unknown';
        remember('e15', phase, time, { source, outcome });
        notify();
      };
    },
    finish(exec, result) {
      const edge = edgeFor(exec);
      if (!edge) return;
      const time = clock();
      expire(time);
      const call = validToken(exec.token) ? active.get(exec.token) : undefined;
      if (!call || call.edge !== edge) {
        countDrop();
        remember(edge, 'unknown', time);
        notify();
        return;
      }
      active.delete(exec.token);
      const phase = result?.isError === true ? 'failed' : result?.isError === false ? 'finished' : 'unknown';
      remember(edge, phase, time);
      notify();
    },
    capabilityIndexed() {
      const time = clock();
      expire(time);
      remember('e9', 'finished', time);
      notify();
    },
    usageMatched() {
      remember('e13', 'finished', clock());
      notify();
    },
    indexMatched(source) {
      if (source !== 'cache' && source !== 'disk') return;
      const time = clock();
      expire(time);
      const previous = recent.get('e10');
      if (!previous || time >= previous.at) {
        recent.set('e10', { phase: 'finished', at: time, expiresAt: time + ttl, source });
      }
      notify();
    },
    recallJoined(includesSag) {
      const time = clock();
      expire(time);
      remember('e12', 'finished', time, includesSag === true ? { includesSag: true } : undefined);
      notify();
    },
    snapshot,
  };
}
