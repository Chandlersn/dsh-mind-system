# DR-17 / DR-18 结果报告

日期：2026-11-18。对应计划[阶段5](DUAL-LOOP-INTEGRATION-PLAN.md)（DL-5.1 / DL-5.2）。
脚本：`packages/dsh-execution-runtime/scripts/verify-dr17-labelled.mjs`、`verify-dr18-arms.mjs`（均可独立运行，退出码即判定）。

三分类记录（计划要求「缺哪类写哪类」）：
- **隔离反例**：本报告主体属于这一类。
- **真宿主**：DR-17 另在活动宿主上做过一次六个成员在册的核对，见「活动宿主」一节。
- **真实任务**：**没有**。运行时数据库 `runs` 表至今 0 条记录，本报告不含真实任务分布。

---

## DR-17：指标能否识别漏检与误报

### 结论

| 臂 | 漏检率 | 误报率 | 说明 |
| :--- | ---: | ---: | :--- |
| 检测器原样（旧词表） | **91.7%**（11/12） | **28.6%**（4/14） | 真实失败措辞下 |
| 关闭检测器（永不发言） | 100%（12/12） | 0%（0/14） | 漏检恶化 ✅ |
| 全拦截（永远发言） | 0%（0/12） | 100%（14/14） | 误报恶化 ✅ |

**两条消融都按要求方向移动了指标 → DR-17 的「指标能识别漏检与误报」通过。**

初次测量暴露了检测器本身的问题（11/12 漏检），**已在本轮修复，见下方「检测器修复」**。修复后同一判据重测：**漏检 0%（0/12）、误报 28.6% 不变**，两条消融依然有效。

### 检测器修复（2026-11-18）

**根因**：`RELEVANT_WORDS` 装的是运行时自己的错误码（`budget_exceeded`/`half_`/`reconciling`），而调用方写的是事情经过（"the write landed on disk but no ledger row was recorded for it"）。词表在向运行时描述它自己，而不是在识别调用方的处境。

**用真实数据定量**（`scripts/diagnose-detector-vocab.mjs`，2021 条 `clis-interventions.jsonl` 记录）：旧词表只覆盖 **3.0%** 的真实失败，最常发生的 `pwsh` 失败（1342 条）只覆盖 1.5%。

**修法与双向验证**（`scripts/tune-detector-vocab.mjs`）：

| | 旧词表 | 新词表 |
| :--- | ---: | ---: |
| 用例集漏检 | 91.7% | **0%** |
| 用例集误报 | 28.6% | **28.6%**（未变） |
| 真实失败被判定为候选 | 3.0% | 3.5% |

误报不升、真实噪声几乎不动，说明新词是**补形状**而不是放宽门槛。词表只补了两类：调用方措辞（"does not match"、"no ledger row"、"no longer matches"、"did not settle"）与可恢复形状（"died with"、"same fence"、"no further executor"）。

**已知边界（未修）**：文本匹配无法区分 `timeout waiting for the language server`（配置问题）与 `killed after the deadline`（可恢复步骤）。那 4 个误报是文本判据的固有代价，留在报告里可见，没有用更多词去糊。

**防回退**：新增两条测试——一条钉住"调用方措辞必须被识别"，一条钉住"普通错误必须继续被忽略"。前者做过变异验证：把词表退回旧版后它立刻变红。

### 为什么漏这么多

`src/intervention.js` 的 `RELEVANT_WORDS` 是一组**内部术语**：`budget_exceeded`、`deadline`、`timeout`、`verification`、`rollback`、`reconciling`、`half_`、`partial`…… 而真实工具失败消息说的是：

> `the produced artifact does not match what the task declared`
> `the write landed on disk but no ledger row was recorded for it`
> `the process died with 3 of 7 files written`

两套词几乎不重合。**检测器在被设计时是拿内部错误码想问题的，而不是拿真实失败文本。**（已修，见上「检测器修复」。）

反过来，它还会误报：`timeout waiting for the language server`、`verification step skipped: no linter configured` 这类**含魔法词但不可修复**的失败被当成候选。**这一类未修**——文本匹配区分不了，属固有边界。

### 标签独立性怎么保证的

计划明令：「没有独立标签时漏检/误报报 unavailable，不用 skipped/evaluated 冒充分类准确率」。为此排除了三种来源：

| 候选标签源 | 为何不可用 |
| :--- | :--- |
| CLIS 账本 `adopted`（44 条/2056） | 判据是「同一 agent 30 分钟内调过 clis 工具」——同一回路自产 |
| 各闸门记录的 `reason` | 是闸门在解释自己的决定 |
| `skipped/evaluated` | 计划点名禁止 |

实际采用的是**按用例独立标注**：`needsHelp` 判断「这一步失败是否属于运行时能帮的形状」，由任务形态决定，与检测器无关。

### 一个必须先说的错误

第一版脚本报 **0% 漏检 / 0% 误报**。原因是我的用例集：每条 `needsHelp: true` 都被我写成**包含**检测器关键词，每条 `needsHelp: false` 都**避开**它们。那测的是我的构造，不是检测器。

