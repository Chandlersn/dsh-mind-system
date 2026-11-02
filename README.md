# DSH 心智系统

> 让 agent 知道"遇到什么问题先问什么"，并且**能自己发现自己错了**。

**简体中文** | 仓库 <https://github.com/Chandlersn/dsh-mind-system>

四个插件合成一个仓库（`packages/` 下），npm 上是五个独立包。

---

## 为什么做这个

DSH 的工具面是**平铺**的：几十个工具并排躺在提示里，每个都带一段描述。模型要自己从描述里分辨"此刻该用哪个"——这是一次没有辅助的临场判断，于是：

- **反复无效时换方案，而不是换判据**。指标来回震荡、越调越糟，模型继续换做法，而真正的问题是对因果结构的误判（是环、是对偶、还是单向）；
- **不知道的事与没做成的事混在一起**。"这个 API 怎么调"和"改了没效果"是两类问题，却都表现为"再试一次"；
- **判据写在文档里等于没写**。文档不读，模型不知道；写了不校验，改了就漂；
- **沉淀下来的东西没法被检验**。记了一堆结论，但没人知道哪条还成立、哪条早被推翻了。

心智系统把这四件事变成机制：

```
用户的问题
   ↓
① dsh-agent-mind      判断顺序常驻提示 + 按处境把该看的工具推到眼前
   ↓                 （"什么时候用谁"被显式化，不再靠模型从平铺的工具表里猜）
② dsh-clis            判因果结构：环 / 对偶 / 单向 / 嵌套
   ↓                 （反复无效时，给尺子而不是给更多方案）
③ dsh-meta-framework  重新审视问题本身：重定义 → 边界 → 选择 → 观测
   ↓                 （"真问题可能不是字面问题"）
④ dsh-memory-manager  沉淀：五层判据守写入，判据反哺上一轮
                     （器 → 术 → 法 → 道，每层有边界有反面）
```

---

## 适合 / 不适合

**适合**：想让 DSH 上的 agent 在**多步、反复、容易走偏**的任务上少走弯路的人。
尤其适合"改了很多次还是不对"这类场景 —— 心智系统的主要价值在**第二次尝试之后**才显现。

**不适合**：

- 单步问答、一次性脚本 —— 装它只是多占一点提示空间；
- 需要精确控制工具调用顺序的场景 —— 调度层只**重排不删除**，且有一拍延迟（见「已知限制」）；
- 已经在用别的记忆方案且不想换 —— memory-manager 会与既有记忆根冲突（同一 `~/.dsh/memory` 下不建议并存两套）。

---

## 快速开始

```bash
dsh plugin --profile web add dsh-mind-system
```

装完**重启宿主**（server 半边需要重新装载）。

聚合包 `dsh-mind-system` **装载四个成员**，是它们唯一的装载入口。
别再单独装其中一家 —— 那家会被装载两次（同 id 覆盖，仍能工作但行为取决于装载顺序）。

### 只想用其中一家的能力

从聚合包的 `bundles` 里移除其余即可；或者直接单独装那一家（此时不要装聚合包）。

| 少装 | 后果（是降级，不是报错） |
|---|---|
| `dsh-clis` | 判不了环/对偶/单向；meta 退化为通用重定义；系统监督消失 |
| `dsh-meta-framework` | 失去"重新审视问题"这一手 |
| `dsh-memory-manager` | 记忆写入无判据把关，蒸馏退回"写进去就算" |
| `dsh-agent-mind` | 工具平铺在提示里，模型得自己从描述里分辨该用谁 |

### 三种安装形态（各实测一次）

| 形态 | 实测结果 |
|---|---|
| 聚合包不装载四家 | 单独装 = 四家全都不在（`clis_probe` 消失） |
| 聚合包装载 + 四家也在 `bundles` | 双装载，**聚合包自己被挤掉**（user_plugins 14，mind-system 消失） |
| **聚合包装载 + 四家不在 `bundles`** | **唯一入口、零重复** ← 采用 |

---

## 架构

### 依赖方向（只有 import / ctx.get / 服务注册才算依赖）

