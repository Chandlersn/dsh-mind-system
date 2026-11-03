# 方案：把「硬链接式合成」换成可复现的构建

> 状态：**已实施**（2026-11-03）。实施中有 3 处偏离原设计，见 §9；正文保留原样以便对照。
> 关联：`scripts/sync-client-id.mjs` **已退役**——它与构建对同一个文件反向生成，冲突。

## 0. 结论先行

**做，但只做一半。** 把「合成包 = 手工复制的第二份」改成「合成包 = 由四个独立包生成的产物」，
用 manifest + `build` + `--check` 三件套替代人工同步。

**不改的**：合成包里 9 个根级文件（装配清单、根 patch、包描述、README 等）继续手写——
它们本身就是创作物，不是任何成员包的派生品。

选「生成后**提交**产物」（方案 A），不选「生成后 gitignore」（方案 B），理由见 §3。

---

## 1. 事实基线（已实测，含对上轮结论的更正）

### 1.1 更正：不是硬链接到独立包

上轮说「89/93 文件与四个独立包同 inode」——**错**。实测（`dsh-clis/index.js` 对 `dsh-mind-system/clis/index.js`）：

| 路径 | inode | links |
|---|---|---|
| `packages/dsh-clis/index.js` | 1688849860351248 | 1 |
| `packages/dsh-mind-system/clis/index.js` | 14636698789187044 | **2** |
| `~/.dsh/profiles/web/.../dsh-mind-system/clis/index.js` | 14636698789187044 | **2** |

合成包与独立包**不共享 inode**——是**手工复制**。合成包的 `links=2` 是链到 profile 安装副本。
`89 / 93` 这个数字真实含义是「**89 个产物文件硬链到运行安装副本**」，不是链到独立包。
剩下 4 个没链的，正是上一轮我改过的那 4 个文件（写入时断链了）。

真实关系是两条，都必须处理：

1. **四个独立包 → 合成包**：**手工复制**（不是链接）。这才是漂移来源。
2. **合成包 → profile 安装副本**：**硬链接（89/93）**。这条更危险，见 §6.1。

### 1.2 复制是准确的，只有机械改名

`diff -rq` 四组，差异只有两类：

| 差异 | 数量 | 性质 |
|---|---|---|
| 成员包自身的 `cordis.patch.yml`×4 / `.gitignore`×3 / `package-lock.json` / `REVIEW.md` / `reload-core.mjs` | 10 个文件 + 1 个空目录 `data/` | 有意排除（见 1.4） |
| 内容不同的文件 | **7** | **全是机械改名**，无逻辑漂移 |

7 个不同文件逐一看过。**真正需要构建去改的只有 3 个文件**，其余已被现有脚本接管：

| 文件 | 差异 | 谁负责 |
|---|---|---|
| `clis/index.js` | `ENTRY_FILES` 5 个 key + 1 处 filter 字面量 `"dsh-clis"` → `"dsh-mind-system/clis"` | **构建** |
| `meta/test/clis-rule.js:57,60` | `'../../dsh-clis/xxx.js'` → `'../../clis/xxx.js'` | **构建** |
| `mind/test/interfaces.test.js` | 加 `MEMBER_DIR` 映射（测试跨包读文件，路径层数变了） | **构建** |
| `memory/client.js` | `id` 不同 | `sync-client-id.mjs`（已接管） |
| `memory/{api,harness,ui}-test.mjs` | 上一轮加的环境探针/SKIP | 已接管语义 |

**这是本方案能成立的前提**：改写面只有 3 个文件、5 条替换，不是"两套代码"。
注意其中 2 个是测试文件——也就是说，产物与源的差别，**几乎只影响测试怎么找到彼此**，
不影响运行时行为。这让"构建结果必须逐字节可复现"这个验收标准变得容易达到。

### 1.3 规模

| 来源 | 文件数 | 去向 |
|---|---|---|
| `dsh-clis` | 26 → 24 | `clis/` |
| `dsh-agent-mind` | 21 → 19 | `mind/` |
| `dsh-meta-framework` | 17 → 13 | `meta/` |
| `dsh-memory-manager` | 30 → 28 | `memory/` |
| 合成包手写 | 9 | 包根 |
| **合计** | **93** | |