重写后用例文本取真实失败措辞，且**写用例时不看 `RELEVANT_WORDS`**。**判据把答案写进输入，是本轮最贵的教训——它让一次全绿的运行毫无信息量。**

---

## DR-18：性能收益是否有对照

### 结论：**不能声称有收益**，而且这一组数字本身不支持「规则更快」

| 规模 | 臂 | n | P50 (ms) | P95 (ms) | 成功率 | 工具调用 | 模型调用 |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | rule | 7 | 2.24 | 3.82 | 100% | 2 | 0 |
| 50 | model | 7 | 0.49 | 0.66 | 100% | 3 | 1 |
| 200 | rule | 7 | 8.29 | 15.49 | 100% | 2 | 0 |
| 200 | model | 7 | 0.66 | 1.31 | 100% | 3 | 1 |
| 800 | rule | 7 | 11.55 | 19.90 | 100% | 2 | 0 |
| 800 | model | 7 | 1.20 | 1.89 | 100% | 3 | 1 |

规则组 P50 是模型组的 **3–17 倍慢**。规则组的代价是固定的（`prepareJsonTask` 要算 digest、验 scope、rehash 输入），模型组这个「基线」其实是一个本地函数直接算，不含任何模型往返。**所以这张表只说明「规则路径有多少固定开销」，不能说明「真实 agent 更慢」——那只会有更大的模型延迟。**

### 第三臂为什么没有数

计划要三组：既有模型循环 / 纯规则模板 / 规则+Jev+异常分析。

**第三组不可运行**：`docs/runtime-jev-evidence.md` 记 DL-0.2 为「外部依赖未验证」——专用端点、模型、凭据环境均缺失，真实请求数为 0。按计划规矩，缺哪类写哪类，**不借别类的结论**。

### 真实任务这一类：仍未取得，原因已查明

`runs` 表此前 0 条，本轮实跑后有了 **4 条真实记录**（不是编的，状态见下）：

| taskId | 状态 | 原因 |
| :--- | :--- | :--- |
| dr18-real-sample-004/005 | waiting_analysis | `ENOENT`（输入文件不在宿主 cwd） |
| dr18-real-sample-006/007 | failed | `admission_denied` |

**根因**：`runtime_execute` 生成的 candidate 声明的工具是 `runtime.write_json`，而**宿主从未把它注册成工具**——准入第 5 关 `tool_not_visible` 因此必然拒绝。这个工具名在 recipe 里是**契约占位符**，真正执行需要调用方提供映射。

也就是说：**在没有注册执行工具的宿主里，`runtime_execute` 只能产出失败记录，产不出成功样本。** 这不是缺陷，是装配缺失；DR-18 所需的「成功后按验收器计成功」的真实分布，必须先补上工具映射才有意义。

另有一条已核实的路径限制：`runtime_run` 只接受**原生注册的模板**，而当前 `tasks: []` 为空，所以那条路也不通。

### 成本维度

| 维度 | 值 |
| :--- | :--- |
| 墙钟时间 | 已测（上表） |
| 工具调用 | 已测 |
| 模型调用 | 已测；规则组 0 次是**设计事实**，不是测量结果 |
| 模型 token | **unknown**——本脚本无法观测 token 计数器，不填 0 |
| Jev 调用 | **unavailable**（DL-0.2） |

### 任务集的边界（重要）

原设计是「去重 + 排序 + trim」，跑起来 recipe 每个输入都失败。查 `recordsFrom` 后发现契约更窄：

- 记录**只能有 `id` 和 `name`** 两个键
- `id` 必须**已经唯一**
- `name` 非空

也就是说**去重不在这个 recipe 的能力内**，它碰到重复 id 是 fail-closed 而不是去重。改成两侧真能做的「trim + 按 id 排序」后才有数。

**这是本轮第二个教训：先读被调用方的契约，再设计任务集。** 我最初的任务集测的是一个 recipe 明确不承诺的能力。

---

## 活动宿主（真宿主这一类）

`clis_probe` 在活动宿主（PID 7860）上报告 `domain_probes` 含 `execution-runtime` 与 `mind-system`，无 `mind-system.member-missing`。原有五成员逐个真实调用均返回有效数据。详见 2026-11-18 每日记录「DR-13 第二子项」一节。

## 与阶段门的关系

- DR-17 条目**通过**（指标能识别，两条消融都可见）。检测器初测**漏检 91.7%**，**本轮已修复至 0%**（误报 28.6% 未变，属文本判据固有边界）。
- DR-18 **未通过**：只有两臂，第三臂被 DL-0.2 阻塞；现有两臂数据**不支持收益声明**；且宿主未注册 `runtime.write_json`，真实成功样本无法产生。
- DL-5.3（文档、隔离部署与回退演练）未做。

## 下一步（按优先级）

1. **补宿主工具映射**：让 recipe 声明的 `runtime.write_json` / `runtime.write_text` 真正可被 `ctx.tools` 解析，否则真实成功样本永远为 0，DR-18 无法推进。
2. DR-18 第三臂等 DL-0.2（Jev 凭据与端点）。
3. 检测器剩余 28.6% 误报（`timeout waiting for the language server` 一类）可考虑改用结构化字段判据而非文本匹配，但那属于设计变更，不在本轮范围。