```
        dsh-base（宿主提供 systemPrompt / tools 服务）
              │
    ┌─────────┼─────────┬──────────────┐
    ▼         ▼         ▼              ▼
 agent-mind  clis   meta-framework  memory-manager
    │         │         │              │
    │         └────────►│  取分类器     │
    │         （ctx.get）              │
    └──────────► 广播信号 ◄────────────┘
      mind/register-signal（外部 → 调度层）
```

- **clis** 是唯一的因果判据提供者。`meta-framework` 通过 `ctx.get('clis.causalClassifier')` 取它；取不到就退化为通用重定义（**降级而非报错**）。
- **agent-mind** 不 import 任何一家。它靠两条广播通道与外界通信：
  - `clis/register-probe`（自己 → CLIS，探针登记）
  - `mind/register-signal`（外部 → 自己，处境信号贡献）
- **memory-manager** 自足，不依赖另外三家。

用广播而非 import，是因为 import 会造成反向依赖 ——
"没装调度层就装不上 CLIS"是坏形态。

### 判断顺序分节（agent-mind 注入系统提示的内容）

不是工具清单，是**四步问自己**：

1. 这是"不知道该怎么办"，还是"知道但没做成"？
2. 反复无效时，先怀疑"判断的因果结构"，而不是继续换方案
3. 动手前确认"这事以前是不是已经定了"
3b. 觉得"这个问题本身问错了"时，先重定义
4. 需要外部事实时，分清"找"和"读"

分节点名六件工具：`clis_classify` / `clis_run` / `clis_plan`（判结构）、
`memory_read` / `memory_search`（先查再动）、`meta_reframe`（重定义）。

### 五种处境（调度判定的结果）

| 处境 | 何时进入 | 工具面怎么变 |
|---|---|---|
| `diagnose` | 解法未知、反复无效、分不清因果 | 判据工具提前 |
| `execute` | 知道要做什么，只差动手改 | 执行工具提前 |
| `recall` | 涉及既有约定/踩过的坑 | 记忆工具提前 |
| `retrieve` | 需要外部事实 | 检索工具提前 |
| `unknown` | 判不出来 | 什么都不做，保持默认顺序 |

**只重排，不删除。** 工具只有出现在声明里模型才知道它叫什么，藏掉它连问的机会都没有。

**核心工具永不移动、永不延后载入**：
`pwsh` `read` `write` `edit` `glob` `grep` `present` `todo_write`
`ask_user_question` `list_agents` `send_message` `team_task_*` `workflow` `subagent`

### 外部单元贡献信号（零配合）

调度层原本只有自己写的词表，于是**各插件自己领域的词汇全是盲区** ——
实测「判一下这个是不是回路」「因果结构」「对偶」「沉淀」「五层」全部无信号，
而这些恰是各插件最该被用上的时刻。

现在各家主动广播自己的词汇：

| 谁 | 信号 | 词表 |
|---|---|---|
| `dsh-clis` | `clis-causal` | 因果、结构、回路、反馈环、对偶、矛盾、归因、根因… |
| `dsh-memory-manager` | `memory-recall` | 沉淀、蒸馏、五层、层级、边界、反面、约束条件… |

用广播而非 import：直接 import 会让 CLIS 反向依赖调度层，于是"没装调度层就装不上 CLIS"。
**广播没有方向性** —— 缺调度层时这条广播无人接收，CLIS 照常工作。

信号形状的契约由 `tests/signal-broadcast.test.ts` 守住（7 条）——
事件名写错、载荷改成位置参数、字段名对不上，这些在类型断言下**编译期全绿**，
只有契约测试能抓住。

---

## 四个包详解

### dsh-agent-mind · 调度层

把"判断顺序"装进系统提示，并按当前处境把该看的工具推到眼前。

**三个机制**（`src/dispatch.js`）：

| 能力 | 说明 |
|---|---|
| 信号可注册 | 任何单元贡献自己的处境信号（带词表、**反例词**、权重、归属） |
| 判定可解释 | `explainSituation()` 返回命中哪些、落选哪些、各命中几处 |
| 命中可记账 | 探针区分"调度没生效"与"本轮无信号"（两者原本同形） |

