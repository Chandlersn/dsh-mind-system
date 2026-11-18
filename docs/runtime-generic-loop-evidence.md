# 通用闭环：任意任务在运行时描述并执行

目标：任务不再需要预先注册模板，**任意任务可随时描述、传入、执行**；同时验收标准不能被任务自己发明。

## 1. 先承认我上一轮把架构说窄了

我曾说"目标必须固定"，指的是**单次运行内**模型不能改验收标准——这条我仍然坚持。但我把它错误地延伸成"任务模板必须预先写死"，那是我自己的装配写法造成的限制，**不是引擎的限制**。

实测事实：`scheduler.run(task)` 接受任意 task 对象，只要求 `task.recipeId` 对应的配方已注册。任务本身从来不必预注册。

## 2. 三层结构：两层动态，一层守死

| 层 | 谁决定 | 动态程度 |
|---|---|---|
| 任务（目标/输入/截止） | 调用方运行时传入 | **完全动态** |
| 配方（怎么做这类活） | 从规格生成 | **完全动态** |
| 验收（怎么算成功） | 从**闭合原语库**里选并参数化 | 词汇固定，参数动态 |

第三层不能放开，理由是：如果生成器能自己发明验收方式，它就能把失败重新描述成成功——**自循环会退化成自证循环**。

## 3. 验收原语库（`src/verifier-primitives.js`）

三个原语，覆盖"产物是否合乎声明"的常见形态：

| 原语 | 判据 |
|---|---|
| `exact_bytes` | 输出字节等于声明的 sha256 |
| `line_set` | 输出的行集合等于声明列表（顺序无关） |
| `structure` | 输出可解析且满足声明的形状（数组/对象/字符串 + 最小/最大项数、唯一键、非空字段） |

`structure` 的规则是**数据**不是代码：`{ type:'array', minItems, maxItems, uniqueBy, nonEmptyStrings }`。这样既能表达真实验收需求，又不允许夹带任意谓词。

未知原语报错而非降级——静默替换成更宽松的判据正是这个模块要防的事。

## 4. 配方工厂（`src/recipe-factory.js`）

`buildRecipeFromSpec(spec, { toolEffects })` 从规格生成标准配方：

- `candidates()` 每步重算，参数模板支持 `{{workspaceRoot}}` / `{{inputFile}}` / `{{outputFile}}` 占位符；
- 规格字段白名单，多余字段直接拒绝（防止夹带 `candidates`、`toolEffects` 之类可执行意图）；
- **效果表只能来自宿主的可信声明**，规格不得自带；
- 生成配方按 `recipeId:version` 入注册表，规格变更产生新键而不是改旧配方。

## 5. 工具层（`src/dynamic-tools.js`）

新增两个工具，**原有的 `runtime_run` 不动**（保留最受限路径）：

- `runtime_execute`：调用方描述任务 → 生成配方 → 走同一条宿主管线执行；
- `runtime_verifiers`：列出可用原语，让调用方在描述任务前就知道能怎么被验收。

权限边界：调用方可决定目标、输入、用哪个已声明工具、参数模板、选哪个原语；**不可决定**工作区、范围、工具的效应等级。这些来自 mount。

## 6. 执行证据

```
node --test packages/dsh-execution-runtime/test/*.test.js
# tests 481 / pass 481 / fail 0

node packages/dsh-execution-runtime/scripts/verify-dynamic-mutations.mjs
{"baselineExitCode": 0, "killed": 6}

node scripts/verify-combined.mjs
ALL PASS（324 个产物文件与源一致；1 个运行依赖在位且可解析）
```

真实宿主端到端（`dynamic-task.test.js`，6 项）：

1. 运行时描述的任务跑通，产物字节正确，判定来自 `builtin:line-set`；
2. 同一规格跨不同任务复用（`{{outputFile}}` 占位符生效）；
3. 输出不满足自声明的原语 → **不报成功**，`reason=line_sets_differ`；
4. 试图用 mount 未声明的工具 → 被 `mount does not allow` 拦住；
5. 未知原语在工具边界被拒；
6. 原语列表可发现。

## 7. 变异验证暴露的两个弱断言

首轮 6 个变异只杀死 4 个，两个存活，**都不是代码问题**：

- `unknown_primitive_accepted`：我改的是 `buildVerifier` 里的第二层校验，而 `validateSpec` 的第一层已经先拒了。改成同时击穿两层才有效——说明防护是**双层**的，这是好事，但变异目标选错了。
- `request_widens_tool_authority`：原断言只写 `isError === true`，而未注册工具**本来就会失败**，无论有没有 authority 检查。改成断言拒绝文案必须提到 mount 允许范围，才真正验证到那条检查。

