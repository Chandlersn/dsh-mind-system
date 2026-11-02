# dsh-mind-system

**DeepSeek Harness 心智系统** —— 一次装齐四个插件，让 agent 知道"遇到什么问题先问什么"。

不是四个工具的清单，是一条链：

```
用户的问题
   ↓
① mind      判断顺序常驻提示 + 按处境把该看的工具推到眼前
   ↓        （"什么时候用谁"被显式化，不再靠 agent 自己从平铺的工具表里猜）
② clis      判因果结构：环 / 对偶 / 单向 / 嵌套
   ↓        （反复无效时，给尺子而不是给更多方案）
③ meta      重新审视问题本身：重定义 → 边界 → 选择 → 观测
   ↓        （"真问题可能不是字面问题"）
④ memory    沉淀：五层判据守写入，判据反哺上一轮
   ↓        （器 → 术 → 法 → 道，每层有边界有反面）
```

## 安装

聚合包**装载四个成员**，是它们唯一的装载入口。

```bash
dsh plugin --profile web add dsh-mind-system
```

装完**重启宿主**（server 半边需要重新装载）。

### ⚠️ 别再单独装其中一家

聚合包已经装载了四家。再单独装某家，那家会被**装载两次**：同一 id 的装载点
由后者覆盖，仍能工作，但行为取决于装载顺序（实测：聚合包自己会被挤掉）。

只想要其中一家的能力时，从聚合包的 `bundles` 里移除其余即可 ——
或者直接单独装那一家（此时不要装聚合包）。

### 也可以分别安装

若你不想用聚合包，四家各自独立可用（各自有各自的 bundle patch）：

```bash
dsh plugin --profile web add dsh-agent-mind
dsh plugin --profile web add dsh-clis
dsh plugin --profile web add dsh-meta-framework
dsh plugin --profile web add dsh-memory-manager
```

此时**不要**再装聚合包（会双装载）。

### 少装会怎样

不是报错，是**降级**——这一部分能力不在，其余照常：

| 少装 | 后果 |
|---|---|
| `dsh-clis` | 判不了环/对偶/单向；meta 退化为通用重定义；系统监督消失 |
| `dsh-meta-framework` | 失去"重新审视问题"这一手 |
| `dsh-memory-manager` | 记忆写入无判据把关，蒸馏退回"写进去就算" |
| `dsh-agent-mind` | 工具平铺在提示里，agent 得自己从描述里分辨该用谁 |

## 四家各做什么

### dsh-agent-mind —— 调度层

往系统提示注入一段常驻的**判断顺序**（不是工具清单），并按当前处境**重排**工具面。

- 只重排、绝不删除：工具只有出现在声明里模型才知道它叫什么，藏掉它连问的机会都没有
- core 工具（文件/shell/搜索等）永不移动、永不延后载入
- 判断可解释：`mind_signals` 工具能回答"为什么这一轮排了这个顺序"
- 命中率可测：内置命中率回归 + 真实使用采样（趋势）

### dsh-clis —— 判因果结构

四组件（classifier / strategy / feedback / orchestrator）+ 五工具。

- `clis_classify` 只判结构，`clis_run` 给匹配做法，`clis_plan` 只列做法与代价
- 介入机制带**漏判分母**：每次"放过"都记原因与闸门，`miss_rate` 可查
- 系统监督：只投递被监督者自己产不出的结论

### dsh-meta-framework —— 重新审视问题

一个工具 `meta_reframe`，四层流程：重定义 → 边界 → 选择 → 观测。

- 描述问题而非判定问题：给重定义、边界与因果结构判断，不替你决定下一步
- 每次调用写 trace 可回放；退出码、失败记录都如实报告

### dsh-memory-manager —— 五层记忆

十四工具，五层结构：**器**（接触面）→ **术**（域内迭代史）→ **法**（跨域原则）→ **道**（最抽象命题）+ 技能（可调用程序）。

- 每层有**硬判据**：法要 ≥2 个无关来源域，道要 ≥5 条法萃取
- 每层有**边界**：说不出"何时不成立"即不合格
- 写入**前**拒绝 + 写入**后**回读复核，回执带 `selfCheck`

## 依赖

- `@deepseek-ai/cordis` ~4.0.5（宿主提供，optional peer）
- Node ≥ 22

## 验证

```bash
node scripts/publish-check.mjs
```

验三件事：装载点能被宿主解析、依赖声明完整、四家在 profile 里都装了。

## 许可

MIT
