// Coalesce activity-driven checks. The caller decides whether a turn is eligible.
// No interval is installed, and a slow scan cannot hold up a conversation.
export function createActivityHealthCheck(check, { now = Date.now, waitMs = 75 } = {}) {
  let flight;
  let nextAttemptAt = 0;
  let lastState = 'cooldown';
  return async function refresh() {
    if (!flight && now() < nextAttemptAt) return { state: lastState };
    if (!flight) {
      flight = Promise.resolve().then(check).then(report => {
        if (report.trackingFailures?.length || report.reconciliation?.some(row => row.status !== 'resolved')) throw new Error('Incomplete inbox reconciliation');
        lastState = 'cooldown';
        nextAttemptAt = now() + 86_400_000;
        return { state: 'ok' };
      }).catch(() => {
        lastState = 'failed';
        nextAttemptAt = now() + 60_000;
        return { state: 'failed' };
      }).finally(() => { flight = undefined; });
    }
    let timer;
    try {
      return await Promise.race([flight, new Promise(resolve => {
        timer = setTimeout(() => resolve({ state: 'pending' }), waitMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
}
