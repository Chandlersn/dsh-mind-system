import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalObjectKey } from '../src/object-key.js';

test('canonical keys are stable for every tracked object form', () => {
  const cases = [
    ['MEMORY.md', 'MEMORY.md'],
    ['2026-11-23.md', '2026-11-23.md'],
    ['daily/2026-11.md', 'daily/2026-11.md'],
    ['functions/foo.md', 'functions/foo.md'],
    ['insights/foo.md', 'insights/foo.md'],
    ['dao/foo.md', 'dao/foo.md'],
    ['capabilities/foo.md', 'capabilities/foo.md'],
    ['dao/_candidates/foo.md', 'dao/_candidates/foo.md'],
    ['skills/detached-restart/SKILL.md', 'skills/detached-restart/SKILL.md'],
  ];
  for (const [input, expected] of cases) assert.equal(canonicalObjectKey(input), expected, input);
});

test('alias spellings fold to the same key, case preserved', () => {
  assert.equal(canonicalObjectKey('.\\functions\\foo.md'), 'functions/foo.md');
  assert.equal(canonicalObjectKey('./functions/foo.md'), 'functions/foo.md');
  assert.equal(canonicalObjectKey('functions/foo'), 'functions/foo.md');
  assert.equal(canonicalObjectKey('functions/Foo.md'), 'functions/Foo.md');
  assert.notEqual(canonicalObjectKey('functions/Foo.md'), canonicalObjectKey('functions/foo.md'));
  assert.equal(canonicalObjectKey('file:///C:/m/skills/detached-restart/SKILL.md'), 'skills/detached-restart/SKILL.md');
});

test('cross-zone same name stays distinct; unknown forms are undefined, never invented', () => {
  assert.notEqual(canonicalObjectKey('functions/foo.md'), canonicalObjectKey('insights/foo.md'));
  for (const bad of [undefined, '', '../x/functions/foo.md', '/abs/functions/foo.md', 'C:\\x\\foo.md',
    'functions/../insights/foo.md', 'other/foo.md', 'functions/.hidden.md', 'functions/MEMORY.md',
    'functions/2026-11-23.md', 'skills/a%2Fb/SKILL.md', 'file:///C:/x/readme.md']) {
    assert.equal(canonicalObjectKey(bad), undefined, String(bad));
  }
});
