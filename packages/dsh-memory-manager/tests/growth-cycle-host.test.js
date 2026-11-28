import test from 'node:test';
import assert from 'node:assert/strict';
import { installGrowthProjection } from '../src/growth-cycle-host.js';

function fixture(register) {
  const disposers = [];
  return {
    disposers,
    inject(names, callback) {
      assert.deepEqual(names, ['sessionProjections']);
      callback({ sessionProjections: { register }, effect(fn) { disposers.push(fn()); } });
    },
  };
}

test('projection registration is awaited before reading the native session', async () => {
  let release, definition, disposed = false, seen;
  const context = fixture(value => {
    definition = value;
    return new Promise(resolve => { release = () => resolve({ stateOf(session) { seen = session; return definition.init(session.header, 0); }, async dispose() { disposed = true; } }); });
  });
  const projection = installGrowthProjection(context);
  assert.equal(projection.status(), 'initializing');
  const session = { header: { id: 'native-session', cwd: process.cwd() } };
  const pending = projection.stateOf(session);
  release();
  const state = await pending;
  assert.equal(seen, session);
  assert.equal(state.sessionId, 'native-session');
  assert.deepEqual(definition.stateSchema.parse(state), state);
  assert.equal(projection.status(), 'available');
  await context.disposers[0]();
  assert.equal(disposed, true);
  assert.equal(await projection.stateOf(session), null);
});

test('missing service and failed registration remain explicit', async () => {
  assert.equal(await installGrowthProjection({}).stateOf({}), null);
  const projection = installGrowthProjection(fixture(async () => { throw new Error('registration failed'); }));
  await assert.rejects(projection.stateOf({}), /growth_projection_registration_failed/);
  assert.equal(projection.status(), 'failed');
});

test('a failed old registration cannot poison its replacement service', async () => {
  let callback, rejectOld;
  const disposers = [];
  const projection = installGrowthProjection({ inject(_names, fn) { callback = fn; } });
  callback({ sessionProjections: { register: () => new Promise((_resolve, reject) => { rejectOld = reject; }) }, effect(fn) { disposers.push(fn()); } });
  await disposers[0]();
  callback({ sessionProjections: { register: async () => ({ stateOf: () => ({ sessionId: 'replacement' }), dispose: async () => {} }) }, effect(fn) { disposers.push(fn()); } });
  rejectOld(new Error('old registration failed'));
  assert.deepEqual(await projection.stateOf({}), { sessionId: 'replacement' });
  assert.equal(projection.status(), 'available');
  await disposers[1]();
});

test('disposal while registration is pending cannot publish a late handle', async () => {
  let release, disposed = false;
  const context = fixture(() => new Promise(resolve => { release = () => resolve({ stateOf() { throw Error('late handle used'); }, async dispose() { disposed = true; } }); }));
  const projection = installGrowthProjection(context);
  context.disposers[0]();
  release();
  assert.equal(await projection.stateOf({}), null);
  assert.equal(disposed, true);
});
