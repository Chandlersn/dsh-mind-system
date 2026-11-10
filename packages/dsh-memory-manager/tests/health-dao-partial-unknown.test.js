// Real health checks against isolated roots with persistent read failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

const source = (name) => `[${name}](../insights/${name}.md)`;
const dao = (names) => `# 道\n\n## 命题\n\n变化和边界彼此影响。\n\n## 来源法\n\n${names.map(source).join('\n')}\n`;
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'r24-partial-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills);
  for (const dir of ['functions', 'insights', 'dao', 'capabilities']) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  await writeFile(path.join(root, 'functions', 'area.md'), '# 功能域\n', 'utf8');
  for (let i = 1; i <= 5; i++) await writeFile(path.join(root, 'insights', `free${i}.md`), '> 来源：[functions/area.md](../functions/area.md)\n', 'utf8');
  for (const name of ['badsource', 'one', 'two', 'three']) await writeFile(path.join(root, 'insights', `${name}.md`), '# 来源法\n', 'utf8');
  await writeFile(path.join(root, 'dao', 'a-bad.md'), dao(['free1', 'free2', 'free3', 'free4', 'free5']), 'utf8');
  await writeFile(path.join(root, 'dao', 'b-good.md'), dao(['badsource', 'missing', 'one', 'two', 'three']), 'utf8');
  await writeFile(path.join(root, 'dao', 'z-headless.md'), '# 没有命题的道\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^r24-partial-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills };
}
async function fault(target, op, code, fn) {
  const original = fs.promises[op];
  let hits = 0;
  fs.promises[op] = async function (name, ...args) {
    if (typeof name === 'string' && path.resolve(name) === path.resolve(target)) {
      hits++;
      throw Object.assign(new Error('persistent simulated failure'), { code });
    }
    return original.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: await fn(), hits }; }
  finally { fs.promises[op] = original; syncBuiltinESMExports(); }
}
const check = ({ root, skills }) => runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
const r24 = (r) => r.results.filter((x) => x.rule === 'R24');
const text = (r) => r24(r).map((x) => x.message).join('\n');

for (const code of ['EIO', 'EACCES']) {
  test(`不可读的道 ${code}：保留未知、其他道与来源继续，禁止伪萃取`, async (t) => {
    const f = await fixture(t);
    const bad = path.join(f.root, 'dao', 'a-bad.md');
    const good = path.join(f.root, 'dao', 'b-good.md');
    const before = await Promise.all([readFile(bad, 'utf8'), readFile(good, 'utf8')]);
    const { result, hits } = await fault(bad, 'readFile', code, () => check(f));
    const messages = text(result);
    assert.ok(hits > 0);
    assert.match(messages, new RegExp(`dao/a-bad\\.md[^\\n]*状态未知[^\\n]*${code}`));
    assert.match(messages, /z-headless[^\n]*|[^\n]*z-headless/);
    assert.match(messages, /b-good\.md[^\n]*来源法[^\n]*missing/);
    assert.doesNotMatch(messages, /可考虑萃取上层命题/, 'unknown dao may claim every otherwise unclaimed law');
    assert.ok(result.results.some((x) => x.rule === 'R26'), 'later checks still run');
    assert.deepEqual(await Promise.all([readFile(bad, 'utf8'), readFile(good, 'utf8')]), before);
  });

  test(`不可读的来源法 ${code}：未知不算缺失，其他缺失与无关法仍检查`, async (t) => {
    const f = await fixture(t);
    // Empty readable dao claims none of the free laws, so they form a positive extraction control.
    await writeFile(path.join(f.root, 'dao', 'a-bad.md'), dao(['one', 'two', 'three', 'four', 'five']), 'utf8');
    const target = path.join(f.root, 'insights', 'badsource.md');
    const before = await readFile(target, 'utf8');
    const { result, hits } = await fault(target, 'readFile', code, () => check(f));
    const messages = text(result);
    assert.ok(hits > 0);
    assert.match(messages, new RegExp(`insights/badsource\\.md[^\\n]*状态未知[^\\n]*${code}`));
    const gone = r24(result).find((x) => x.message.includes('b-good.md') && /已不存在或已被取代/.test(x.message));
    assert.ok(gone && gone.message.includes('missing'), 'confirmed missing source must remain visible');
    assert.match(gone.message, /已确认下界，另有 1 条来源状态未知/);
    assert.doesNotMatch(gone.message, /badsource/, 'unknown source is not confirmed missing');
    assert.match(messages, /z-headless/);
    assert.match(messages, /可考虑萃取上层命题/, 'independently readable unclaimed laws remain eligible');
    assert.ok(result.results.some((x) => x.rule === 'R26'));
    assert.equal(await readFile(target, 'utf8'), before);
  });

  test(`道目录 ${code}：整体状态未知`, async (t) => {
    const f = await fixture(t);
    const { result, hits } = await fault(path.join(f.root, 'dao'), 'readdir', code, () => check(f));
    assert.ok(hits > 0);
    assert.match(text(result), new RegExp(`检查不完整[^\\n]*状态未知[^\\n]*${code}`));
    assert.doesNotMatch(text(result), /可考虑萃取上层命题/);
    assert.ok(result.results.some((x) => x.rule === 'R26'));
  });
}

test('未认领法不可读只排除该条，其余可萃取数量注明下界', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'dao', 'a-bad.md'), dao(['one', 'two', 'three', 'four', 'five']), 'utf8');
  await writeFile(path.join(f.root, 'insights', 'free6.md'), '> 来源：[functions/area.md](../functions/area.md)\n', 'utf8');
  const target = path.join(f.root, 'insights', 'free1.md');
  const { result } = await fault(target, 'readFile', 'EIO', () => check(f));
  const messages = text(result);
  assert.match(messages, /insights\/free1\.md[^\n]*状态未知[^\n]*EIO/);
  const extraction = r24(result).find((x) => /可考虑萃取上层命题/.test(x.message));
  assert.ok(extraction, 'the other five readable laws form a valid candidate');
  assert.match(extraction.message, /area（5 条未认领，已确认下界）/);
});

test('道文件未知时数量上限只对已确认的道报下界', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 7; i++) await writeFile(path.join(f.root, 'dao', `extra${i}.md`), '# 其他道\n', 'utf8');
  const { result } = await fault(path.join(f.root, 'dao', 'a-bad.md'), 'readFile', 'EIO', () => check(f));
  assert.match(text(result), /dao\/ 已 9 条（已确认下界；另有 1 条道状态未知） > 上限/);
  assert.doesNotMatch(text(result), /可考虑萃取上层命题/);
});

test('无故障正控：已认领不重复萃取，真实缺失仍报', async (t) => {
  const f = await fixture(t);
  const messages = text(await check(f));
  assert.match(messages, /b-good\.md[^\n]*来源法[^\n]*missing/);
  assert.doesNotMatch(messages, /可考虑萃取上层命题/);
  assert.doesNotMatch(messages, /状态未知/);
});