### 1.4 排除项都是对的（已逐个核实）

| 排除 | 原因 |
|---|---|
| 四个 `cordis.patch.yml` | 装配由根 patch 统一表达（9 条 insert），成员 patch 会重复装载 |
| 三个 `.gitignore` | 仓库级元数据 |
| `package-lock.json` / `REVIEW.md` | 独立包自己的工作文件 |
| `data/`（空目录） | 运行期数据 |
| `reload-core.mjs` | **运行时自举**：`clis/index.js` 的 `ensureReloadCore()` 内嵌了 `RELOAD_CORE_SOURCE`，缺文件时自己写出。独立包那份只是可读参照 |

上一轮我怀疑 `reload-core.mjs` 是漏拷的真 bug，**核实后不是**。这类排除必须在 manifest 里写明理由，
否则下一个人（或下一轮的我）会再来怀疑一遍。

### 1.5 一个藏起来的坑：`meta/node_modules`

`packages/dsh-mind-system/meta/node_modules` 里有 **83 个文件**（`@causal-layers/meta-framework`，
`meta` 成员的唯一外部依赖）。它：

- 不被 git 跟踪（0 个文件在 `git ls-files` 里）；
- **不在**合成包 `package.json` 的依赖里——根包 `dependencies` 是空的；
- 但运行时必须有，否则 `meta` 起不来。

所以构建**绝不能整目录删了重建**：`node_modules` 一旦被清掉就得重新 `npm install`，
而合成包并没有声明这个依赖。manifest 的清理范围必须精确到"声明过的相对路径"，
`node_modules/` 一律不碰。这条单独立规矩：**构建只管理 manifest 里有名字的文件。**

---

## 2. 为什么值得做

现在的痛，全部来自"同一份逻辑存在两处，靠人记得同步"：

1. **改一处要改两处**。改了 `packages/dsh-clis/index.js` 忘了同步 `clis/index.js`，本机能跑、发布是旧的。
2. **改了副本会静默通过**。因为没有校验，`npm test` 全绿也可能产物是陈的。
3. **没人知道该排除什么**。排除规则只存在于当初那次 `cp` 的记忆里。
4. 已经咬过一次：`memory/client.js` 双身份导致 dsh 启动报 `loaded without registering`。

`sync-client-id.mjs` 已经在解决同类问题（一个源 + 生成副本 + 漂移守卫），本方案是把它推广到整棵树，
**同一套哲学，不引入新概念**。

---

## 3. 方案选择

| | A：生成 + 提交产物 | B：生成 + gitignore | C：不做生成，只加校验 |
|---|---|---|---|
| 装的人要不要 build | 不要 | **要**（或依赖 `prepare`） | 不要 |
| 漂移能否发现 | 能（`--check`） | 天然不会漂 | 部分（比对 hash，但要手写规则） |
| git diff 噪音 | 有（源改动同步出现在产物里） | 无 | 无 |
| 与现有 `file:` 安装兼容 | 完全兼容 | 需验证 `prepare` 在 `file:` 下是否触发 | 完全兼容 |
| 工作量 | 中 | 中 + 安装链路验证 | 大（等于重写规则两遍） |
| **结论** | **选它** | 暂不 | 否 |

选 A 的核心理由：**不改变任何消费者看到的东西**。装的人、`publish-check`、`npm pack` 流程全部不变，
变的只是"产物由脚本生成、且漂移会被拦住"。B 把成本转嫁给安装链路（本机就是 `file:` 装进 profile，
`prepare` 在这里的行为我没验证过，不能拿它当基础假设）。

代价是产物入库、diff 噪音。用「产物目录顶部写一行 `// 由 scripts/build-combined.mjs 生成，勿手改`」
缓解——但**只有 `--check` 能真正拦住**，注释只能提醒。

---

## 4. 设计

### 4.1 manifest：`packages/dsh-mind-system/build.manifest.json`

