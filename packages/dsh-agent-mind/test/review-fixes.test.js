import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainSituation } from '../src/dispatch.js';
import { hitRate } from '../src/hitrate.js';
import { recordSample, sampleFilePath } from '../src/sampling.js';

test('只读审查的否定修改与 JSON 输出格式不应触发执行', () => {
  const decision = explainSituation('审查配置，只读取文件，不修改任何文件；最终仅输出 JSON。');
  assert.equal(decision.situation, 'diagnose');
  assert.ok(!decision.hits.includes('do-it'));
  assert.ok(!decision.hits.includes('intent-produce'));
  assert.equal(explainSituation('不要修改旧文件，但请修复新的错误').situation, 'execute');
});

test('覆盖率不代表正确率，只有有标签样本进入正确率分母', () => {
  const result = hitRate([
    { text: '请审查配置', expect: 'execute' },
    { text: '帮我改一下这个文件', expect: 'execute' },
    { text: '请审查代码', expect: '' },
  ]);
  assert.equal(result.coverageRate, 1);
  assert.equal(result.labeled, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.accuracyRate, 0.5);
  assert.equal(hitRate([{ text: '请审查代码', expect: '' }]).accuracyRate, null);
});

test('采样可关闭且不再记录稳定输入摘要', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mind-privacy-'));
  const previous = process.env.DSH_MIND_SAMPLING;
  try {
    process.env.DSH_MIND_SAMPLING = '0';
    await recordSample(home, { text: 'secret', unknown: false, situation: 'execute', hits: [] });
    await assert.rejects(readFile(sampleFilePath(home)), { code: 'ENOENT' });
    process.env.DSH_MIND_SAMPLING = '1';
    await recordSample(home, { text: 'secret', unknown: false, situation: 'execute', hits: [] });
    const sample = JSON.parse((await readFile(sampleFilePath(home), 'utf8')).trim());
    assert.equal('key' in sample, false);
    assert.equal('text' in sample, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_MIND_SAMPLING;
    else process.env.DSH_MIND_SAMPLING = previous;
    await rm(home, { recursive: true, force: true });
  }
});
