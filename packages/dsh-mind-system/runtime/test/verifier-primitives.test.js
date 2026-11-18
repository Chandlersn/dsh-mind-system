import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVerifier, VERIFIER_PRIMITIVES, describePrimitives } from '../src/verifier-primitives.js';

/**
 * The two primitives added after the first three proved too narrow.
 *
 * `sorted_lines` and `json_fields` both judge a *relation* — to the input, or to declared values — rather
 * than merely the artifact's own shape. That is what makes claims like "sorted the file" or "wrote the
 * totals" falsifiable; before them, any sorted list or any well-formed object would pass.
 *
 * Every primitive is exercised both ways. A positive case alone cannot tell a working predicate from one
 * that always says yes, which is exactly the gap a mutation survived in an earlier round.
 */

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'verifier-primitives-'));
  return root;
};

/** Run a verifier against files placed in a temp workspace through a metered-looking io shim. */
async function verifyWith({ primitive, parameters, files, taskInputs }) {
  const root = workspace();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const { readFileSync } = await import('node:fs');
  const verifier = buildVerifier({ primitive, parameters });
  const task = { taskId: 't', workspaceRoot: root,
    inputs: taskInputs ?? { inputFile: 'in.txt', outputFile: 'out.txt' } };
  const verdict = await verifier.verify({ task, state: {}, io: {
    readFileSync: (path) => readFileSync(path) } });
  return verdict;
}

test('sorted_lines accepts a true reordering and rejects everything else', async () => {
  const params = { primitive: 'sorted_lines', parameters: { expectAscending: true } };
  // The relation holds: same three lines, now ascending.
  const good = await verifyWith({ ...params, files: { 'in.txt': 'c\na\nb\n', 'out.txt': 'a\nb\nc\n' } });
  assert.equal(good.status, 'pass', JSON.stringify(good));
  assert.equal(good.goalSatisfied, true);
  assert.ok(good.evidenceRefs.length >= 2, 'A pass must carry evidence for both files.');

  // Same lines, wrong order — an artifact-only predicate would have accepted this too.
  const unordered = await verifyWith({ ...params, files: { 'in.txt': 'c\na\nb\n', 'out.txt': 'b\na\nc\n' } });
  assert.equal(unordered.status, 'fail');
  assert.match(unordered.reason, /not_ascending/);

  // A line silently dropped: sorted, but no longer the same content.
  const dropped = await verifyWith({ ...params, files: { 'in.txt': 'c\na\nb\n', 'out.txt': 'a\nb\n' } });
  assert.equal(dropped.status, 'fail');
  assert.match(dropped.reason, /line_counts_differ/);

  // An invented line keeps the count but changes the content.
  const invented = await verifyWith({ ...params, files: { 'in.txt': 'c\na\nb\n', 'out.txt': 'a\nb\nz\n' } });
  assert.equal(invented.status, 'fail');
  assert.match(invented.reason, /line_multiset_differs/);
});

test('sorted_lines counts duplicates instead of collapsing them', async () => {
  // A sort that de-duplicates would keep the set correct while losing a row; counting is what catches it.
  const params = { primitive: 'sorted_lines', parameters: { expectAscending: true } };
  const ok = await verifyWith({ ...params, files: { 'in.txt': 'b\na\nb\n', 'out.txt': 'a\nb\nb\n' } });
  assert.equal(ok.status, 'pass', JSON.stringify(ok));
  const deduped = await verifyWith({ ...params, files: { 'in.txt': 'b\na\nb\n', 'out.txt': 'a\nb\n' } });
  assert.equal(deduped.status, 'fail');

  // Same line *count*, different multiset: the length check cannot catch this, so only the counting can.
  // Without this case a set-based implementation would pass every assertion above.
  const swapped = await verifyWith({ ...params, files: { 'in.txt': 'a\na\nb\n', 'out.txt': 'a\nb\nb\n' } });
  assert.equal(swapped.status, 'fail', 'A duplicate replaced by another line must not pass.');
  assert.match(swapped.reason, /multiset/);
});

