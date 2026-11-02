# dsh-meta-framework

DSH 插件：把 [`@causal-layers/meta-framework`](https://www.npmjs.com/package/@causal-layers/meta-framework) 暴露为 agent 工具 **`meta_reframe`**。

**把一个问题重新审视一遍**：给出重定义、适用范围（边界）、因果结构判断、候选方向。

---

## ⚠️ 先读这一段：这是诊断工具，不是决策工具

真实任务实测（5 个本会话真实问题）的结论：

| 它擅长的 | 它做不到的 |
| --- | --- |
| 判断"这是什么结构"（环 / 对偶 / 嵌套 / 单向） | 给出**具体可执行**的处理步骤 |
| 打破你的单一视角（判出你没想到的结构） | 在没有真实执行器时把流程跑到底 |
| 强制重新审视定义与边界 | 在非因果任务上提供增量（会空转） |

实测数据：**因果类型 3/3 判对**（`cyclic` / `structural_duality` / `nested`），
但走完整四层的 3 个任务**全部卡在 `human_gate`** —— 因为框架内置的
`createPlaceholderExecutor` 不产生真实变化，反馈服务检测不到收敛就持续
要求回退，3 轮后转人工。

**本插件因此只暴露"重新审视"这一个动作，不走 `run()`、不进 `observe` 回退循环。**
路径建议会给出，但**仅作参考**——它擅长告诉你"这是什么结构"，不擅长告诉你"该怎么办"。

这条边界在工具描述里也写着，agent 调用时能看到。

---

## 相对上游：用了什么、没用什么、缺了什么

上游 `@causal-layers/meta-framework` 导出 **46 个符号**，本插件只用了其中一小部分。
差别不是疏漏，是**分清"诊断"与"决策"**后的取舍 —— 但有一处是真缺口。

| 上游能力 | 本插件 | 为什么 |
|---|---|---|
| `createClisSession` | ✅ 用 | 从宿主上下文探测三个 CLIS 服务 |
| `redefine` / `customize` / `select` | ✅ 用 | 分步调用，拿到结构判断就停 |
| `writeTrace` | ✅ 用（自己拼） | **补上游的坑**：见下 |
| `run` / `runWithTrace` | ❌ 不用 | 会走完整四层 → 因果任务上必定撞回退上限转人工 |
| `GateController` / `approveByHuman` / `governingGate` | ❌ 不用 | 闸门语义就是"转人工"；插件改走诊断路径，不需要闸门 |
| `assertRunGateNotAutoApproved` | ❌ 不用 | 只在 `run()` 返回前断言；插件路径不经 `run()` |
| **`META_FRAMEWORK_SERVICE` / `apply`** | ❌ **未注册** | **真缺口**，见下 |

### 补上游的坑：trace 必须自己写

分步调用绕过了 `run()`，而 `writeTrace()` **只在 `run()` 里被调用** ——
于是工具路径上原本**一条 trace 都不落**（实测：连调三次后全盘搜不到任何
`meta-*.json`）。这等于"每次运行都可回放"这个承诺在工具路径上失效。

所以本插件自己拼一条 trace 并落盘，字段按 `MetaTrace` 契约填满 10 个：
没走 observe，故 `execution` / `change` 为 null、`rollback_count` 为 0 ——
**如实反映"这次只做了诊断，没有执行"**，而不是编造执行结果。

### 真缺口：上游服务没注册

上游提供 `apply(ctx)`，会把服务按 `'causalLayers.metaFramework'` 注册到宿主，
别的插件可以 `ctx.get()` 取它。本插件**没有调用 `apply`**，
所以宿主里**不存在这个服务** —— 别的插件拿不到 meta 的能力。

这不是设计取舍，是**漏了**。要补的话是三行：`apply(ctx)` + 注册 disposer +
在 `inject` 里声明所需服务。**但要先确认有人消费** —— 没人用的话，
注册一个服务只是多一份待维护的面。

上游自己也没有把 `META_FRAMEWORK_SERVICE` 放进 `apply` 的默认路径之外，
所以现在**纯 meta 模式零配置可用**（不装 CLIS 也能跑通四层）。

### 什么时候该重新评估

上游的 D11 决策（2026-11-01，实测）写明三个触发条件，任一成立就该重新决定
"给 `PathExecutor` 补实现规格 + 可用示例"还是"把定位正式收窄为诊断工具"：

1. 出现第二个真实使用者，且也卡在 `human_gate`（说明不是个例）；
2. 有人实现了真实执行器（届时路径质量是否提升可重新测）；
3. 需要把路径建议从"模板"升级为"领域相关"（那需要知识注入，是另一项工程）。

**目前三个条件都没成立** —— 所以现状是对的。

---

## 用法

装上即用，无需配置。agent 会看到一个工具：

### `meta_reframe`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `description` | 是 | 一句话说清**问题本身**（不是"下一步做什么"） |
| `context` | 否 | 已试过什么、观察到什么、有哪些约束 |
| `q1`–`q4` | 否 | 四问作答，`yes`/`no`/`unknown`。**四项全给**才做因果判断 |

四问：

- **q1**：A 与 B 是否同时成立、彼此定义、且无时间先后？（对偶）
- **q2**：是否存在带时间延迟的相互影响（A→B→A，可能振荡）？（环）
- **q3**：是否 A→B 严格先后且不可逆？（单向）
- **q4**：系统中是否同时存在多种因果结构？（嵌套）

**为什么四问要全给**：契约规定 `classify` 的判据只由作答决定，缺一项就不判
（不会拿半份作答去猜）。给不全时代理会如实说明"因果结构未经判断"。

### 什么时候该用

- 改了参数/策略但没效果，或反复调整反而更糟
- 指标来回震荡，压下去又弹回来
- 两个因素互相影响，分不清谁是因谁是果
- 想知道"这个措施为什么无效"，而不是"下一步做什么"

### 什么时候不该用

- 一次性的、明确的信息整理任务（会空转，只是把问题描述抄进模板）
- 已有明确执行方案，只差动手
- 指望它替你决定下一步做什么

---

## 输出

```jsonc
{
  "problem_id": "meta-2026-11-01T12-24-37-963Z",  // 可追溯，也是 trace 文件名
  "reframed": null,                                // 重定义后的问题；null 表示维持原定义
  "original_definition": "为什么 npm publish 连续失败三次…",
  "boundary_declaration": "按原描述的适用范围处理，未做收窄",
  "redefine_reason": "…已参考因果类型判断（cyclic）",
  "causal_type": "cyclic",        // CLIS 判出的类型；未判出为 null
  "answered": true,               // 四问是否给全
  "clis_available": true,         // CLIS 分类服务是否可用
  "clis_used": true,              // 本次是否真拿到了因果判断
  "success_criteria": ["…"],
  "forbidden_actions": ["把 CLIS 的因果判断结果当成本层自己的结论输出"],
  "candidates": [                 // 仅参考，不是可执行方案
    { "path_id": "p1", "description": "…", "source": "clis", "score": 0.88, "rank": 1 }
  ],
  "trace": { "written": true, "path": "…/meta-…json" },
  "note": "因果结构判为「cyclic」。候选路径仅作参考——…请据此自行决策。"
}
```

### 三种"没判出类型"要分清

这三者对使用者的含义完全不同，输出里用 `answered` / `answers_submitted` / `clis_available` / `note` 区分：

| 情形 | `answered` | `answers_submitted` | `clis_available` | `causal_type` | 含义 |
| --- | --- | --- | --- | --- | --- |
| 一项没给 | false | 0 | — | null | 补全 q1–q4 可得到判断 |
| **给了一部分** | false | 1–3 | — | null | `answers_missing` 点名缺哪几项；已给的作答被忽略 |
| 给了但 CLIS 不可用 | true | 4 | false | null | 装 dsh-clis 才能判 |
| 分类器故障 | true | 4 | true | null | **没拿到结论**，不代表不属于已知结构 |
| 给了、可用、判为 unknown | true | 4 | true | null | 这问题不属于已知四种结构 |

后两种的 `causal_type` 都是 null，只能靠 `clis_used`（true/false）与 `note` 区分 ——
把"分类器崩了"说成"这问题不属于已知结构"，会让人放弃一个本来能判出来的问题。

## trace

**每次调用都会写一条 trace**（因为分步调用绕过了 `run()`，而 `writeTrace()`
只在 `run()` 里被调 —— 不补的话工具路径上一条记录都没有）。

- 落盘位置：`META_FRAMEWORK_TRACE_DIR` 环境变量；缺省 `<cwd>/data/meta-traces`
- 字段按 `MetaTrace` 契约 10 个：`problem_id` / `definition` / `boundary` /
  `selected_path` / `execution` / `change` / `clis_used` / `gate` /
  `rollback_count` / `ts`
- **不撒谎**：没走 `observe`，故 `execution` / `change` 为 `null`、`rollback_count` 为 `0`
- 落盘失败也如实报告（`trace.written: false` + `error`），**不拖垮诊断结果**

## 健康探针

导出 `healthProbe`（供 dsh-clis 的监督层自动发现）。**探针只读 `apply()` 的实测结果，
不自己推断** —— 上一版用文件存在性猜"工具会不会注册"，实测两头都能错。

| 代号 | 严重度 | 含义 |
| --- | --- | --- |
| `meta-framework.not-loaded` | error | 没跑到 `apply()`（inject 未满足 / 模块加载失败） |
| `meta-framework.host-root-missing` | error | `apply()` 跑过，但定位不到 DSH 安装目录 |
| `meta-framework.tools-unavailable` | error | 装根在，但 `@deepseek-ai/dsh-tools` 加载抛错 |
| `meta-framework.classifier-missing` | info | 无 CLIS 分类服务 → 判不出因果类型 |
| `meta-framework.ok` | info | 一切正常 |

探针只读、不抛错。CLIS 缺失标 `info` 而非 `error`——它是可选增强，
把它报成错误会让监督层天天亮红灯，最后没人再看它。

## 依赖

- `@causal-layers/meta-framework` —— 真正的库（本插件依赖它）
- `@deepseek-ai/{cordis,dsh-tools}` —— 宿主包，**peer + optional**，
  运行时从 DSH 安装目录 `require`（见 `src/host.js`），绝不进 dependencies
  （内联会造出第二份实现，导致 `instanceof` 为假且不报错）
- CLIS 三个服务由 `dsh-clis` 插件提供，本插件用 `ctx.get()` 运行时探测，
  **不在 inject 里**

## 开发

```bash
npm install
npm test          # 三个文件：tools / health / entry，41 个用例
```

`test/entry.test.js` 专门守入口：工具真的注册了、`inject` 含 `tools`、
加载失败时降级而不抛错、探针与注册结果同步。此前入口零覆盖，
而插件唯一一次"完全不装载"的事故就发生在那里。

装进宿主（link 模式）：

```bash
dsh plugin --profile web add "link:<本目录>"
```

改完要重启宿主才生效（服务端插件）。`cordis.patch.yml` 的 `id` 必须与
`index.js` 的 `export const name` 一致。

## 排错

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 工具一个都调不到 | 插件没装载 | 看宿主启动日志的 "did not activate"；`inject` 必须含 `tools` |
| `meta_reframe` 报因果类型是"没判出" | 四问没给或没给全 | 三种"没判出"要分清：**非因果问题**（正确）、**四问不全**（补齐）、**问题描述太笼统**（具体化） |
| 输出里没有因果成分 | 宿主没装 CLIS，或 CLIS 服务没就位 | `clis_used=false` 是正常的降级；纯 meta 模式四层照样跑完 |
| trace 找不到 | 落盘目录不是预期的 | 默认 `data/meta-traces/`，可用 `META_FRAMEWORK_TRACE_DIR` 改位置 |
| 分类结果看着像"抄进模板" | 非因果任务上的已知空转 | 这是实测记录的局限（见上方 D11 表），不是 bug |
| 改了源码不生效 | 跑的是旧产物 / 模块缓存 | 服务端插件要重启宿主 |

## 已知限制

见仓库根的 `REVIEW.md`。要点：

- 因果任务不走完整四层（刻意：会卡 human_gate）
- **上游服务未注册**（`'causalLayers.metaFramework'`）—— 别的插件取不到 meta 的能力，
  是一处已知缺口而非设计取舍，见「相对上游」章
- `causal_answers` 是契约外的扩展字段（D7 的延续），类型层不设防
- 无 `icon` / `locale`，面板走默认图标与裸名回退
