import { RuntimeContractError, requireString } from './contracts.js';
import { approvalApplies, rejectBorrowedTicket } from './pattern-approval.js';

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/**
 * Bridge a runtime pattern to the existing valve rule store. The runtime never writes rules itself: it
 * only calls the host-provided writer, which enforces its own human gate, and it refuses to call it
 * without a confirmed approval for the current pattern version.
 */
export function createValveWriter({ confirmRule } = {}) {
  if (typeof confirmRule !== 'function') {
    fail('invalid_valve_writer', 'A host-supplied confirmRule function is required; the runtime cannot sign its own tickets.');
  }
  return async function writeApprovedPattern({ approval, pattern, now = Date.now }) {
    rejectBorrowedTicket(pattern);
    const decision = approvalApplies(approval, pattern, { now });
    if (!decision.applies) {
      // Refusing here is the whole point: a stale or absent approval must not reach the rule store.
      fail('approval_not_effective', `Refusing to write: ${decision.reason}.`);
    }
    const rule = { id: pattern.patternId, statement: pattern.statement, negative_type: pattern.negativeType,
      keywords: [...pattern.keywords], layer: pattern.layer ?? undefined, source: 'runtime_approved_pattern' };
    let result;
    try {
      // No `human` flag and no permit are passed: the runtime has no authority to self-confirm.
      result = await confirmRule(rule, { via: 'runtime', ruleVersion: approval.patternVersion });
    } catch (failure) {
      fail('valve_write_failed', `The valve store rejected the write: ${failure?.message ?? 'unknown error'}`);
    }
    if (!result || result.ok !== true) {
      fail('valve_write_rejected', `The valve store did not accept the rule: ${result?.error ?? 'no reason'}`);
    }
    return Object.freeze({ written: true, ruleId: pattern.patternId, patternVersion: approval.patternVersion });
  };
}

/** Apply path: only a confirmed, unexpired, version-matched approval produces an active rule reference. */
export function patternAllowsDecision(approval, pattern, { now = Date.now } = {}) {
  requireString(pattern?.patternId, 'patternId');
  const decision = approvalApplies(approval, pattern, { now });
  return Object.freeze({ active: decision.applies, reason: decision.reason, patternId: pattern.patternId });
}