内置 11 条信号，分两族：**症状族**（没效果/无效/反复 → 诊断）、
**意图族**（评估/审查/完善/有没有/靠谱吗 → 先看而不是先动手）。
反例词让信号能自己否定自己 —— "这个测试**反复**失败"里的"反复"指测试自身，
不该触发诊断。

**命中率可测**（`src/hitrate.js`）：三批样本

| 批次 | 用途 | 门槛 |
|---|---|---|
| A · 每日记录里的真实用户原话 | 真实但偏具体任务 | ≥ 50% |
| B · 本会话真实输入 | 抽象指令，当前真实分布 | ≥ 50% |
| **C · 留白样本** | **改词表时不许看** —— 唯一的泛化检验 | **≥ 60%** |

改词表后，参与修表的样本会跑到 100%，但全新样本只有 50% ——
**拿考题补答案的自欺**。所以 C 批固定在测试里不改。

**真实使用采样**（`src/sampling.js`）：每次判定落盘，按天聚合成趋势。
**只存输入哈希，不存原文** —— 够算趋势，且不可反推内容。

**只读工具 `mind_signals`**：查此刻覆盖了哪些词、谁贡献的、上次判定命中了什么。
没有它，"生态为空"与"生态已长出来"在观察上完全同形。

### dsh-clis · 因果结构判据

四个组件 + 五个工具。

| 组件 | 职责 |
|---|---|
| `clis-classifier` | 判因果类型：环 / 对偶 / 单向 / 嵌套 |
| `clis-strategy` | 给匹配的做法与代价 |
| `clis-feedback` | 跨轮信号判"反复偏离" |
| `clis-orchestrator` | 多轮决策与回滚 |
| `clis-tools` | 把上面四个包成工具（`clis-tools` bundle） |

**介入机制带漏判分母**：`clis_run` 的写动作默认拦下，只放行只读动作。
每次"放过"都记原因与闸门分解，`miss_rate` 可查 ——
**漏判的分母在这里，不在别处**。

> 没有分母，"漏判率 0%"和"没人看"完全同形。所以 `clis_metrics` 把
> `hinted`（真的递过尺子）、`adopted`（模型真的用了）、`skipped`（评估过但放过）
> 与 `missRate = skipped / evaluated` 分开报 —— 只看 `hinted` 那一栏，
> "闸门在工作"和"没人在看"长得一样。

**系统监督**：`clis_probe` 只投递被监督者自己产不出的结论（结构性判断），
对方自查出的逐条警告在各自面板里已有，重复搬运只是噪音。

### dsh-meta-framework · 重新审视问题

一个工具 `meta_reframe`，四层流程：

```
重定义 → 边界 → 选择 → 观测
```

**它是诊断工具不是决策工具** —— 给你重定义、适用范围与因果结构判断，
不替你决定下一步做什么。取不到 CLIS 分类器时退化为通用重定义。

每次调用写 trace 可回放；退出码与失败记录如实报告（部分作答会显式报缺项，
不静默丢弃）。

> 探针只读**实测结果**，不靠 `existsSync` 推断加载状态 ——
> "文件在但 require 抛错"会假绿。这条曾真踩过：
> 探针报 ok，而实际工具一个都没注册上。

### dsh-memory-manager · 五层记忆

十四工具，五层结构：

| 层 | 目录 | 收什么 | 硬门槛 |
|---|---|---|---|
| **器** | `capabilities/` + `skills/` | 接触面：工具/插件/探针/面板/检索，以及可调用程序 | 台账要写前提与坑 |
| **术** | `functions/` | 一个功能域的迭代史 | 块 ≤ 900 字，概括 ≤ 110 字 |
| **法** | `insights/` | 会重套的原则 | ≥ 2 个**无关**来源域；必须写边界（含反面） |
| **道** | `dao/` | 最抽象的命题 | ≥ 5 条法萃取；含哲学形态；描述/推演/边界三节 |
| **技能** | `skills/` | 反复跑通且被验证的操作程序 | 步骤 + 验证 + 前提 |

