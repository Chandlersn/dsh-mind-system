import path from 'node:path';
import { createRequire } from 'node:module';
import { loadHost } from './host.js';
import { initGrowth, applyGrowth, growthStateSchema } from './growth-cycle-projection.js';

/** Keep derived evidence in Host session projections, not a second event log. */
export function installGrowthProjection(ctx) {
  let current = null;
  if (typeof ctx.inject !== 'function') return { stateOf: async () => null, status: () => 'unavailable' };
  ctx.inject(['sessionProjections'], scoped => {
    if (!scoped.sessionProjections?.register) return;
    const owner = { disposed: false, handle: null, failure: null, ready: null };
    current = owner;
    owner.ready = (async () => {
      const requireHost = createRequire(path.join(loadHost().root, 'package.json'));
      const projectionPackage = requireHost.resolve('@deepseek-ai/dsh-session-projection/package.json');
      const { z } = createRequire(projectionPackage)('zod');
      const registered = await scoped.sessionProjections.register({
        key: 'mind-growth-cycle', stateVersion: 2,
        stateSchema: growthStateSchema(z), init: initGrowth, apply: applyGrowth,
      });
      if (owner.disposed) await registered.dispose();
      else owner.handle = registered;
    })().catch(error => { owner.failure = String(error?.message ?? error); });
    scoped.effect(() => async () => {
      owner.disposed = true;
      if (current === owner) current = null;
      const old = owner.handle;
      owner.handle = null;
      if (old) await old.dispose();
    });
  });
  return {
    async stateOf(session) {
      const owner = current;
      if (!owner) return null;
      await owner.ready;
      if (current !== owner || owner.disposed) return null;
      if (owner.failure) throw new Error(`growth_projection_registration_failed:${owner.failure}`);
      return owner.handle ? owner.handle.stateOf(session) : null;
    },
    status: () => !current ? 'unavailable' : current.failure ? 'failed' : current.handle ? 'available' : 'initializing',
  };
}