声明式，不把规则藏在脚本里：

```json
{
  "generatedBy": "scripts/build-combined.mjs",
  "members": [
    {
      "package": "dsh-clis",
      "dir": "clis",
      "exclude": [
        { "path": "cordis.patch.yml", "why": "装配统一由根 patch 表达" },
        { "path": "reload-core.mjs", "why": "运行时由 ensureReloadCore() 自举写出" }
      ]
    }
  ],
  "rewrites": [
    {
      "file": "clis/index.js",
      "edits": [
        { "from": "\"dsh-clis\": \"index.js\"", "to": "\"dsh-mind-system/clis\": \"index.js\"" },
        { "from": "name2 !== \"dsh-clis\"", "to": "name2 !== \"dsh-mind-system/clis\"" }
      ]
    }
  ]
}
```

关键约束：**每条 `from` 必须命中，命中数不等于期望值就报错退出**。
这样上游代码一变（比如 ENTRY_FILES 改名），构建立刻红，而不是静默产出一份半改的文件。
这和 `sync-client-id.mjs` 里「`load({` 与 `id:` 之间只允许注释，否则抛错」是同一条原则。

### 4.2 `scripts/build-combined.mjs`

```
读取 manifest
→ 清空四个成员目录：只删 manifest 声明范围内的文件
  （`node_modules/` 永不触碰；遇到未声明的文件报错而非静默删）
→ 逐包 copy（排除 exclude）
→ 应用 rewrites（逐条断言命中）
→ 生成 build-stamp.json（源 git rev + 每个源文件的 sha256）
```

**必须 write-to-temp + rename，不能 `writeFile` 原地覆盖**：合成包文件与运行安装副本是硬链接，
原地写会直接改掉正在跑的 dsh。`rename` 会断开链接（旧 inode 留给 profile 副本），
这是我们要的语义——源码变了，运行实例**必须显式重装**才生效，而不是被偷偷改掉。

`build-stamp.json` 的作用：出问题时能回答"这份产物对应哪个源 rev"。
它随包发布（加入 `files`），体积可忽略。

### 4.3 `scripts/verify-combined.mjs --check`

不信任"上次构建的人做了正确的事"，直接验证：构建到临时目录 → 与工作区逐文件比 sha256 →
不一致就列出「多余 / 缺失 / 内容不同」三类并退出 1。

这是 `--check` 而不是"重新构建覆盖"：CI 里覆盖掉就等于把错误吃掉了。

### 4.4 与 `sync-client-id.mjs` 的先后（**原设计已作废，见 §9.3**）

原计划：`build-combined` → `sync-client-id`，两个脚本各管一件事。

实施时发现两者**方向相反**：`sync-client-id` 把聚合包那份当唯一源、生成独立包副本；
而构建以独立包为源、生成聚合包产物。同一文件被两个脚本反向生成，正是本方案要灭掉的那类 bug。
最终把 `client.js` 的 id 差异收进 `scripts/build/rewrites.mjs` 的一条规则，`sync-client-id` 退役。

### 4.5 手写与生成的边界（明确写死）

| 手写（源） | 生成（产物） |
|---|---|
| `packages/dsh-mind-system/index.js`（装配清单） | 四个成员目录下全部 84 个文件 |
| `packages/dsh-mind-system/cordis.patch.yml`（9 条 insert） | `build-stamp.json` |
| `packages/dsh-mind-system/package.json`（exports / files / 版本） | |
| `README.md` / `LICENSE` / `scripts/` / `test/` | |

包根这 9 个文件**不进构建**——它们是创作物。评审时谁想把它们也生成，请单独论证。

---

## 5. 落地步骤（每步独立可验证、可回滚）

**P0 基线快照**
把当前 93 个文件的 sha256 存成 `build.manifest.json` 旁边的 golden 文件（不入库，仅本地）。
后面每一步都拿它对比。

**P1 manifest + build（不接 CI）**
写完跑一次构建，要求：**产物与现状逐字节一致**。
不一致就说明 manifest 漏了规则——这是本方案最强的自检，比任何测试都直接。