**判据是代码，不是文档。** 写入路径 = 写入前拒绝（`layer-gate.js`）
+ 落盘后从磁盘回读复核（`layer-selfcheck.js`）+ 回执带 `selfCheck`。
道的体结构另有 `dao-shape.js` 把关。

三个模块，**判据单一实现** —— 展示层只读不判。

> **判据能自检的证据**：一次写入说"道已沉淀"，体检 R24 却读出 **0 条来源法** ——
> 写入方按模板写、模板节在文件里、判据是 `split('## 来源法')[1]`，
> 而正文里的「## 来源法逐条」把 `[1]` 抢走了。于是"我写了"与"写出的东西符合道的定义"
> 被当成同一件事。现在判据从磁盘回读正文、按整行精确匹配取**最后一个**「## 来源法」节。

---

## 工具总表

**21 个工具**（agent-mind 1 + clis 5 + meta 1 + memory 14）

| 工具 | 包 | 用途 |
|---|---|---|
| `mind_signals` | agent-mind | 查调度覆盖了哪些词、谁贡献的、上次判定命中了什么（只读） |
| `clis_classify` | clis | 只判因果结构，不给做法 |
| `clis_run` | clis | 给匹配做法并执行；写动作需显式放行 |
| `clis_plan` | clis | 只列做法与各自代价，不执行 |
| `clis_probe` | clis | 系统级插件监督：覆盖面 + 结构性诊断 |
| `clis_metrics` | clis | 介入效果读数（含**漏判分母** `miss_rate`） |
| `meta_reframe` | meta-framework | 重新审视问题：重定义 → 边界 → 选择 → 观测 |
| `memory_read` | memory-manager | 按索引行判断相关性后读功能域/思想/道 |
| `memory_search` | memory-manager | 全库排序检索（带时间区间） |
| `memory_write` | memory-manager | 追加一个术层迭代块（≤900 字，蒸馏结论） |
| `memory_index` | memory-manager | 收一条索引行（功能域稳定后） |
| `memory_insight` | memory-manager | 蒸馏一条可迁移原则（法层，含边界） |
| `memory_dao` | memory-manager | 萃取一条道（≥5 法来源，含哲学形态） |
| `memory_fold` | memory-manager | 折叠最旧迭代块（R9 体积治理） |
| `memory_rename` | memory-manager | 重命名/合并功能域（改写全部引用并验死链清零） |
| `memory_check` | memory-manager | 体检记忆根（25 条判据） |
| `memory_usage` | memory-manager | 记/读使用信号（纠正率 → 分层建议） |
| `memory_federation` | memory-manager | 联邦模式同步/体检 |
| `memory_capability` | memory-manager | 能力台账（外部 CLI/MCP 的调用方式与坑） |
| `memory_skill` | memory-manager | 技能结晶/生命周期 |
| `memory_inbox` | memory-manager | 插件问题收件箱 |

---

## 判据总表

### memory-manager · 25 条（21 WARN / 7 FAIL，有重叠）

| 代号 | 管什么 | 级别 |
|---|---|---|
| `R0` | 记忆根本身不可用 | FAIL |
| `R3` | 迭代日期标签非递增 / 头部摘要早于最新迭代块 | WARN |
| `R5` | 分区文件没有索引行（**未被索引 = 无法被召回**） | FAIL/WARN |
| `R8` | 功能文件反向链接到 MEMORY.md 细节 | FAIL/WARN |
| `R9` | 功能文件体积超限 | WARN |
| `R10` | 悬空链接 / 越出记忆根 | FAIL |
| `R10e` | 分区文件无索引行（R5 的扩展） | WARN |
| `R13` | `legacy/` 文件缺「历史原貌」头 | WARN |
| `R14` | 迭代块超长 / 索引行摘要未蒸馏 | WARN |
| `R15` | 重复索引行或重复表段 | WARN |
| `R16` | 环境常量里的绝对路径已不存在 | WARN |
| `R18` | 某域近 7 天纠正率 > 40%（熔断） | WARN |
| `R19` | 共识区缺依据链接 | WARN |
| `R20` | 技能层退休预算（超量 / 单源比例过高 / 死链） | WARN |
| `R20e` | 索引行数超平表上限 | WARN |
| `R21` | 记忆文件里的凭据或个人标识符 | FAIL/WARN |
| `R22` | 纠正 ≥ 认可（结论不稳定） | WARN |
| `R23` | `.usage.jsonl` 悬空 href | WARN |
| `R24` | 道层缺「来源法」节 / 判据自身不完整 | WARN |
| `R25` | 道层条目数超上限 | WARN |
| `F1` `F3` `F4` `F5` `TEMP` | 冻结区 / 临时区 / 冷记忆判定 | 混合 |

