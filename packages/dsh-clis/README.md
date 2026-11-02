# dsh-clis

一个 DSH 常驻插件，做两件事：

- **碰到反馈时介入** —— agent 的工具失败开始重复时，在结果进入模型前注入
  一条结构判断提示（回路越修越弹 / 对偶一边修一边被拉回 / 单向该追溯最早的因）。
  四道闸门防干扰，`clis_metrics` 报告"提示注入 vs 被采纳"的采用率。
- **全系统插件互相看得见** —— 枚举宿主全部插件、收集健康探针，把散乱警告
  归并成结构结论。自动层零配合覆盖全部非内建插件；插件导出一个 `healthProbe`
  即可接入更深信号。

底层是四个可独立开关的因果组件（分类 → 策略 → 反馈 → 编排）。
分类是确定性规则打分（需先填四问），不是语义理解；归因与策略主张
无对照实验支撑——测试证明工程严谨，不是"比直接处理更有效"。

## 一、agent 工具

| 工具 | 作用 |
| --- | --- |
| `clis_probe` | **系统级监督**：枚举宿主全部插件，收集各自的健康探针，用因果结构分析判断"这些散乱问题之间是什么关系"，只投递对方自查报不出来的结论 |
| `clis_run` | 跑完整闭环：分类 → 匹配路径 → 执行 → 反馈 → 必要时回退 |
| `clis_classify` | 只判断因果类型 |
| `clis_plan` | 只生成并排序候选路径 |
| `clis_metrics` | **介入有效性**：提示注入了多少次（hinted）、agent 采纳了多少次（adopted）、采用率 |

另注入一段系统提示段（`clis-causal-reasoning`），列出该找 CLIS 的症状
（改了参数没效果、反复调整更糟、指标来回震荡、分不清谁因谁果）。

### clis_probe 的两层监督

| 层 | 来源 | 覆盖 | 插件要做什么 |
| --- | --- | --- | --- |
| **自动层** | loader 元数据（模块导入 / 导出形态 / 装载状态 / 依赖满足） | 全部非内建插件 | **什么都不用做** |
| **协作层** | 插件模块根导出 `healthProbe` | 导出者 | 加一个导出 |

自动层是"新装插件不会被遗漏"的保证。协作层决定监督的**深度**，不决定**有无** ——
缺了它，插件的领域内部问题看不到，但装载/依赖类问题照样能发现。

