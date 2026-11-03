/**
 * 工具面编排测试。
 *
 * ## 这个文件要守住什么
 *
 * 编排是本插件唯一**会改动主干道数据**的部分（它替换 `assembly.tools`）。
 * 所以这里最该钉住的不是"排序好不好"，而是三条安全性质：
 *
 * 1. **不减少能力**：任何处境下工具数量与名字都不变 —— 只换顺序
 *    （缺了声明，模型连工具名都看不到，那是能力损失）
 * 2. **核心工具不动**：文件/shell/协作类工具在任何处境都在前排，
 *    且永不被 deferLoading
 * 3. **判不出来就不动**：处境 unknown 时原样返回，绝不凭猜重排
 *
 * 排序"效果"本身是软的（模型注意力），不该用断言假装它可测；
 * 能测的是"重排真的发生了、且没有破坏任何东西"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrangeTools, classifySituation, isCoreTool, SITUATIONS } from '../src/orchestrate.js';

/** 造一批具名工具 schema（只关心 name）。 */
function tools(names) {
  return names.map((name) => ({ name, description: `desc:${name}`, parameters: {} }));
}

const SAMPLE = tools([
  'pwsh',
  'read',
  'write',
  'clis_run',
  'clis_classify',
  'meta_reframe',
  'memory_read',
  'memory_write',
  'web_search',
  'sys_scan',
  'mastery_status',
]);

test('core 工具识别：精确名与下划线族都对，且不误伤同前缀', () => {
  assert.ok(isCoreTool('pwsh'));
  assert.ok(isCoreTool('read'));
  assert.ok(isCoreTool('team_task_create'), 'team_task_ 是前缀族');
  // read_image 属于 read 的"同前缀不同工具"，不该被当成核心
  assert.ok(!isCoreTool('read_image'), '裸 startsWith 会误伤；必须要求精确相等');
  assert.ok(!isCoreTool('clis_run'));
  assert.ok(!isCoreTool(''));
});

test('重排不改变工具数量与名字集合（能力零损失）', () => {
  for (const sit of Object.values(SITUATIONS)) {
    const out = arrangeTools(SAMPLE, sit);
    assert.equal(out.length, SAMPLE.length, `${sit}: 数量变了就是能力损失`);
    assert.deepEqual(
      out.map((t) => t.name).sort(),
      SAMPLE.map((t) => t.name).sort(),
      `${sit}: 名字集合必须一致`,
    );
  }
});

test('diagnose 处境把判结构的工具排到最前', () => {
  const out = arrangeTools(SAMPLE, SITUATIONS.diagnose);
  const first = out[0].name;
  assert.ok(
    first.startsWith('clis_') || first.startsWith('meta_'),
    `诊断处境首个应是判结构工具，实际 ${first}`,
  );
});

test('retrieve 处境把检索工具排到最前', () => {
  const out = arrangeTools(SAMPLE, SITUATIONS.retrieve);
  assert.equal(out[0].name, 'web_search');
});

test('recall 处境把记忆工具排到最前', () => {
  const out = arrangeTools(SAMPLE, SITUATIONS.recall);
  assert.ok(out[0].name.startsWith('memory_'), `实际 ${out[0].name}`);
});

test('unknown 处境原样返回（判不出来就不动）', () => {
  const out = arrangeTools(SAMPLE, SITUATIONS.unknown);
  assert.deepEqual(out, SAMPLE, '未知处境绝不该凭猜重排');
});

test('空列表与非法输入不抛错', () => {
  assert.deepEqual(arrangeTools([], SITUATIONS.diagnose), []);
  assert.equal(arrangeTools(undefined, SITUATIONS.diagnose), undefined);
  assert.equal(arrangeTools(null, SITUATIONS.diagnose), null);
});

test('缺省不打 deferLoading（有风险的那半必须显式开启）', () => {
  const out = arrangeTools(SAMPLE, SITUATIONS.diagnose);
  assert.ok(
    out.every((t) => t.deferLoading === undefined),
    '缺省不该改变任何工具的载入语义',
  );
});

test('park 打开时：异族打 deferLoading，核心与相关族永不打', () => {
  const out = arrangeTools(SAMPLE, SITUATIONS.diagnose, { park: true });
  const byName = Object.fromEntries(out.map((t) => [t.name, t]));

  assert.equal(byName.sys_scan.deferLoading, true, '异族该被延后载入');
  assert.equal(byName.pwsh.deferLoading, undefined, '核心工具藏了可能把人卡住');
  assert.equal(byName.clis_run.deferLoading, undefined, '相关族不该被延后');
  // 延后 ≠ 删除：schema 仍然在列表里
  assert.equal(out.length, SAMPLE.length, 'park 不该删除任何工具');
});

test('park 打开时也不销毁原对象语义（不就地改入参）', () => {
  const input = tools(['pwsh', 'sys_scan']);
  const out = arrangeTools(input, SITUATIONS.diagnose, { park: true });
  assert.equal(input[1].deferLoading, undefined, '不能就地改调用方数据');
  assert.notEqual(out, input, '应返回新列表');
});

// —— 处境判定：症状词驱动，只读最后一条 user 消息 ——

/** 造一条 user 消息（宿主 content 是 block 数组）。 */
function userMsg(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

test('反复无效类描述判为 diagnose', () => {
  assert.equal(classifySituation([userMsg('改了参数还是没效果，越调越糟')]), SITUATIONS.diagnose);
  assert.equal(classifySituation([userMsg('指标来回震荡，压下去又弹回来')]), SITUATIONS.diagnose);
});

test('外部事实类描述判为 retrieve', () => {
  assert.equal(classifySituation([userMsg('帮我搜一下最新的版本')]), SITUATIONS.retrieve);
});

test('既有约定类描述判为 recall', () => {
  assert.equal(classifySituation([userMsg('上次我们约定过的那个做法是什么')]), SITUATIONS.recall);
});

test('明确的动手类描述判为 execute', () => {
  assert.equal(classifySituation([userMsg('帮我改一下这个文件的配置')]), SITUATIONS.execute);
});

test('看不出症状时判为 unknown（宁可不动）', () => {
  assert.equal(classifySituation([userMsg('嗯')]), SITUATIONS.unknown);
  assert.equal(classifySituation([]), SITUATIONS.unknown);
  assert.equal(classifySituation(undefined), SITUATIONS.unknown);
});

test('只读最后一条 user 消息（老问题不该决定当下看得到什么）', () => {
  // 历史上出现过"越调越糟"，但最新一条是明确的执行指令 → 应判 execute
  const messages = [userMsg('改了参数还是没效果，越调越糟'), userMsg('好，帮我改一下这个文件')];
  assert.equal(classifySituation(messages), SITUATIONS.execute);
});

test('非文本块与畸形消息不抛错', () => {
  assert.equal(classifySituation([{ role: 'user', content: [{ type: 'image' }] }]), SITUATIONS.unknown);
  assert.equal(classifySituation([{ role: 'assistant', content: [] }]), SITUATIONS.unknown);
  assert.equal(classifySituation([{ role: 'user', content: 'plain string' }]), SITUATIONS.unknown);
});