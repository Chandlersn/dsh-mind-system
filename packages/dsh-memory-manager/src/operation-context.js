import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Separate module copies and plugin reloads share one versioned in-process scope.
const CONTEXT = Symbol.for('dsh-memory-manager.operation-context.v1');
const storage = globalThis[CONTEXT] ??= new AsyncLocalStorage();
if (!(storage instanceof AsyncLocalStorage)) throw new Error('memory operation context registry is invalid');

/** Return only the identity of a still-active invocation. */
export function currentOperationId() {
  const scope = storage.getStore();
  return scope?.active === true ? scope.requestId : undefined;
}

/** Generate identity internally; keep it active until all awaited work settles. */
export async function withOperationContext(fn) {
  const scope = { requestId: randomUUID(), active: true };
  return storage.run(scope, async () => {
    try {
      return await fn();
    } finally {
      // Detached callbacks inherit the object, so closing it revokes their identity.
      scope.active = false;
    }
  });
}
