import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAcceptanceContract } from '../src/contracts.js';

const valid = () => ({ schemaVersion: 1, predicate: { id: 'file_sha256', version: 1 },
  output: { path: 'reports/result.json', sha256: 'a'.repeat(64) } });

test('acceptance contract validation produces an independent exact snapshot', () => {
  const input = valid();
  const result = validateAcceptanceContract(input);
  assert.deepEqual(result, input);
  input.output.path = 'changed';
  input.predicate.id = 'changed';
  assert.equal(result.output.path, 'reports/result.json');
  assert.equal(result.predicate.id, 'file_sha256');
});

test('acceptance contract rejects traversal, platform paths and malformed metadata', () => {
  const paths = ['', '.', '..', '../a', 'a/../b', '/absolute', 'a//b', 'a\\b', 'C:/a',
    'a/NUL.txt', 'con', 'a./b', 'a b', 'a\0b', 'a'.repeat(513)];
  for (const path of paths) {
    const value = valid();
    value.output.path = path;
    assert.throws(() => validateAcceptanceContract(value), { code: 'invalid_acceptance_contract' }, path);
  }
  for (const change of [
    (x) => { x.schemaVersion = 2; }, (x) => { x.predicate.version = 2; },
    (x) => { x.predicate.id = 'other'; }, (x) => { x.output.sha256 = 'A'.repeat(64); },
    (x) => { x.output.sha256 = 'a'.repeat(63); }, (x) => { x.extra = true; },
    (x) => { x.output.extra = true; }, (x) => { delete x.output.path; },
  ]) {
    const value = valid();
    change(value);
    assert.throws(() => validateAcceptanceContract(value), { code: 'invalid_acceptance_contract' });
  }
});

test('acceptance contract rejects accessors, symbols and exotic objects without invoking getters', () => {
  const value = valid();
  Object.defineProperty(value.output, 'path', { enumerable: true, get() { throw new Error('getter invoked'); } });
  assert.throws(() => validateAcceptanceContract(value), { code: 'invalid_acceptance_contract' });
  const withSymbol = valid();
  withSymbol[Symbol('extra')] = true;
  assert.throws(() => validateAcceptanceContract(withSymbol), { code: 'invalid_acceptance_contract' });
  const exotic = valid();
  Object.setPrototypeOf(exotic.output, Date.prototype);
  assert.throws(() => validateAcceptanceContract(exotic), { code: 'invalid_acceptance_contract' });
});