**P2 verify --check + 反向验证**
手改一个产物文件 → `--check` 必须退出 1 并指名文件；改回 → 绿。

**P3 接进 `npm test`**
顺序：`verify-combined → verify-readme → ... → run-all → publish-check`。
同时把 `build-combined.mjs` 加进根 `package.json` 的 scripts。

**P4 处理安装关系（§6.1）** —— 已做，且从"写文档"升级为"写脚本"（原因见 §9.7）：
`scripts/install-profile.mjs`（`npm run install:profile`），顺序固定为
「拷到同级临时目录 → 校验文件数与注册 id → 再替换」，任一步失败旧副本不动；
`build-combined` 检测到与安装副本共享 inode 时会警告。

**P5（另议）要不要把产物移出 git**
P1–P4 稳定后可以再评估方案 B。**不在本次范围**。

---

## 6. 风险与对策

### 6.1 硬链接会把构建写进正在运行的 dsh（最高风险）

现状：合成包与 `~/.dsh/profiles/web/node_modules/dsh-mind-system` **同 inode、links=2**。
任何原地写都会同时改掉运行实例——上一轮我"修 profile"实际上直接改了源码，就是这条链。

对策：
- 构建一律 temp + rename（§4.2）；
- 构建结束检查每个产物文件的 `links`，若 `>1` 则警告；
- 文档写清：**源码改了 ≠ 运行实例改了，装进 profile 必须显式重装**。

### 6.2 产物 diff 噪音让人不敢看 diff

对策：`build-stamp.json` 单独提交、与源码改动分开 commit；产物改动在 commit message 里标 `build:`。

### 6.3 `clis/` 是构建产物，没有源（本次不解决）

`clis/` 下 5 个 chunk + 4 个入口是 esbuild 产物（残着 `// packages/clis-plugin/src/index.ts` 的痕迹），
包里没有 TS 源、没有 sourcemap。**本方案只保证"复制正确"，不解决"能否改"**。
这是独立问题，需要单独方案（要么找回 TS 源，要么补 sourcemap）。
**明确写在这里，避免有人以为做完构建就解决了 clis 可维护性。**

### 6.4 manifest 漏文件

对策：build 时若"源目录有文件、manifest 既没 include 也没 exclude"，**报错**。
不允许沉默的默认行为。

### 6.5 两个 `--check` 互相甩锅

对策：`build-check` 只比"文件内容是否等于源 + 改写"；`verify-client-id` 只比 id。
报错信息带文件名与期望值，不用猜。

---

## 7. 验收标准

做完必须同时满足：

1. `npm run build` 一次后 `git status` 只出现预期改动（无意外新增/删除）；
2. **首次构建产物与现状逐字节一致**（P1 的核心验收）；
3. `npm run verify-combined`：干净时退出 0，手改任一产物后退出 1 并指名；
4. `npm test` 全绿（含 `run-all` 与 `publish-check`）；
5. dsh 用新产物启动，控制台无 `import failed` / `without registering`；
6. `publish-check` 的 exports 目标、成员目录、版本区间全部 PASS（构建不能破坏发布契约）。

---

## 8. 明确不做

- 不解决 `clis/` 无源问题（§6.3）
- 不拆 `memory/server.js`（4,730 行）
- 不把产物移出 git（方案 B，另议）
- 不改包根 9 个手写文件
- 不动版本号与发布流程

---

## 附：待评审的取舍点

1. **产物入库**（A）还是**移出 git**（B）—— 我选 A，但这是最该被质疑的一条。
2. **build-stamp.json 是否随包发布** —— 我倾向发布（利于排障），但它会成为 `files` 里的新成员。
3. **`install:profile` 是脚本还是文档** —— 我倾向先写文档，跑两次确认稳定后再脚本化。

---

## 9. 实施记录（2026-11-03）

### 9.1 结果

