import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { resolveDshRoot } from '../src/host.js';

// Use the installed host's compiler (via apply) and runtime output validator.
// Missing host dependencies fail this suite instead of silently skipping it.
const hostRoot = resolveDshRoot();
const hostEntry = path.join(hostRoot, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js');
const { validateJsonSchemaValue, assertSupportedJsonSchema } = createRequire(import.meta.url)(hostEntry);
const listArgs = { status: 'list_candidates', name: '', proposition: '', body: '', extractedFrom: [] };
const proposition = '秩序与混乱在信息密度足够高时会互相转化，各自长出不同的结构。';
const body = '## 三种形态\n\n自证：回路用自身产出证明自身。\n外物：信息来自伪造不了的对手。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来才成为一条道。\n\n## 边界\n\n适用于产出者参与反馈的场景；当产出者不在回路之内且观察完全独立时，此判据不成立。';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dao-list-contract-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await fs.mkdir(root);
  await fs.mkdir(skills);
  await fs.writeFile(path.join(root, 'MEMORY.md'), '# Index\n');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const tools = new Map();
  const admissions = [];
  const noop = () => {};
  const valves = { negativeRules: async () => [], upward: () => undefined,
    downward: (...args) => { admissions.push(args); return { admitted: true }; } };
  const ctx = { tools: { register: (tool) => { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop,
    get: (name) => name === 'valves' ? valves : undefined, set() {},
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }) };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: hostRoot });
  t.after(async () => {
    dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^dao-list-contract-/);
    await fs.rm(home, { recursive: true, force: true });
  });
  const tool = tools.get('memory_dao');
  assertSupportedJsonSchema(tool.output.schema);
  assert.equal(tool.output.schema.oneOf.length, 3);
  function validate(value) {
    return validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value');
  }
  async function execute(args = listArgs) {
    const value = await tool.execute(args);
    assert.deepEqual(validate(value), [], 'Actual host validator must accept the result.');
    const rendered = tool.output.render(args, value);
    assert.equal(rendered[0].type, 'text');
    assert.doesNotMatch(rendered[0].text, /undefined|NaN/);
    return { value, text: rendered[0].text };
  }
  return { root, candDir: path.join(root, 'dao/_candidates'), tool, admissions, validate, execute };
}

// Fault injection targets the real filesystem import, without changing production APIs.
async function withFsError(method, target, code, action) {
  const original = fs[method];
  fs[method] = async (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(target)) throw Object.assign(new Error(`Injected ${code}`), { code });
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs[method] = original; syncBuiltinESMExports(); }
}

for (const existing of [false, true]) {
  test(`list validates and renders an ${existing ? 'existing empty' : 'absent'} directory without write admission`, async (t) => {
    const f = await fixture(t);
    if (existing) await fs.mkdir(f.candDir, { recursive: true });
    const { value, text } = await f.execute();
    assert.deepEqual(value.candidates, []);
    assert.equal(value.count, 0);
    assert.match(text, /当前没有待确认/);
    assert.equal(f.admissions.length, 0);
    for (const key of ['daoFile', 'extractedFrom', 'missingLaws']) assert.equal(Object.hasOwn(value, key), false);
  });
}

test('nonempty listing reads real records, sorts names, ignores other extensions, and renders evidence', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.candDir, { recursive: true });
  await fs.writeFile(path.join(f.candDir, 'z.md'), `# Candidate\n\n## 命题\n\n${proposition}\n\n## 来源法\n\n- [law-a](../insights/law-a.md)\n- [law-b](../insights/law-b.md)\n`);
  await fs.writeFile(path.join(f.candDir, 'a.md'), '# Candidate\n\n## 命题\n\n另一个命题\n');
  await fs.writeFile(path.join(f.candDir, 'ignored.txt'), 'ignored');
  const { value, text } = await f.execute();
  assert.equal(value.count, 2);
  assert.deepEqual(value.candidates.map((v) => v.name), ['a', 'z']);
  assert.deepEqual(value.candidates[1], { name: 'z', proposition, source_count: 2 });
  assert.match(text, /尚未生效/);
  assert.ok(text.includes(proposition));
  assert.match(text, /来源法：2 条/);
  assert.equal(f.admissions.length, 0);
});

