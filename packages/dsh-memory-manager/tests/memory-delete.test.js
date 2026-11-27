import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemoryDelete } from '../src/memory-delete.js';

test('L1-L3 self-delete into the matching archive with correct layer', () => {
  for (const [zone, layer] of [['functions', 'L2'], ['insights', 'L1'], ['capabilities', 'L3']]) {
    const p = planMemoryDelete({ zone, name: 'foo' });
    assert.equal(p.ok, true);
    assert.equal(p.layer, layer);
    assert.equal(p.source, `${zone}/foo.md`);
    assert.equal(p.archive, `${zone}/_deleted/foo.md`);
  }
});

test('dao (L0) is refused at the tool layer and points to the human panel path', () => {
  const p = planMemoryDelete({ zone: 'dao', name: 'foo' });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'human_gate_required');
  assert.match(p.message, /面板|人工/);
});

test('unsupported zone and unsafe name never resolve an identity', () => {
  for (const bad of [{ zone: 'daily', name: '2026-11-23' }, { zone: '', name: 'x' }, { zone: 'functions', name: '' }]) {
    assert.equal(planMemoryDelete(bad).ok, false);
  }
  for (const name of ['../x', 'a/b', 'a\\b', '..', 'a:b', 'x'.repeat(121)]) {
    const p = planMemoryDelete({ zone: 'functions', name });
    assert.equal(p.ok, false, name);
    assert.equal(p.code, 'invalid_name');
  }
});

test('caller cannot declare a layer to bypass the dao gate', () => {
  const p = planMemoryDelete({ zone: 'dao', name: 'foo', layer: 'L2', force: true });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'human_gate_required');
});