- 产物 85 个文件 = 84 个成员文件 + `build-stamp.json`（排除 10 项）。
- **首次构建与现状逐字节一致**，只有指纹文件是新增——这是 P1 的核心验收，一次通过。
- `verify-combined` 干净时 0，手改产物 / 加无来源文件时 1 并指名（P2 反向验证通过）。
- `npm test` 全链路 ALL PASS；`publish-check` ALL PASS。

### 9.2 偏差一：改写表单独成 `scripts/build/rewrites.mjs`，没塞进 manifest

原设计把 `rewrites` 写成 manifest 里的 JSON。实施时发现 `mind/test/interfaces.test.js` 那条是
**跨行**的（插一行 + 改两行），JSON 里写成 `\n` 转义后没人能核对。
改为独立模块、**纯数据无逻辑**，评审时能逐字对照产物。manifest 保留"收哪些、排除哪些及理由"。

### 9.3 偏差二：`client.js` 的源方向反了，且 `sync-client-id.mjs` 退役

上一轮 `sync-client-id` 的方向是「聚合包那份是唯一源 → 生成独立包副本」。而构建的方向是
「独立包是源 → 生成聚合包产物」。同一个文件被两个脚本反向生成——**这就是双身份 bug 的成因本身**。

最终处理：

1. 把源翻回独立包 `packages/dsh-memory-manager/client.js`（id `dsh-memory-manager`）；
2. 把两侧注释**统一成一段两种装法都成立的文本**，只留 `id` 一行差异；
3. 聚合包那份的 `id` 由 `scripts/build/rewrites.mjs` 一条规则替换（命中次数被断言）；
4. 删除 `scripts/sync-client-id.mjs` 及其两个 npm script。

附带好处：注释不再分叉，改写规则从"整块注释 + id"缩成"一行 id"。**注释若哪天又要分叉，说明设计退化了**。

### 9.4 偏差三：`build-stamp.json` 不含 git rev

原设计想写"源 git rev"。实施时放弃：rev 随每次提交变化，会让指纹文件在**每个** commit 里都变，
diff 噪音换不来多少信息（需要时 `git log -1 -- <文件>` 就有）。现在只记「产物路径 → 源路径 + sha256」，
因此同一份源永远得出同一份指纹。

### 9.5 回流了三个测试文件

上一轮只改了聚合包那三份（`memory/{ui,api,harness}-test.mjs`），独立包没跟上——构建一跑就把它们
当成"产物比源新"。已把这三份回流到源包（内容与包无关，两种装法通用）。现在两侧逐字节一致。

### 9.6 一个没做的检查

`npm test` 里没有断言"独立包那份 `client.js` 的 id 等于它自己的包名"。目前由
`build/rewrites.mjs` 的命中计数间接兜住（改坏了构建立刻红），加上 `memory/ui-test.mjs` 的双向推导。
够用，但不如一条直白的断言。若将来又加第三个声明 `dsh.client` 的包，应该补一条遍历式检查。

### 9.7 事故与由此新增的脚本

反向验证时我"故意把产物改坏"用了**原地写入**，因为与安装副本是硬链接，
**改产物等于改运行副本**——安装副本里 `clis/index.js` 的第一个 ENTRY_FILES key 当场变错。

修复时手工执行 `cp -r` + `rm -rf` + `mv`，更糟：`cp` 落在沙箱隔离层、`rm` 落在真实目录，
结果**只删掉了安装副本、没换成新的**，运行实例一度缺文件（3080 端口仍在，但目录只剩 `clis/`）。
源码树完好，已用真实文件系统重建，并改为独立拷贝（inode 与源码不同）。

由此把 P4 从"写清步骤"升级为"写脚本"：`scripts/install-profile.mjs` 把正确顺序固化
（临时目录 → 校验 → 替换），并在产物与源不一致时**拒绝安装**。
`--profile` 会先验证目标确实是 `dsh-mind-system`，避免参数打错删掉别的东西。

教训（写给下次的自己）：**对 ~/.dsh 这类真实安装目录的操作，不要用"先删再建"的手工命令序列**，
尤其不能在沙箱可能介入的情况下。要删，就删一个刚建好的东西；要建，就先建好再换。