test('a file in place of the candidate directory fails instead of reporting empty', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.candDir), { recursive: true });
  await fs.writeFile(f.candDir, 'not a directory');
  await assert.rejects(f.execute(), (error) => error.code === 'ENOTDIR');
});

for (const code of ['EACCES', 'EIO']) {
  test(`candidate directory ${code} propagates instead of reporting empty`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(f.candDir, { recursive: true });
    await withFsError('readdir', f.candDir, code, () => assert.rejects(f.execute(), (error) => error.code === code));
    assert.equal(f.admissions.length, 0);
  });
}

for (const code of ['EACCES', 'ENOENT']) {
  test(`individual record ${code} is explicit while readable records remain available`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(f.candDir, { recursive: true });
    const blocked = path.join(f.candDir, 'blocked.md');
    await fs.writeFile(blocked, 'unavailable');
    await fs.writeFile(path.join(f.candDir, 'good.md'), '## 命题\n\n可读命题\n');
    await withFsError('readFile', blocked, code, async () => {
      const { value, text } = await f.execute();
      assert.equal(value.count, 2);
      assert.deepEqual(value.candidates[0], { name: 'blocked', unreadable: true, error: code });
      assert.equal(value.candidates[1].proposition, '可读命题');
      assert.match(text, /blocked：无法读取/);
      assert.ok(text.includes(code));
      assert.match(text, /命题与来源法数量未知/);
    });
  });
}

async function seedLaws(root) {
  const sources = ['law-a', 'law-b', 'law-c', 'law-d', 'law-e'];
  await fs.mkdir(path.join(root, 'insights'), { recursive: true });
  for (const name of sources) await fs.writeFile(path.join(root, 'insights', `${name}.md`), `# ${name}\n`);
  return sources;
}

for (const status of ['candidate', 'active']) {
  test(`${status} write validates and renders; required evidence and admission remain enforced`, async (t) => {
    const f = await fixture(t);
    const sources = await seedLaws(f.root);
    const args = { status, name: 'fixture', proposition, body, extractedFrom: sources };
    const { value, text } = await f.execute(args);
    assert.equal(f.admissions.length, 1);
    const required = status === 'active'
      ? ['daoFile', 'name', 'extractedFrom', 'missingLaws', 'warnings']
      : ['ok', 'status', 'name', 'path', 'proposition', 'source_count', 'sources', 'note'];
    for (const key of required) {
      const incomplete = { ...value };
      delete incomplete[key];
      assert.ok(f.validate(incomplete).length > 0, `${status} must still require ${key}`);
    }
    assert.ok(f.validate({ ...value, unexpected: true }).length > 0);
    if (status === 'candidate') {
      assert.match(text, /未生效/);
      assert.ok(text.includes(proposition));
      const listed = await f.execute();
      assert.equal(listed.value.candidates[0].source_count, 5);
      assert.equal(listed.value.candidates[0].proposition, proposition);
      assert.equal(f.admissions.length, 1, 'Listing after a write adds no admission.');
      // Exercise the optional warning field in the original candidate result contract.
      const warned = await f.execute({ ...args, extractedFrom: [...sources, sources[0]] });
      assert.ok(warned.value.warnings.length > 0);
      assert.match(warned.text, /重复项/);
    } else {
      assert.match(text, /道已沉淀/);
      assert.equal(value.selfCheck.ok, true, JSON.stringify(value.selfCheck));
    }
    await assert.rejects(f.tool.execute({ ...args, name: 'rejected', extractedFrom: sources.slice(0, 4) }), /来源不足/);
    await assert.rejects(f.tool.execute({ ...args, name: 'rejected', extractedFrom: [...sources.slice(0, 4), 'missing'] }), /来源不足/);
    await assert.rejects(f.tool.execute({ ...args, name: 'rejected', body: '' }), /body is required/);
    await assert.rejects(fs.stat(path.join(f.root, status === 'candidate' ? 'dao/_candidates/rejected.md' : 'dao/rejected.md')), { code: 'ENOENT' });
  });
}