教训复述：**变异存活要先分清"变异没生效"还是"断言太弱"**。这次两个都是后者，且都属于"以正确理由失败，掩盖了想验证的路径"。

## 8. 现在可以做什么

调用方（模型）现在可以这样用，无需任何预注册：

```
runtime_execute({
  goal: "把输入行按字典序写入 output.txt",
  recipe: {
    recipeId: "sorted-lines", tool: "runtime.write_text", effect: "reversible_write",
    verifier: { primitive: "line_set", parameters: { expectedLines: ["a","b","c"] } },
    arguments: { path: "{{workspaceRoot}}/{{outputFile}}", content: "a\nb\nc\n", createOnly: true }
  },
  inputs: { inputFile: "input.txt", outputFile: "output.txt" }
})
```

## 9. 多步配方（本轮补）

上一轮的多步缺口已补上，且**引擎零改动**——`recipe.advance` 与循环的"候选为空即停"机制本来就在，缺的是工厂支持 `steps`。

规格里 `steps` 是一个有序数组，每项是**单动作**（不允许嵌套）。执行时：

- `prepare` 写入 `{ step: 0 }` 游标；
- `candidates` 按游标返回该步动作，游标越界时返回空数组（循环据此正常结束，不是 `plan_gap`）；
- `advance` 在每步验证通过后把游标 +1。

踩到并修掉的两个真实缺陷：

1. **每步验证器返回 `goalSatisfied: true` 会让运行在第一步就结束**。`recordOutcome` 里 `goalSatisfied === true` 直接把 run 置为 `completed`，所以中间步骤必须报 `false`。现在只有最后一步可以声称目标达成。
2. **原语只认 `inputs.outputFile`**，多步任务写第二个文件时被判 `output_absent`。给原语参数加了 `targetFile`（裸文件名、限制在工作区内），使每一步能验收自己的产物。

另有一处架构约束：调度器要求验证器返回的 `verifierId` 精确等于注册的 ID，所以多步配方用一层 `stepVerifier` 统一改写身份，并把步骤名留在 `reason` 里（形如 `second:line_sets_differ`）。

新增两个变异：`intermediate_step_claims_goal`、`step_cannot_target_own_artifact`，都被对应断言杀死。dynamic 变异现为 **8/8**。

## 10. 条件分支（本轮补）

线性流水线只能表达固定顺序；要"灵活多变"，配方必须能按实际情况选路。已补上，且**引擎仍零改动**——分支完全在配方的 `advance` 里完成。

### 条件也是闭合词汇（`src/condition-primitives.js`）

道理和验收原语一样：**分支若由任意代码决定，配方就能绕过自己的验收标准**（挑一条验证器恰好通过的路，而不是干活的路）。所以条件也是数据：

| 条件 | 判据 |
|---|---|
| `file_exists` | 工区内某个裸文件名存在 |
| `file_sha256` | 该文件内容哈希等于声明值 |
| `step_less_than` | 步游标低于某界（用于表达有界重试） |
| `always` | 常量（让无条件跳转也是声明式，而不是"恰好为真的条件"） |

未知条件在**注册时**报错，不会拖到运行中途才发现。

### 步骤的 `next` 规则

```js
next: [
  { when: { kind: 'file_exists', parameters: { file: 'marker.txt' } }, goto: 'finish' },
  { goto: 'default' }   // 无 when = 默认
]
```

- 规则按顺序求值，首个命中的生效；无命中则顺序进入下一步；
- `goto` 必须指向**已声明的步 id**，否则注册时报错（否则运行会没有候选，看起来像 `plan_gap` 而非接线错误）；
- 步 id 必须唯一。

### 可追溯

`advance` 把每次跳转写入 `state.branchTrail`（`{from,to}`，保留最近 32 条），并统计每步进入次数（超过 64 次报 `branch_loop_exceeded`，防止分支写成死循环）。

理由：**"为什么走了这条路"必须能从持久状态回答**，而不是重跑一遍才知道。

### 一个测试缺口

首轮 11 个变异只杀死 10 个，`condition_always_true`（把条件求值改成恒真）存活——因为正向测试里的条件**本来为真**，恒真替换不改变行为。补了一个条件必然为假的对照（`gen-false-branch`），该变异随即被杀死。变异现为 **11/11**。

## 11. 仍未做

- 配方的**条件分支**：目前步骤是线性的，不支持"若 X 则走 A 否则走 B"。
- 原语库仍是最小集：缺"字段值由输入派生"这类关系型判据。
- 真实任务样本仍为 0，模式自动推广尚未被真实数据驱动。