要接入协作层，按 [`PLUGIN-STANDARD.md`](https://github.com/#) 的约定加一个具名导出：

```js
export const healthProbe = {           // 与 inject / Config 同族
  async probe() {
    return { plugin: 'my-plugin', status: 'ok', findings: [] }
  },
}
```

**投递纪律**：只发结构诊断（`structure.*`）与跨轮复发（`structure.recurring`）。
对方自查出的逐条问题**不转发** —— 那些在各自插件的面板里已有，重复搬运只是噪音。

## 二、四个组件

| 组件 | 服务名 | 职责 | 禁止 |
| --- | --- | --- | --- |
| **因果分类器** `classifier` | `clis.causalClassifier` | 只判断因果类型 | 不生成策略、不执行、不回退 |
| **策略匹配器** `strategy` | `clis.causalStrategy` | 匹配策略、生成候选路径、排序执行 | 不重新判断类型、不决定回退 |
| **反馈检测器** `feedback` | `clis.causalFeedback` | 检测反馈信号、识别误判、给回退建议 | 不重新分类、不执行回退 |
| **闭环编排器** `orchestrator` | `clis.causalOrchestrator` | 编排三者、执行回退决策 | 不写任何判断/匹配/反馈规则 |

依赖关系（由 inject 声明，Cordis 自动等待）：

```
classifier ──┬──> strategy
feedback ────┴──> orchestrator
```

因此停用 `classifier` 会连带停用 `strategy` 与 `orchestrator`；`feedback` 独立无依赖。
包根入口 `clis-tools` 依赖前三个服务，故须排在它们之后装载。

## 三、因果类型与策略族

| 类型 | 判断依据 | 策略族 |
| --- | --- | --- |
| `structural_duality` 结构对偶 | 同时成立、彼此定义、无先后 | 对称映射 / 关系调参 / 定义澄清 |
| `cyclic` 循环因果 | A→B→A 且有时间延迟 | 杠杆点 / 增益控制 / 延迟调节 / 阻尼注入 |
| `unidirectional` 单向因果 | A→B 严格先后不可逆 | 上游追溯 / 必要条件 / 不可逆接受 / 新因覆盖 |
| `nested` 嵌套 | 多种结构并存 | 拆子模块递归 |
| `unknown` 未知 | 四问无法判断 | 最小/广度探测（探索模式） |

## 四、必须知道的边界（读之前请先看这一节）

1. **分类器是确定性规则打分，不解析自然语言。**
   需要调用方先填好四问（Q1–Q4 各 yes/no），它按规则打分判类型。
   它不是"把一段中文描述扔进去就出结论"的语义理解器。

2. **执行器是半自动的。**
   只读动作（测量/追溯/枚举/定位）放行并返回观测请求；**写动作默认全部拦下**，
   除非调用方在 `allow_writes` 里显式放行。这是刻意设计——CLIS 不知道你的系统能改什么。

3. **只读模式不会空转。**
   若一条路径的步骤全是只读，它不会判"成功"（那不是进展），而是直接返回
   "需授权才能推进"，不做无意义的换路径重试。

4. **因果推理层的有效性尚无对照实验支撑。**
   四个组件有 600+ 例测试与 7 条硬约束验证，但那证明的是**工程严谨**，不是
   "比直接处理更有效"。监督层（`clis_probe`）则是在真实使用中被逼出来的，有可复现实证。

5. **强宿主耦合。** 只对 DSH 用户有用，不能独立运行。

## 五、硬约束

- **置信度上限 0.9**；低于 0.7 标记探索模式；`unknown` 给候选假设不强行归类。
- **回退上限 3 次**；超过输出「需人工介入」并保留完整 trace。
- **震荡锁定**：同一类型连续回退 2 次，锁定该类型至少 1 轮。
- **边界强制**：`forbidden_actions` 内的动作在生成阶段被剔除，执行阶段再挡一次。
- **生成与判断分离**：分类器不评价策略，策略不重新分类，反馈不自动回退。
- **回路判据只认跨轮**：同一规则在一轮内触发多次（两条车道各一次）**不算**回路；
  只有"上一轮报过、这一轮还在"才算，输出 `structure.recurring`。

## 六、手动开关

Settings → Plugins 或 Plugin Manager 里，四个组件与包根入口可**各自**启用/停用。

```js
plugin_manager({ action: 'set_plugin', target: 'clis-classifier', enabled: false })
```

停用 `clis-classifier` 会连带 `strategy` / `orchestrator` / `clis-tools` 停用（inject 依赖）。

## 七、构建与打包

- 版本：0.3.0
- 打包：esbuild 代码分割，5 个入口（根 + 四组件）共享 chunk
- **`@deepseek-ai/cordis` 走宿主 shim，不内联。**
  构建时 `alias` 到 `cordis-shim.ts`，运行时用 `createRequire` 从探测到的 DSH 安装目录
  加载宿主自己的 cordis。**为什么必须这样**：内联会让本插件声明的是第二个 `Service` 类，
  服务虽注册进 ctx（走 `ctx.reflect.provide`）但宿主不认，`instanceof 宿主Service === false`，
  依赖它的插件 `inject` 永不满足 —— **而且整个过程不抛任何错误**。
- 可安装产物由 `scripts/package.mjs` 从两处组装：`bundle/`（JS）＋ `packaging/`（patch、
  package.json、icon、README、locale）。**克隆仓库即可重建**，不依赖任何目录外文件。

## 八、已知限制

- **orchestrator 无独立验收**：全部由实现者自测。classifier / strategy / feedback 有独立
  验收套件（详见 `reports/`），但 orchestrator 的断言由实现者本人设计，存在
  "按自己的实现写断言"的可能。
- 未测性能与并发。
- 自动层只有 5 项检查（模块导入 / 导出形态 / 卡装载 / 意外未激活 / 依赖未满足）。
  可扩展方向：声明的工具或路由是否真注册成功。
- 协作层目前只有 CLIS 自己、`dsh-memory-manager`、`dsh-workbuddy-channels`、
  `dsh-learning-mode` 四个插件导出探针。