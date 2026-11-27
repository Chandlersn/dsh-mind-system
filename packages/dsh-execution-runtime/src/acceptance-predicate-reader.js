import path from 'node:path';
import { validateAcceptanceContract } from './contracts.js';
import { readArtifactEvidence } from './artifact-evidence-reader.js';

const result = (status, reason) => ({ status, reason, goalProof: 'not_evaluated',
  principleAttribution: 'not_evaluated', governanceEligible: false });

/**
 * Review a trusted host-owned contract against bytes at read time only.
 * This inherits the evidence reader's byte limits and cooperative filesystem boundary.
 * A predicate match is neither a historical outcome nor proof of goal achievement.
 */
export function readAcceptancePredicate(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return result('error', 'invalid_input');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes('workspaceRoot') || !keys.includes('contract')) return result('error', 'invalid_input');
    const rootProperty = Object.getOwnPropertyDescriptor(input, 'workspaceRoot');
    const contractProperty = Object.getOwnPropertyDescriptor(input, 'contract');
    if (!rootProperty?.enumerable || !Object.hasOwn(rootProperty, 'value')
      || !contractProperty?.enumerable || !Object.hasOwn(contractProperty, 'value')) return result('error', 'invalid_input');
    let contract;
    try { contract = validateAcceptanceContract(contractProperty.value); }
    catch { return result('error', 'invalid_contract'); }
    const workspaceRoot = rootProperty.value;
    if (typeof workspaceRoot !== 'string' || !workspaceRoot || workspaceRoot.length > 32768
      || workspaceRoot.includes('\0') || !path.isAbsolute(workspaceRoot)
      || (process.platform === 'win32' ? (!/^(?:[a-z]:[\\/]|\\\\[^\\?.])/i.test(workspaceRoot)
        || workspaceRoot.slice(2).includes(':')) : workspaceRoot.startsWith('//'))) {
      return result('error', 'invalid_workspace_root');
    }
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(root, ...contract.output.path.split('/'));
    const relative = path.relative(root, target);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return result('unknown', 'outside_workspace');
    }
    const evidence = readArtifactEvidence({ workspaceRoot: root,
      evidenceRefs: [`file:${target}#sha256:${contract.output.sha256}`] });
    const entry = evidence.refs?.[0];
    if (evidence.status === 'match' && entry?.status === 'match' && entry.reason === 'sha256_match') {
      return result('pass', 'sha256_match');
    }
    if (evidence.status === 'mismatch' && entry?.status === 'mismatch' && entry.reason === 'sha256_mismatch') {
      return result('fail', 'sha256_mismatch');
    }
    return result(evidence.status === 'error' ? 'error' : 'unknown', 'evidence_unavailable');
  } catch {
    return result('error', 'review_error');
  }
}
