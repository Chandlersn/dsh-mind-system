import * as fs from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { RuntimeContractError, failureCode, jsonSnapshot, requireString } from '../src/contracts.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const within = (root, target) => {
  const name = relative(root, target);
  return name === '' || (name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(name));
};
const MAX_PROBE_BYTES = 4 * 1024 * 1024;

/**
 * Read-only evidence probes owned by trusted native code. A probe never writes business state and
 * never returns a candidate or repair; it only observes authorized files and returns JSON facts.
 */
export function createProbeRegistry(input = []) {
  if (!Array.isArray(input)) fail('invalid_probe_registry', 'Probes must be registered as a native array.');
  const probes = new Map();
  for (const probe of input) {
    requireString(probe?.probeId, 'probeId');
    requireString(probe.description, 'probe description');
    if (typeof probe.run !== 'function') fail('invalid_probe_registry', 'Every registered probe needs a read-only runner.');
    if (probes.has(probe.probeId)) fail('invalid_probe_registry', 'A probe identity may be registered only once.');
    probes.set(probe.probeId, Object.freeze({ ...probe }));
  }
  return Object.freeze([...probes.values()]);
}

/**
 * Run one allowlisted probe against the authorized workspace. The result is plain JSON facts with an
 * explicit observation summary; it is stored as task evidence so the next analysis can read it by reference.
 */
export async function runEvidenceProbe({ store, probes, task, authority, probeIds, signal,
  io, putEvidence, now = Date.now }) {
  if (!store || !Array.isArray(probes) || !probeIds || !Array.isArray(probeIds) || !probeIds.length) {
    fail('invalid_probe_request', 'An explicit probe allowlist and registered probes are required.');
  }
  if (probeIds.length > 16 || new Set(probeIds).size !== probeIds.length) {
    fail('invalid_probe_request', 'Probe requests must be at most 16 unique identities.');
  }
  if (!authority || authority.scopeRef !== task.scopeRef || typeof authority.workspaceRoot !== 'string') {
    fail('probe_scope_denied', 'Probes require the explicit task authority.');
  }
  const root = fs.realpathSync(authority.workspaceRoot);
  if (fs.realpathSync(task.workspaceRoot) !== root) fail('probe_scope_denied', 'Probes must stay inside the authorized workspace.');
  const registered = new Map(probes.map((probe) => [probe.probeId, probe]));
  const results = [];
  for (const probeId of probeIds) {
    if (signal?.aborted) fail('runtime_cancelled', 'Probe observation was cancelled.');
    const probe = registered.get(probeId);
    if (!probe) {
      results.push({ probeId, status: 'unavailable', reason: 'probe_not_registered' });
      continue;
    }
    let observation;
    try {
      observation = await probe.run({ task: jsonSnapshot(task), workspaceRoot: root, io, signal, now });
    } catch (failure) {
      results.push({ probeId, status: 'failed', reason: failureCode(failure, 'probe_failed') });
      continue;
    }
    const value = jsonSnapshot(observation ?? null);
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw, 'utf8') > MAX_PROBE_BYTES) {
      results.push({ probeId, status: 'failed', reason: 'probe_output_too_large' });
      continue;
    }
    const stored = putEvidence(`probe:${probeId}`, value);
    results.push({ probeId, status: 'observed', ref: stored.ref, bytes: stored.bytes });
  }
  return Object.freeze({ observed: results.filter((item) => item.status === 'observed').length,
    unavailable: results.filter((item) => item.status !== 'observed').length,
    results: Object.freeze(results.map((item) => Object.freeze(item))) });
}

/** A minimal read-only I/O capability for probes; it reuses the scheduler's metered filesystem surface. */
export function probeIo({ workspaceRoot, charge, readLimit = MAX_PROBE_BYTES }) {
  const root = fs.realpathSync(workspaceRoot);
  const target = (name) => {
    if (typeof name !== 'string' || !within(root, resolve(name))) fail('probe_scope_denied', 'Probe I/O must stay inside the authorized workspace.');
    return resolve(name);
  };
  return Object.freeze({
    readFileSync(path, encoding) {
      if (encoding !== undefined && encoding !== 'utf8') fail('invalid_io_options', 'Probes read UTF-8 text or buffers.');
      charge();
      const real = fs.realpathSync(target(path));
      if (!within(root, real)) fail('probe_scope_denied', 'Probe I/O resolved outside the authorized workspace.');
      if (fs.statSync(real).size > readLimit) fail('runtime_io_limit', 'A probe file exceeds the bounded read size.');
      return encoding === 'utf8' ? fs.readFileSync(real, 'utf8') : fs.readFileSync(real);
    },
    lstatSync(path) { charge(); return fs.lstatSync(target(path)); },
    realpathSync(path) { charge(); return fs.realpathSync(target(path)); },
  });
}
