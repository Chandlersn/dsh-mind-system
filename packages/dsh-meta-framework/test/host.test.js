/**
 * `src/host.js` 的**真实**测试。
 *
 * ## 为什么这个文件此前不存在
 *
 * `src/host.js` 此前**零函数覆盖**（`node --test --experimental-test-coverage`
 * 显示 funcs 0.00%）—— 而这个模块干的事正是"定位 DSH 安装目录"，
 * 判错的后果是插件加载失败（宿主只报 "1 entry did not activate"）。
 *
 * 上一版的 `test/entry.test.js` 里那条"定位不到宿主根"的用例是
 * **伪造**的：`loadDefineTool: () => { throw new Error('无法定位 DSH 安装目录…') }`
 * —— 它自己造了个错误消息，并没有让 `resolveDshRoot()` 真的产出那个错误。
 * 所以"定位逻辑对不对"从来没被验证过。
 *
 * ## 这里怎么测
 *
 * 造**假安装根**：一个临时目录，里面放
 * `node_modules/@deepseek-ai/cordis/package.json`（以及 dsh-tools 的包）。
 * 判定依据就是那个 marker 文件 —— 这正是真实判据。
 *
 * 每个用例之间调 `clearRootCache()`：缓存是模块级的，不清就会
 * "改了环境变量却不生效"（这正是 REVIEW.md 记的那个坑）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MARKER,
  probe,
  ascend,
  candidateRoots,
  clearRootCache,
  resolveDshRoot,
  loadHost,
} from '../src/host.js';

/**
 * 造一个假的 DSH 安装根。
 *
 * @param opts.withCordis — 是否放 cordis 的 marker（决定它算不算安装根）。
 * @param opts.withTools — 是否放 `@deepseek-ai/dsh-tools`。
 * @returns 根目录绝对路径。
 */