test('sorted_lines honours a descending declaration', async () => {
  const files = { 'in.txt': 'a\nc\nb\n', 'out.txt': 'c\nb\na\n' };
  const desc = await verifyWith({ primitive: 'sorted_lines', parameters: { expectAscending: false }, files });
  assert.equal(desc.status, 'pass', JSON.stringify(desc));
  // The same artifact must fail under the opposite declaration, or the flag is not actually read.
  const asc = await verifyWith({ primitive: 'sorted_lines', parameters: { expectAscending: true }, files });
  assert.equal(asc.status, 'fail');
});

test('sorted_lines treats an empty file as zero lines, not one empty line', async () => {
  // Empty input and empty output is a legitimate no-op, and must pass on counts rather than on parsing luck.
  const empty = await verifyWith({ primitive: 'sorted_lines', parameters: {},
    files: { 'in.txt': '', 'out.txt': '' } });
  assert.equal(empty.status, 'pass', JSON.stringify(empty));
  // An empty output against a non-empty input is a deletion, not a sort.
  const lost = await verifyWith({ primitive: 'sorted_lines', parameters: {},
    files: { 'in.txt': 'a\n', 'out.txt': '' } });
  assert.equal(lost.status, 'fail');
});

test('json_fields compares values strictly, with no coercion', async () => {
  const params = { primitive: 'json_fields', parameters: { expected: { total: 3, status: 'ok' } } };
  const good = await verifyWith({ ...params,
    files: { 'in.txt': 'x', 'out.txt': JSON.stringify({ total: 3, status: 'ok', extra: true }) } });
  assert.equal(good.status, 'pass', JSON.stringify(good));
  assert.equal(good.goalSatisfied, true);

  // "3" is not 3: a verifier that coerced would pass an artifact the caller never produced.
  const coerced = await verifyWith({ ...params,
    files: { 'in.txt': 'x', 'out.txt': JSON.stringify({ total: '3', status: 'ok' }) } });
  assert.equal(coerced.status, 'fail');
  assert.match(coerced.reason, /total/);

  const wrong = await verifyWith({ ...params,
    files: { 'in.txt': 'x', 'out.txt': JSON.stringify({ total: 3, status: 'bad' }) } });
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.reason, /status/);

  // A missing field must be a mismatch, not silently skipped.
  const absent = await verifyWith({ ...params, files: { 'in.txt': 'x', 'out.txt': JSON.stringify({ total: 3 }) } });
  assert.equal(absent.status, 'fail');
});

test('json_fields refuses non-object output and declares its own failures', async () => {
  const params = { primitive: 'json_fields', parameters: { expected: { a: 1 } } };
  const array = await verifyWith({ ...params, files: { 'in.txt': 'x', 'out.txt': '[1,2]' } });
  assert.equal(array.status, 'fail');
  assert.equal(array.reason, 'output_not_an_object');
  const broken = await verifyWith({ ...params, files: { 'in.txt': 'x', 'out.txt': '{oops' } });
  assert.equal(broken.status, 'fail');
  assert.equal(broken.reason, 'output_invalid_json');
});

test('both new primitives reject an absent artifact rather than guessing', async () => {
  for (const primitive of ['sorted_lines', 'json_fields']) {
    const parameters = primitive === 'json_fields' ? { expected: { a: 1 } } : {};
    const verdict = await verifyWith({ primitive, parameters, files: { 'in.txt': 'a\n' } });
    assert.equal(verdict.status, 'fail', primitive);
    assert.equal(verdict.reason, 'output_absent', primitive);
    assert.equal(verdict.goalSatisfied, false, primitive);
  }
});

test('the vocabulary stays closed and introspectable after the additions', () => {
  assert.deepEqual([...VERIFIER_PRIMITIVES],
    ['exact_bytes', 'line_set', 'structure', 'sorted_lines', 'json_fields']);
  const described = describePrimitives();
  assert.equal(described.length, VERIFIER_PRIMITIVES.length);
  // Each entry must explain itself well enough to be chosen without reading source.
  assert.ok(described.every((item) => typeof item.describe === 'string' && item.describe.length > 20));
  // An unregistered name is refused, never downgraded to something weaker.
  assert.throws(() => buildVerifier({ primitive: 'sorted_liness' }), { code: 'invalid_verifier_primitive' });
});
