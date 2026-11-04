/**
 * 约束层测试（2026-11-03：mind × superagent 真结合的第一块）。
 *
 * 真结合的验证不造新数据：直接吃试验台的 samples.json + gate.mjs ——
 * 把 superagent 的确定性准入层包装成一条 mind 约束，跑通
 * "状态进来 → 约束判 → 合成裁决 → 记账"整条回路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { registerConstraint, listConstraints, evaluate, createLedger, VERDICTS } from '../src/constraints.js';

const here = dirname(fileURLToPath(import.meta.url));
// 试验台在 workspace 的 _recon 下（与 monorepo 分离；缺文件时本组测试显式 skip，不静默绿）。
// 两台机器间没有稳定相对路径可推，因此：默认指本机已知位置，跨机器用 DSH_SUPERAGENT_BENCH 覆盖。
const benchDir = process.env.DSH_SUPERAGENT_BENCH ?? 'D:\\个人开发\\学习模式\\_recon\\mind-x-superagent';
const samplesPath = join(benchDir, 'samples.json');
const gatePath = join(benchDir, 'gate.mjs');

const SETTINGS = { allowed: ['alice', 'bob', 'carol'], bots: [], mode: 'observe', listened: true, admission: {} };

test('约束层的三格：没登记 → unavailable/no-constraint，不是 allow', () => {
  // 这是授权侧的"没人检查 ≠ 检查过没问题"。若这里返回 allow，
  // "机制为空"与"全部放行"就同形了 —— 本层存在的理由就是不许它同形。
  const r = evaluate({ origin: { sender: 'alice' } });
  assert.equal(r.verdict, VERDICTS.unavailable, '空注册表必须判不了，而不是放行');
  assert.equal(r.reason, 'no-constraint');
});

test('上下文不可用 → unavailable/bad-context，也不许是 allow', () => {
  const off = registerConstraint({ name: 'always-allow', owner: 'test', applies: () => 'allow' });
  try {
    assert.equal(evaluate(null).reason, 'bad-context');
    assert.equal(evaluate({}).reason, 'bad-context', '缺 origin 的上下文不能当成"没人说不行就是行"');
  } finally { off(); }
});

test('applies 抛错 → unavailable（吞成 allow 或 deny 都是说谎）', () => {
  const off = registerConstraint({
    name: 'explodes', owner: 'test',
    applies: () => { throw new Error('Mandate 服务没起来'); },
  });
  try {
    const r = evaluate({ origin: { sender: 'alice' } });
    assert.equal(r.verdict, VERDICTS.unavailable);
    assert.match(r.reason, /unavailable:explodes/);
    assert.equal(r.by[0].verdict, 'unavailable', '逐条裁决要能看出是谁判不了');
  } finally { off(); }
});

test('合成规则：一票否决 —— 任一 deny 即 deny，其余 allow 不翻案', () => {
  const offA = registerConstraint({ name: 'ok-sender', owner: 'test', applies: () => 'allow' });
  const offB = registerConstraint({ name: 'not-listed', owner: 'test', applies: () => 'deny' });
  try {
    const r = evaluate({ origin: { sender: 'stranger' } });
    assert.equal(r.verdict, VERDICTS.deny);
    assert.equal(r.reason, 'denied-by:not-listed', '要说清被谁拒的');
    assert.equal(r.by.length, 2, '逐条裁决都留着（哪条 allow 哪条 deny 可解释）');
  } finally { offA(); offB(); }
});

test('合成与顺序无关 —— 反方向注册也必须 deny（2026-11-03 变异测试逼出来的）', () => {
  // 变异实录：合成写成"后到覆盖"时，本文件上一条测试（allow 先、deny 后）
  // 靠遍历顺序侥幸通过，反向注册就会 allow 翻案。断言必须两侧都钉。
  const offA = registerConstraint({ name: 'deny-first', owner: 'test', applies: () => 'deny' });
  const offB = registerConstraint({ name: 'allow-after', owner: 'test', applies: () => 'allow' });
  try {
    const r = evaluate({ origin: { sender: 'x' } });
    assert.equal(r.verdict, VERDICTS.deny, 'deny 是吸收态：后面的 allow 不许翻案');
    assert.equal(r.reason, 'denied-by:deny-first', 'reason 归属第一条 deny，不随后来者改写');
  } finally { offA(); offB(); }
});

test('一条判不了 + 一条侥幸 allow → unavailable（没判过的环节不许被掩盖）', () => {
  const offA = registerConstraint({ name: 'works', owner: 'test', applies: () => 'allow' });
  const offB = registerConstraint({
    name: 'mandate-service-down', owner: 'test',
    applies: () => { throw new Error('Mandate 服务没起来'); },
  });
  try {
    const r = evaluate({ origin: { sender: 'alice' } });
    assert.equal(r.verdict, VERDICTS.unavailable, '有一环判不了 ≠ 全部通过');
    assert.match(r.reason, /unavailable:mandate-service-down/);
  } finally { offA(); offB(); }
});

test('真结合回路：superagent 的 gate.mjs 包装成 mind 约束，吃试验台真实样本', async (t) => {
  // 缺试验台文件时**显式 skip 并说明** —— 不许 return 静默通过：
  // 静默 skip 会让"结合没验证"读成"结合验证过了"。
  let samples;
  try {
    samples = JSON.parse(readFileSync(samplesPath, 'utf8')).samples;
    await import(pathToFileURL(gatePath).href);
  } catch {
    t.skip(`试验台缺失（${samplesPath} 或 ${gatePath}）—— 本组断言未执行，设 DSH_SUPERAGENT_BENCH 指到 _recon/mind-x-superagent 后重跑`);
    return;
  }
  const { gate } = await import(pathToFileURL(gatePath).href);

  const off = registerConstraint({
    name: 'superagent-policy-gate', owner: 'dsh-superagent',
    applies: (context) => {
      const g = gate(context.origin.sample, SETTINGS);
      return g.admissible ? VERDICTS.allow : VERDICTS.deny;
    },
  });
  const ledger = [];
  const book = createLedger((r) => ledger.push(r));
  try {
    // 准入层拒绝的三条（s09 CI 无 sender、s10 未列名 bot、s11 陌生人点名默认不理）
    for (const id of ['s09', 's10', 's11']) {
      const sample = samples.find((s) => s.id === id);
      const r = evaluate({ origin: { sender: sample.sender || null, scope: 'github', sample } });
      assert.equal(r.verdict, VERDICTS.deny, `${id} 必须被 superagent 约束拦下`);
      assert.equal(r.reason, 'denied-by:superagent-policy-gate');
      book.record({ origin: { sender: sample.sender || null, sample: id } }, r, 'not-dispatched');
    }
    // 名单内 + 点名（s12）：explicit → allow
    const s12 = samples.find((s) => s.id === 's12');
    assert.equal(evaluate({ origin: { sender: 'alice', scope: 'github', sample: s12 } }).verdict, VERDICTS.allow);

    // 记账三级：outcome 由调用方事后回填，"照做没有"不许由约束自己冒充
    assert.equal(ledger.length, 3);
    assert.ok(ledger.every((l) => l.verdict === 'deny' && l.outcome === 'not-dispatched'));
    assert.ok(ledger.every((l) => l.at && l.origin), '每条账要带时间与发起者');

    // 约束清单里 owner 可见 —— 别的单元能查到"授权是谁在管"
    const listed = listConstraints().find((c) => c.name === 'superagent-policy-gate');
    assert.equal(listed.owner, 'dsh-superagent', '贡献者身份必须可查（与信号的 owner 同语义）');
    assert.ok(!('applies' in listed), '清单不许泄判定函数本体');
  } finally { off(); }
});

test('重名覆盖 + 注销语义（2026-11-03 实测钉死，与 registerSignal 一致）', () => {
  const off1 = registerConstraint({ name: 'dup', owner: 'a', applies: () => 'deny' });
  const off2 = registerConstraint({ name: 'dup', owner: 'b', applies: () => 'allow' });
  try {
    assert.equal(evaluate({ origin: 1 }).verdict, VERDICTS.allow, '重名以最后一次为准');
    off2();
    // 实测语义（node 直跑核对过）：覆盖是**替换**，不是叠加；
    // 注销覆盖者后表**变空** —— 原始登记者的 entry 已被替换、不复活。
    // 这条钉的是"不许出现半删状态/幽灵约束"：off1 之后再注销就是无害 no-op。
    assert.equal(listConstraints().filter((c) => c.name === 'dup').length, 0, '覆盖者注销后不留幽灵条目');
    off1(); // no-op，不许报错也不许复活
    assert.equal(listConstraints().filter((c) => c.name === 'dup').length, 0);
  } finally {
    const still = listConstraints().filter((c) => c.name === 'dup');
    if (still.length) registerConstraint({ name: 'dup', owner: 'cleanup', applies: () => 'allow' })();
  }
});

test('无名/无 applies 的登记当场拒绝（不许登记一条"永远不会生效"的约束）', () => {
  assert.throws(() => registerConstraint({ owner: 'test', applies: () => 'allow' }), /名字/);
  assert.throws(() => registerConstraint({ name: 'x', owner: 'test' }), /applies/);
});