守护型（🛡）文件跳过冷记忆规则 —— 低频高价值的兜底经验不该因"很久没写"被删。

### agent-mind · 调度判据

- 命中率回归：C 批留白样本 ≥ 60%，A/B 批 ≥ 50%
- 留白样本固定在测试里，**改词表时不许看**
- 采样只存输入哈希，**不存原文**

### clis · 判据

- 介入只放行只读动作；写动作需 `allow_writes` 显式白名单
- **每次放过都记账**（原因 + 闸门分解），`miss_rate` 是分母
- `clis_probe` 只投递结构诊断，不转发对方的逐条警告

### meta-framework · 判据

- 探针只读实测结果，**不靠 `existsSync` 推断**（"文件在但 require 抛错"会假绿）
- 部分作答显式报缺项（`answers_missing`），不静默丢弃

---

## 已知限制

**调度有一拍延迟（结构性，不是缺陷）。**
处境取自 `agent/pre-step` 的 `payload.messages`（那是唯一能看到本轮用户输入的地方），
但宿主 `preStep()` 的次序是：

```
:907  assemble()          ← 装配先发生
:909  agent/pre-step      ← 处境后发生
```

第 N 步读到的处境作用在第 N+1 步的工具面上。memory-manager 的召回注入、
clis 的提示注入都遵循同一时序。**写在这里是为了让后来者不要试图"修"它** ——
那需要改动宿主时序。

**命中率不是 100%，也不会是。**
留白批门槛是 60%，实测 80%。剩下 20% 是**真实用户表述的分布**——
不是 bug，是词表跟不上人话。趋势采样就是为盯这个：无信号率走高就该扩词表。

**`mind_signals` 工具需要宿主有 `dsh-tools`。**
取不到就静默降级（工具不注册，其它功能不受影响），但会留 warn 日志 ——
**静默降级过一次**，那次探针只报 `mind.ok`，看起来一切正常。

**聚合包与单独安装互斥。**
聚合包装载四家；再单独装一家会双装载（同 id 覆盖，仍能工作但行为取决于装载顺序）。

**`packages/dsh-clis` 是发布产物，不是源码。**
CLIS 的真正源码在独立仓 `Chandlersn/dsh-clis`（多包 workspace：`@causal-layers/clis-*`）。
改 CLIS 源码后要重新 `bundle.mjs` → `package.mjs` → 同步到 `packages/dsh-clis`。
这条链已踩过坑：**拷贝式打包不重建中间产物**，于是改的是源码、跑的是旧产物。

**CLIS 的 `mind/register-signal` 事件类型不在 clis-contracts 声明。**
声明在那里会让不依赖任何包的 memory-manager 拿不到同一事件名，
类型层与运行时层分叉。改用局部类型断言 + 契约测试保证载荷形状。

**HMR 监视范围是硬编码白名单。**
改 `dsh-agent-mind` / `dsh-memory-manager` 的代码若不在 `root` 列表里，
**不会触发模块替换** —— 表现为"改完了但行为没变"，且没有任何报错。
本机 profile 已把两者加进 `cordis.patch.yml` 的 HMR `root`。

---

## 配置

在 profile 的 `cordis.yml` 里给对应 bundle 配 `config`：

```yml
- id: memory-manager
  name: 'dsh-memory-manager'
  config:
    memoryRoot: C:/Users/you/.dsh/memory   # 默认 ~/.dsh/memory
    maxIndexBytes: 10240                   # 索引舒适线（10KB）
    maxIndexHardBytes: 15360               # 索引硬上限（15KB，达到即拒写）
    maxFunctionBytes: 30720                # 单个功能文件上限（30KB）
    newFeatureGraceDays: 3                 # 冷记忆宽限期（天）
    recallTimeoutMs: 3000                 # 前台召回预算（只能缩短不能延长）
    dshRoot: D:/dsh                        # 一般不需要，见下
```