function makeFakeRoot({ withCordis = true, withTools = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fake-root-'));
  if (withCordis) {
    const cordisDir = join(root, 'node_modules', '@deepseek-ai', 'cordis');
    mkdirSync(cordisDir, { recursive: true });
    writeFileSync(
      join(cordisDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/cordis', version: '0.0.0-test', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(
      join(cordisDir, 'index.js'),
      'module.exports = { Service: class {}, Context: class {}, symbols: {}, Fiber: class {}, RegistryService: class {}, Inject: class {} };',
      'utf8',
    );
  }
  if (withTools) {
    const toolsDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools');
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(
      join(toolsDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-test', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(
      join(toolsDir, 'index.js'),
      'module.exports = { defineTool: (definition) => definition, marker: "from-fake-root" };',
      'utf8',
    );
  }
  return root;
}

/**
 * 在一个用例里保存并恢复环境变量与 cwd。
 *
 * 这些都是**全局**状态：用例之间必须还原，否则互相污染。
 *
 * @param body — 用例体。
 */
async function withEnv(body) {
  const saved = {
    DSH_INSTALL_DIR: process.env.DSH_INSTALL_DIR,
    DSH_ROOT: process.env.DSH_ROOT,
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    cwd: process.cwd(),
  };
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'cwd') continue;
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.chdir(saved.cwd);
    clearRootCache();
  }
}

test('probe 认的是真实 marker（cordis/package.json 存在才算安装根）', () => {
  const withCordis = makeFakeRoot({ withCordis: true });
  const withoutCordis = makeFakeRoot({ withCordis: false });

  try {
    assert.equal(probe(withCordis), withCordis, '有 marker 的目录必须被认出来');
    assert.equal(probe(withoutCordis), undefined, '没有 marker 的目录必须被拒绝');
    assert.equal(probe(''), undefined, '空串必须被拒绝');
    assert.equal(probe(undefined), undefined, 'undefined 必须被拒绝');
    assert.equal(probe(null), undefined, 'null 必须被拒绝');
    assert.equal(probe(123), undefined, '非字符串必须被拒绝');
  } finally {
    rmSync(withCordis, { recursive: true, force: true });
    rmSync(withoutCordis, { recursive: true, force: true });
  }
});

test('probe 判到 package.json 而不是只判目录（半装坏的空目录不算安装根）', () => {
  const root = makeFakeRoot({ withCordis: false });
  // 只造出 cordis 的**目录**，不放 package.json —— 这是"半装坏"的形态
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true });

  try {
    assert.equal(
      probe(root),
      undefined,
      '只有目录没有 package.json 时不算安装根（否则 loadHost 才在很远的地方失败）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ascend 从子目录向上找到安装根', () => {
  const root = makeFakeRoot();
  const deep = join(root, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });

  try {
    assert.equal(ascend(deep), root, '必须能从深层子目录向上找到根');
    assert.equal(ascend(join(root, 'node_modules')), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DSH_INSTALL_DIR 优先于其它候选', async () => {
  await withEnv(async () => {
    const installDir = makeFakeRoot();
    const otherDir = makeFakeRoot();
    try {
      process.env.DSH_INSTALL_DIR = installDir;
      process.env.DSH_ROOT = otherDir;
      clearRootCache();

      assert.equal(
        resolveDshRoot(),
        installDir,
        'DSH_INSTALL_DIR 必须优先于 DSH_ROOT',
      );
    } finally {
      rmSync(installDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

test('DSH_ROOT 在 DSH_INSTALL_DIR 不存在时接管', async () => {
  await withEnv(async () => {
    const rootDir = makeFakeRoot();
    try {
      process.env.DSH_INSTALL_DIR = join(rootDir, 'does-not-exist');
      process.env.DSH_ROOT = rootDir;
      clearRootCache();

      assert.equal(resolveDshRoot(), rootDir, 'DSH_INSTALL_DIR 失效时应由 DSH_ROOT 接管');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

test('DSH_HOME 必须被**拒绝**（它是数据目录，不是安装目录）', async () => {
  await withEnv(async () => {
    // 造一个"长得像安装根"的 DSH_HOME：里面有 cordis 的 marker
    const homeRoot = makeFakeRoot();
    try {
      process.env.DSH_INSTALL_DIR = undefined;
      process.env.DSH_ROOT = undefined;
      process.env.DSH_HOME = homeRoot;
      process.env.DSH_PROFILE_DIR = undefined;
      // cwd 也要排除，否则 ascend(cwd) 可能命中别处
      const isolated = makeFakeRoot({ withCordis: false });
      process.chdir(isolated);

      clearRootCache();

      // 候选列表里**不该有** DSH_HOME
      assert.ok(
        !candidateRoots().includes(homeRoot),
        'DSH_HOME 绝不能出现在候选里 —— 它是数据目录（~/.dsh），不是安装目录',
      );

      // 且实际解析**不能**命中它
      let resolved;
      try {
        resolved = resolveDshRoot();
      } catch {
        resolved = undefined;
      }
      assert.notEqual(
        resolved,
        homeRoot,
        'DSH_HOME 绝不能被当成安装根（实测本机 DSH_HOME=C:\\Users\\lyq\\.dsh，真实安装在 D:\\dsh）',
      );
    } finally {
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });
});

test('候选列表的优先级顺序（可测，而不是靠"碰巧对"）', async () => {
  await withEnv(async () => {
    const a = makeFakeRoot();
    const b = makeFakeRoot();
    try {
      process.env.DSH_INSTALL_DIR = a;
      process.env.DSH_ROOT = b;
      clearRootCache();

      const candidates = candidateRoots();
      assert.equal(candidates[0], a, 'DSH_INSTALL_DIR 排第一');
      assert.equal(candidates[1], b, 'DSH_ROOT 排第二');
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

test('clearRootCache 真的清了缓存（改了环境变量能生效）', async () => {
  await withEnv(async () => {
    const first = makeFakeRoot();
    const second = makeFakeRoot();
    try {
      process.env.DSH_INSTALL_DIR = first;
      clearRootCache();
      assert.equal(resolveDshRoot(), first);

      // 换了环境变量但**不清缓存** → 仍然是旧根（这正是缓存污染的形态）
      process.env.DSH_INSTALL_DIR = second;
      assert.equal(resolveDshRoot(), first, '不清缓存时就是旧的（这一步证明缓存确实存在）');

      // 清了缓存 → 新根生效
      clearRootCache();
      assert.equal(
        resolveDshRoot(),
        second,
        'clearRootCache 之后必须用新根 —— 上一版只清了根缓存、没清 require 缓存',
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

test('clearRootCache 也要清 require 缓存（否则 loadHost 仍从旧根加载）', async () => {
  await withEnv(async () => {
    // 两个假根导出**不同的**标记 —— 这样才能分辨 loadHost 用的是哪个根
    const first = makeFakeRoot({ withTools: true });
    const second = makeFakeRoot({ withTools: true });
    const secondTools = join(second, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js');
    writeFileSync(
      secondTools,
      'module.exports = { defineTool: (definition) => definition, marker: "from-second-root" };',
      'utf8',
    );
    try {
      process.env.DSH_INSTALL_DIR = first;
      clearRootCache();
      assert.equal(
        loadHost('@deepseek-ai/dsh-tools').marker,
        'from-fake-root',
        '先从第一个根加载',
      );

      // 换根并清缓存 —— require 缓存也必须跟着换
      process.env.DSH_INSTALL_DIR = second;
      clearRootCache();
      assert.equal(
        loadHost('@deepseek-ai/dsh-tools').marker,
        'from-second-root',
        '换根后必须从新根加载 —— 上一版只清了根缓存、没清 require 缓存，这里会拿到旧根的模块',
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

test('loadHost 从**指定根**加载宿主包（而不是从插件自己的 node_modules）', async () => {
  await withEnv(async () => {
    const root = makeFakeRoot({ withTools: true });
    try {
      process.env.DSH_INSTALL_DIR = root;
      clearRootCache();

      const mod = loadHost('@deepseek-ai/dsh-tools');
      assert.ok(mod, '必须能加载到');
      assert.equal(typeof mod.defineTool, 'function', '必须拿到 defineTool');
      assert.equal(mod.marker, 'from-fake-root', '必须来自假根，而不是别处');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('loadHost 在根里没有该包时抛错（不静默返回 undefined）', async () => {
  await withEnv(async () => {
    const root = makeFakeRoot({ withTools: false });
    try {
      process.env.DSH_INSTALL_DIR = root;
      clearRootCache();

      assert.throws(
        () => loadHost('@deepseek-ai/dsh-tools'),
        /Cannot find module|Cannot find package/,
        '宿主包里没有这个包时必须抛错 —— 静默 undefined 会让上层更难查',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('MARKER 常量指向真实判据文件（改了它探测就全错）', () => {
  assert.ok(MARKER.includes('node_modules'), `MARKER 应含 node_modules，实际 ${MARKER}`);
  assert.ok(MARKER.includes('@deepseek-ai'), `MARKER 应含 @deepseek-ai，实际 ${MARKER}`);
  assert.ok(MARKER.includes('cordis'), `MARKER 应含 cordis，实际 ${MARKER}`);
  assert.ok(MARKER.endsWith('package.json'), `MARKER 应判到 package.json，实际 ${MARKER}`);
});
