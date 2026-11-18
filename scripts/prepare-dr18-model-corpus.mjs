import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCase } from '../packages/dsh-execution-runtime/scripts/verify-dr18-arms.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = rows => `${JSON.stringify(rows, null, 2)}\n`;
const baseline = JSON.parse(readFileSync(new URL('../docs/dr18-host-20261118.json', import.meta.url)));
const cases = [];
for (const size of baseline.corpus.sizes) {
  for (let i = 0; i < baseline.corpus.repetitions; i++) {
    const { source, expected } = makeCase(size, size * 101 + i);
    cases.push({ id: `${size}-${i}`, source: i ? source : expected, expected });
  }
}
cases.push({ id: 'empty', source: encode([]), expected: encode([]) }, {
  id: 'case-order', source: encode([{ id: 'z', name: ' z ' }, { id: 'a', name: ' a ' }, { id: 'A', name: ' A ' }]),
  expected: encode([{ id: 'A', name: 'A' }, { id: 'a', name: 'a' }, { id: 'z', name: 'z' }]),
}, {
  id: 'unicode', source: encode([{ id: 'b', name: ' café ' }, { id: 'a', name: '\t東京\n' }]),
  expected: encode([{ id: 'a', name: '東京' }, { id: 'b', name: 'café' }]),
});
const corpusSha256 = hash(JSON.stringify(cases));
if (corpusSha256 !== baseline.corpus.sha256) throw new Error('Corpus differs from the committed rule-arm inputs and expected bytes.');
const root = mkdtempSync(join(tmpdir(), 'dr18-model-'));
const manifest = { corpusSha256, cases: cases.map(({ id, source, expected }) => {
  const workspace = join(root, id);
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.json'), source, { flag: 'wx' });
  return { id, workspace, input: 'input.json', output: 'output.json', inputSha256: hash(source), expectedSha256: hash(expected) };
}) };
const manifestPath = join(root, 'manifest.json');
writeFileSync(manifestPath, encode(manifest), { flag: 'wx' });
console.log(manifestPath);