| 配置项 | 默认 | 作用 |
|---|---|---|
| `memoryRoot` | `~/.dsh/memory` | 记忆根目录 |
| `maxIndexBytes` | 10240 | 索引舒适线，超过提示拆分 |
| `maxIndexHardBytes` | 15360 | 索引硬上限，达到即拒绝写入 |
| `maxFunctionBytes` | 30720 | 单个功能文件上限，超了用 `memory_fold` 折叠 |
| `newFeatureGraceDays` | 3 | 冷记忆宽限期：最近改动过的不报冷 |
| `recallTimeoutMs` | 3000 | 前台召回绝对超时；超时**静默放行**（不注入半成品、不拖慢该步） |
| `captureUserTurns` | `false` | 是否把用户对话被动捕获进每日原始层 |
| `captureMaxChars` | 160 | 捕获行的截断长度 |
| `dshRoot` | 自动探测 | DSH 安装目录（仅当自动探测失败时才需指定） |
| `federation` | 无 | 联邦模式：`{ root, projects: [{ key, root }] }` |

`recallTimeoutMs` **只能缩短不能延长** —— 配置可以更保守，不能更激进。

`captureUserTurns` 默认关闭：原始层属于模型，把每轮对话都记下来是噪音，
也是隐私问题。

---

## 排错

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 改了插件代码，行为没变，也没报错 | 该包不在 HMR `root` 列表里 | 把它的真实物理目录加进 `cordis.patch.yml` 的 HMR `root`（**不能写 junction 路径**，`**/node_modules` 默认被过滤） |
| `clis_probe` 报 `unknown tool` | CLIS 没装载成功 | 看宿主启动日志的 "did not activate"；多半是 `inject` 的依赖服务没就位 |
| 聚合包装了，但四家都不在 | 聚合包与单独安装互斥 | 从 `bundles` 里去掉单独装的那家，或去掉聚合包 |
| 调度命中但工具面没变 | 一拍延迟（结构性） | 处境在下一轮生效，不是 bug |
| `mind_signals` 工具调不到 | 宿主没有 `dsh-tools` | 看 `mind` 的 warn 日志；工具降级但其它功能不受影响 |
| `memory_check` 报 R5 孤儿文件 | 新建了分区文件但没进索引 | 用 `memory_index` 收一行；不收就等于召回不到 |
| `memory_dao` 说"已沉淀"，体检 R24 却读出 0 条来源法 | 判据自身有 bug（已修） | 现在判据按整行精确匹配取**最后一个**「## 来源法」节 |
| 改了 `server.js` 不生效 | 模块生成缓存以 realpath 为键 | 重启宿主 |
| npm 上 `dsh-mind` 装成了别人的包 | 名字被占用 | 用 `dsh-agent-mind` |

---

## 借鉴出处

这套系统的部分设计来自别处已验证的做法，写在这里以便追溯：

| 借鉴 | 体现在 |
|---|---|
| **Hindsight 的 memory defence** | 记忆写入路径在落盘前把凭据形态替换成 `[REDACTED:kind]`；个人标识符只告警不改写（事实不得被静默篡改） |
| **Hindsight 的 temporal recall** | `memory_search` 的 `after`/`before` 按日期区间过滤，命中带归属日期 |
| **Hindsight 的 observations** | 原则是"带证据的信念"：信任级由认可/纠正计数**自动算出**，不靠自述 |
| **MemOS 的前台预算与被动捕获** | `recallTimeoutMs` 绝对超时静默放行；`captureUserTurns` 默认关闭 |
| **自组织分层的思路** | 使用信号（触及/曝光/纠正/认可）聚合出分层建议，**只建议不擅动** |
| **"信号在谁身上生成"** | 自产信号不给自己背书：先问"没人检查时这读数会不同吗" |

---

## 这套系统的四条自我约束

**1. 判据必须能被证伪。** 每条判据都要能回答："把这条判据删掉，测试会不会红？"
只警告不阻止 = 没有闸门。所以每条判据的**拒绝路径**都有测试。

**2. 自产信号不能给自己背书。** 来自回路自身的绿灯（计数正常、探针报 ok、
测试全绿）先问一句：**若这条回路根本没人检查，这个读数会不同吗？**
不会不同，它就还没被当作证据用过。信息只存在于这条回路伪造不了的那一面：
外部退出码、被放过的样本、改坏了会红的变异。

> 这条不是从别处借来的道理，是这套系统自己的亲身经历：
> 调度命中率曾只有 20%，而探针报的是 `mind.no-signal` ——
> 看着像"本轮无信号是正常状态"，其实高频的 no-signal 不是正常，是失灵。
> 于是补了命中率读数，让"失灵"变成看得见的东西。

**3. 写进文档的约束等于没有约束。** 判据是函数、写入前拒绝、落盘后回读、
模型侧说明同步 —— 四件事缺一不可。

**4. 文档里的数字同样会过期。** README 里每个数字都由 `scripts/verify-readme.mjs`
从源码数出来与文档比对，对不上就非零退出。变异反证：工具数改错 / 删工具条目 /
门槛值改错 / 判据数改错 / 测试数改错 / 信号数改错 —— **6 处全部变红**。

---

## 判据落点

| 层 | 实现 |
|---|---|
| memory | `src/layer-gate.js`（写入前准入）+ `src/layer-selfcheck.js`（落盘后回读）+ `src/dao-shape.js`（道体结构与哲学形态） |
| agent-mind | `src/dispatch.js`（判定）+ `src/hitrate.js`（命中率）+ `test/hitrate.test.js`（泛化门） |
| clis | `src/intervene.ts`（只读放行）+ `src/intervene-metrics.ts`（漏判分母）+ `src/probe-registry.ts`（探针发现） |
| meta-framework | `src/health.js`（探针只读实测） |

---

## 开发

```bash
npm install
npm test
```

### 测试规模（实测计数）

| 包 | 测试文件 | 用例/断言 |
|---|---|---|
| `dsh-agent-mind` | 6 | 52 |
| `dsh-memory-manager` | 4 | 131 |
| `dsh-clis`（源仓库） | 41 | 617 |

### 关键命令

```bash
# README 数字校验（工具数/判据数/门槛值/测试规模/代码行数）
node scripts/verify-readme.mjs

# 调度层测试
node --test "packages/dsh-agent-mind/test/*.test.js"

# 真实 cordis 装配验证（真宿主里跑一遍）
node packages/dsh-agent-mind/scripts/verify-assembly.mjs

# 聚合包发布前检查（装载点/依赖声明/唯一入口形态/版本区间）
node packages/dsh-mind-system/scripts/publish-check.mjs
```

### 代码规模（实测）

| 包 | 规模 |
|---|---|
| `dsh-agent-mind` | 13 文件 / 2551 行 |
| `dsh-clis` | 源仓库 45 个 .ts / 9458 行 |
| `dsh-meta-framework` | 4 文件 / 932 行 |
| `dsh-memory-manager` | 4 文件 / 5747 行 |

### 发布形态

monorepo 只是源码在一起，**npm 上是五个独立包**：

```
packages/dsh-agent-mind       → npm: dsh-agent-mind
packages/dsh-clis             → npm: dsh-clis
packages/dsh-meta-framework   → npm: dsh-meta-framework
packages/dsh-memory-manager   → npm: dsh-memory-manager
packages/dsh-mind-system      → npm: dsh-mind-system（聚合包）
```

### 更新插件时的生效方式（实测）

| 改了什么 | 生效方式 |
|---|---|
| 提示分节、编排逻辑 | 改 `cordis.patch.yml` 触发 profile 重组即可 |
| `index.js` / `src/` 里的模块 | 需在 HMR `root` 列表内，否则**改了不生效且无报错** |
| `server.js`（memory-manager 的工具与路由） | 需重启宿主（模块生成缓存以 realpath 为键） |

---

## 许可

MIT
