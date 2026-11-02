# dsh-meta-framework 插件审查报告

**审查对象**：`C:\Users\lyq\Documents\deepseek-harness\default-workspace\dsh-meta-framework`
**版本**：0.1.0（private，link 进 web profile）
**审查日期**：2026-11-01
**方式**：三个子代理分工（装载对接 / 逻辑契约 / 工程质量）+ 主审独立实测 + 一轮复审

> **状态：首轮发现的阻塞与重要问题已全部修复并验证。**
> 修复后 **29 个用例全绿**（首轮 15 个），最新 commit `97818cc`。

---

## 复审补充（逻辑契约，第二份独立意见）

复审者的原话结论：

> **这个工具的 trace 基本可信，不会撒谎** —— 10 个字段按契约落盘且经库自带守卫
> `assertRunResultConsistent()` 校验通过，`execution`/`change` 填 `null` 是契约允许的
> 如实反映而非编造，unknown 与"从没问过 CLIS"也能正确区分；
> **唯一会说错话的是分类器崩溃时那句 `note`**。

它额外确认了三件我原来只靠推理的事：

1. **`gate: 'n/a'` 的语义正确**。契约 `GateStatus` 的 `macro_gate` 枚举含 `'n/a'`，
   且文档写明 `n/a` = 不需要宏观评审、`pending` = 还没审。本工具从不产生框架修订
   提议，所以填 `n/a` 对；反而填 `pending` 是撒谎（暗示有人在等审）。
2. **`execution: null` 是契约写法，不是偷懒**。契约里该字段声明就是
   `FrameworkExecutionResult | null`，注释写明"未执行时为 null"。
3. **`clis_used` 的修法正确**，并指出回退分支 `: causalType !== undefined` 只在
   session 残缺时走到，是防御性代码 —— 应该在注释里说明，否则后人会以为是活路径。

它还发现一个**我漏掉的真问题**，已修（见下方 B2）。

---

## 总评

**首轮审查时"能跑但不算做完"，现已修到可以长期使用。**

插件在真宿主里已激活、`meta_reframe` 工具可被 agent 调用、因果判断链路正确
（meta → CLIS 方向无误）、**trace 真的落盘了**（首轮的主要缺陷）。

另有一个**认知层面的问题**比代码问题更重要：这个插件继承了 meta-framework 的
核心局限（D11：真实任务会卡 `human_gate`、路径是模板），所以它的价值上限是
"诊断辅助"，不是"决策支持"。这一点已写进 README 顶部，避免期望错位。

---

## 一、阻塞级（已修）

### B1 · 工具调用永不落 trace ✅ 已修

**位置**：`src/tools.js` 的 `reframe()`

**问题**：`reframe()` 只调 `redefine` → `customize` → `select`，**绕过了 `run()`**。而写 trace 是 `run()` 独有的职责。

**证据**：

```
# 谁负责写 trace
run.js L27:  import { writeTrace } from './trace.js';
run.js L212: const traceWrite = await writeTrace(metaTrace, { ... });

# 分步调用层有没有
layers/redefine.js / select.js / customize.js → 均无 writeTrace
```

**实测确认**（不是推测）：真调三次工具后，全盘搜索 trace 文件：

```
D:\dsh\data\meta-traces           : 不存在
C:\Users\lyq\.dsh\data\meta-traces : 不存在
全盘搜 meta-2026-11-01T12-28*     : 无结果
```

**为什么这是阻塞**：
- meta-framework 的核心卖点之一是"每次 run 都有 trace 可回放"（README 与 D11 都这么写）
- 但**工具路径上这个承诺不成立** —— 使用者看不到任何调用记录
- 出问题时无法复盘"当时给的四问是什么、判成了什么、为什么"

**✅ 修复**：`reframe()` 里自己拼一条 trace 并调 `writeTrace()`。字段按
`MetaTrace` 契约填满 10 个，`execution` / `change` 如实为 `null`
（没走 observe，不编造执行结果），`rollback_count` 为 `0`。

**✅ 复核证据**（真宿主内实测）：

```
trace.written: true
trace.path   : D:\dsh\data\meta-traces\meta-2026-11-01T12-37-14-685Z_....json
磁盘确认     : 存在，1705 B，10 个字段齐全
execution    : null ✔（如实：没执行）
change       : null ✔
gate         : {"insight_gate":"pending","macro_gate":"n/a"}
```

**✅ 变异验证**：把 trace 写入改成不写 → 测试红；把 `execution` 编造成
`succeeded` → 测试红。这条"不撒谎"约束是真的被守住的。

---

## 一之补2 · B3 探针说反话：CLIS 可用时报不可用 ✅ 已修

**这份报告里最讽刺的一条 —— 我上一轮刚总结"「没有记录」和「记录里写了假话」是两个不同量级的缺陷"，结果探针自己就在写假话。**

**位置**：`src/health.js` 的 `probe(ctx)`

**问题**：`dsh-clis` 的 `wrapExportedProbe` 是这样调的：

```js
raw = await exported.probe();   // 零参数，不传 ctx
```

而我把 `probe(ctx)` 写成有参并靠它查 CLIS → **`ctx` 永远是 `undefined`**，于是：

- `classifier-missing` 在**每台装了 CLIS 的机器上恒误报**
- `meta-framework.ok` 分支在真实发现路径上**不可达**（只有单测手工传 ctx 才走得到）

**真宿主坐实**：向运行中的宿主查 `clis_probe`，本插件报的是
`{code: "meta-framework.classifier-missing"}`，而本机 dsh-clis 明明装着、
`ctx.get` 明明能取到服务。

`info` 级不拉红灯，但它污染了监督层的 `raw_finding_count`，且让人以为 CLIS 没装。

**✅ 修复**：`apply(ctx)` 时 `bindContext(ctx)` 存进模块级变量，探针签名改为**零参数**，从模块级变量读。

**附带修的第二处同类问题**：未装载时原来也报"CLIS 不可用"——把"还没装载"说成"没装"
同样是假话。现在改说"尚未装载（或宿主上下文不可用），无法确认"。

### B4 · 探针漏判 `dsh-tools` 能否加载 ✅ 已修

**位置**：`src/health.js`

**问题**：只判"安装根存在"，没判 `dsh-tools` 能否真加载。

复审者造了个"有 cordis、无 dsh-tools"的假根实测：`getDefineTool()` 抛
`Cannot find module '@deepseek-ai/dsh-tools'`，**而探针照报 `status: ok`** ——
正是它声称要盯的那个失败模式（工具未注册），探针漏了。

**✅ 修复**：新增 `meta-framework.tools-unavailable` 代号（error 级），
定位成功但 `dsh-tools` 缺时报出。

### 附带：`resolveDshRoot` 的模块级缓存污染测试 ✅ 已修

写 B4 的测试时踩到：缓存是模块级的，前一个用例把根缓存成真实安装后，
后面改 `DSH_INSTALL_DIR` 不生效 → "我明明改了环境变量却还是 ok"的假失败。

新增 `clearRootCache()`（标注 `@internal`，生产代码不需要）。

---
## 一之补 · B2 分类器故障被说成"未知结构" ✅ 已修

**这是复审者发现、我漏掉的真问题。**

**位置**：`src/tools.js` 的 note 生成分支

**问题**：分类器**抛异常**或**返回 null** 时，输出的 note 与"真判为 unknown"**逐字相同**：

```
已提供四问作答且 CLIS 可用，但结论为 unknown —— 这个问题不属于已知的四种结构。
```

实测三种情形的 note 完全一致，只有 `clis_used` 不同（false vs true）可分辨。

**为什么这比 trace 不落盘更隐蔽**：trace 不落盘是"没有记录"，使用者会察觉；
而这句 note 是**主动给出了错误的结论**。它会让人放弃一个本来能判出来的问题 ——
"哦，这问题不属于已知结构，那我换个思路吧"，而真相是分类器崩了、重试就行。

**✅ 修复**：拆成四种情形，用 `answered && clisAvailable && !clisUsed`
精确识别"调了但没成"（依据库源码：unknown 是成功会 `markUsed`，失败则不 mark）：

| 情形 | 判据 | note |
| --- | --- | --- |
| 没给作答 | `!answered` | 请补 q1–q4 |
| 服务缺失 | `!clisAvailable` | 装 clis-classifier |
| **分类器故障** | `answered && available && !clisUsed` | **「本次没有拿到因果结论，不代表这个问题不属于已知的四种结构」** |
| 真 unknown | `answered && available && clisUsed` | 结论：不属于已知四种 |

**✅ 变异验证**：去掉 `classifierFailed` 分支 → 两个新测试立刻变红。

**写测试时踩的一个坑**（值得记）：一开始我断言"故障文案不能包含『不属于已知』"，
结果测试红了 —— 因为修复后的文案本身写着"**不代表**这个问题不属于已知的四种结构"。
判据应该落在"是否带否定前缀"上，而不是关键词是否出现。

---
## 二、重要级

### I1 · `inject` 漏声明 `tools` —— 插件曾完全不装载（已修）

**位置**：`index.js:52`

**原始问题**：写成 `export const inject = []`，宿主启动日志报：

```
meta-framework (dsh-meta-framework): Error: cannot get property "tools" without inject
dsh: warning: 1 entry did not activate
```

**根因**：Cordis 规定**访问任何服务属性都必须先在 inject 声明**，即使该服务一定存在。`ctx.tools` 是属性访问（走 Proxy get），不是 `ctx.get()`。

**实测对照**（这点容易搞混，值得记）：

| 访问方式 | 未 inject 时 | 结论 |
| --- | --- | --- |
| `ctx.get('clis.causalClassifier')` | **正常返回对象** | `ctx.get` 不要求 inject |
| `ctx.tools` / `ctx.tools.register()` | **抛错** | 属性访问要求 inject |

所以正确写法是 `inject = ['tools']`，而 CLIS 三服务继续走 `ctx.get()` 运行时探测。当前代码已修好。

> 注意与 meta-framework 库 D8 的区别：D8 说的是别写 `{ required: [], optional: [...] }`（每个键都被当硬依赖，插件永不装载）。写服务名数组 `['tools']` 是合法形态。

### I2 · 契约外扩展字段 `causal_answers` 是类型层盲区

**位置**：`src/tools.js` 的 `toProblem()`

**问题**：`ProblemContext` 契约里**没有** `causal_answers` 字段（已核对 `meta-types.d.ts`）。插件往里塞，靠 JS 不校验多余属性在运行时生效。

**实测确认链路是通的**：把字段传给真 classifier，收到的 answers 完整正确，判出 `cyclic`。但：

- TypeScript 编译期完全不管（插件是 .js，不经过 tsc）
- 若将来 meta-framework 改了读取方式（比如改成读 `problem.answers`），插件会**静默失效**——不报错，只是永远判不出类型
- 这正是契约缺口 D7 的延续

**现状**：保留。这是 `meta-framework` 库自己约定的扩展读法（`clis-bridge.js` 的 `toCausalProblem()` 明确读 `problem.causal_answers`），插件是它唯一的正确用法。测试已覆盖"给了四问就判得出类型"这条链路（虽然用的是 mock classifier）。

**仍未解决**：mock classifier 测的是"参数是否传到了分类器"，不是"真 CLIS 会这么判"。后者只能靠宿主内实测（已做过三次，但不可回归）。

### I3 · 测试存在"自己测自己"的风险 ⚠️ 部分缓解

**位置**：`test/tools.test.js` 的 `makeClassifier()`

**问题**：测试里手写了一份"四问 → 类型"的映射规则，然后用它验证工具。这测的是**测试自己写的规则**，不是"CLIS 真的这么判"。

**已有缓解**：主审在真宿主里用**真 dsh-clis 分类器**调了三轮，分别判出 `cyclic` / `unidirectional`，与四问作答吻合。所以链路本身是通的。

**仍未解决**：这条验证是手工跑的，不可回归。要固化需要拉起真 CLIS 插件，成本较高，暂缓。

### I4 · `files` 声明了不存在的 `README.md` ✅ 已修

**位置**：`package.json` 的 `files` 字段

**原问题**：`Test-Path README.md` → `False`。`npm pack` 不会失败（缺失文件被忽略），但清单与实际不符。

**✅ 修复**：补了 `README.md`，内容包括定位说明（诊断工具非决策工具）、三种"没判出类型"的区分、trace 字段说明、依赖分层、已知限制。

---

## 三、建议级（本轮已处理）

### S1 · 根目录遗留 4 个调试脚本 ✅ 已删

`diag.mjs` / `diag2.mjs` / `diag3.mjs` / `diag4.mjs` 已删除。
（`files` 字段本来就没包含它们，`npm pack` 不会误发。现在源码树也干净了。）

### S2 · 插件目录没有 git 仓库 ✅ 已修

已 `git init` 并提交两次：

```
f42ba11 fix: 修正 clis_used 语义、探针返回结构与 trace 边界写法
1850e62 feat: dsh-meta-framework 插件首版（meta_reframe 工具 + 健康探针 + trace 落盘）
```

.gitignore 覆盖 `node_modules/` / `.test-traces/` / `data/` / `*.tgz` / 凭据。

### S3 · `test` 脚本的 glob 隐患 ✅ 已修

从 `node --test test/*.test.js` 改为显式列出两个文件：
`node --test test/tools.test.js test/health.test.js`。
不依赖 shell 展开，跨平台一致。**23 个用例通过。**

### S4 · 无 healthProbe ✅ 已修

新增 `src/health.js`，导出 `healthProbe = { probe }`，并从 `index.js` 转出。

**返回结构对齐 dsh-clis**：`{ plugin, status, findings }`，并复刻同一套
`deriveStatus`（`error → failing` / `warn → degraded` / 否则 `ok`）。
刻意不自己发明状态口径 —— 监督层会汇总展示，口径不一致会让同一个问题
在不同插件的行里显示成不同严重度。

检查三件事：

| 代号 | 严重度 | 含义 |
| --- | --- | --- |
| `meta-framework.host-root-missing` | error | 定位不到 DSH 安装根 → 工具未注册 |
| `meta-framework.classifier-missing` | info | 无 CLIS → 判不出因果类型 |
| `meta-framework.ok` | info | 正常 |

**为什么 CLIS 缺失标 `info` 而不是 `error`**：它是可选增强。把它报成错误会让
监督层天天亮红灯，最后没人再看——那比不报更糟。

### S5 · peerDependencies 标 optional ✅ 保留（理由已明确）

`~4.0.5` 与本机实际 `4.0.5` 吻合。标 `optional: true` 是正确的：profile 的
`node_modules/@deepseek-ai` 里没有该包（插件走安装目录 require），
非 optional 会让 `pnpm install` 直接失败。

**本轮补充**：把真正会被 import 的 `@deepseek-ai/dsh-tools` 也加进 peer
（同样标 optional），否则依赖清单与真实依赖不符，下一个人会误判
"这插件不需要 dsh-tools"。

---

## 四、子代理复审补充（装载对接）

一个子代理对"装载与宿主对接"做了独立复审，发现 4 条我遗漏或做错的地方，
本轮已修：

### ① `resolveDshRoot()` 第 3 档探测曾是死代码 ✅ 已修

原实现 `createRequire(import.meta.url).resolve('@deepseek-ai/cordis')` ——
`resolve` 只沿**插件自己**的解析图上溯，而插件 node_modules 里根本没有
`@deepseek-ai/*`，所以这一档**永远 MODULE_NOT_FOUND**，等于没写。

**修法**：改为遍历 `process.getBuiltinModule('node:module').Module._cache`，
找含 `node_modules/@deepseek-ai/` 的已加载模块，从其位置向上找根。

**实测验证**（这是关键，因为上一版就是个"看起来对但跑不到"的分支）：

```
加载宿主 cordis 后，cache 命中 1 条：
  D:\dsh\node_modules\@deepseek-ai\cordis\lib\index.js
清空全部 DSH_* 环境变量后，resolveDshRoot() → D:\dsh ✔
```

顺带发现：Node 22 下 `mod.require` 是 `undefined`，真正能用的是
`mod.Module._cache`。当前写法 `mod?.require?.cache ?? mod?.Module?._cache`
的回退分支正是走通的路径。

### ② 探测失败时整插件静默消失 ✅ 已修

原 `apply()` 顶层同步调 `getDefineTool()`，定位失败时抛错 → 整个插件不激活，
宿主只报一句 `1 entry did not activate`。这是最难查的失败形态：没人知道
"插件装了但没跑起来"。

**修法**：`apply()` 里 try/catch 包住，失败时 `ctx.logger?.('meta-framework')?.error?.(...)`
记一条清晰日志然后正常 return。

**实测验证**（清空全部 DSH_* 变量 + cwd 换到无 node_modules 的临时目录）：

```
apply 是否抛错: false
是否记了日志: true
日志内容: meta_reframe 未注册：无法加载宿主工具定义器。原因：无法定位 DSH 安装目录…
```

### ③ `probe()` 只判目录存在 ✅ 已修

`MARKER` 从 `.../cordis` 收紧到 `.../cordis/package.json`（与 dsh-clis 一致），
避免半装坏的空目录被误判为安装根，导致失败点离真因很远。

### ④ `@causal-layers/contracts` 是多余直接依赖 ✅ 已删

全量 grep 确认零 import —— 它是 meta-framework 的传递依赖。直接钉在顶层
会在未来制造版本冲突。已从 `dependencies` 删除。

---

## 五、主审自查又发现的一条（子代理之外）

### `clis_used` 语义曾与库不一致 ✅ 已修

原来用 `clis_used: causalType !== undefined` 判断"是否用过 CLIS"。
但读库源码（`layers/redefine.js`）后发现：

> 「调用成功即记一次使用 —— 即使结论是 unknown，那也是分类器给出的结论」

即 `markUsed()` 在**分类调用成功**时就置位，**哪怕结论是 unknown**。
所以 unknown 场景下库的语义是 `clis_used = true`，而旧判据给出 `false`。

**为什么这很重要**：`clis_used` 会被读 trace 的人当作"当时到底问没问 CLIS"，
用错判据会让历史记录撒谎 —— 明明问了、判成 unknown，却显示成"没问"。

**修法**：改用库自己的记账 `session.clisUsed`，拿不到才回退旧判据。
**变异验证**：退回旧判据 → 新加的测试立刻变红 ✔

---

## 六、已验证正常的部分（附证据）

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| 插件在真宿主激活 | 重启后看 `D:\dsh\logs\web-3080.log` | 无 `did not activate`、无 Error |
| 工具可被 agent 调用 | 主审直接调 4 次 | 均返回结构化结果 |
| **meta → CLIS 方向正确** | classifier 被调用计数 = 1 | ✅ 方向没搞反 |
| **trace 真的落盘** | 真宿主调用后查磁盘 | ✅ 文件存在，10 字段齐全 |
| **trace 不撒谎** | 检查 execution/change | ✅ 均为 null，未编造 |
| **trace 过库自带守卫** | 喂给 assertRunResultConsistent() | ✅ 通过（复审者实测） |
| **故障 ≠ 结论** | 分类器抛错 / 返回 null / 真 unknown 三情形对比 | ✅ note 现已区分 |
| **测试不污染数据目录** | 清空 data/ 后跑测试 | ✅ 不再重建 |
| 宿主定位失败时降级 | 清空所有 DSH_* + 换 cwd | ✅ 不抛错，记日志 |
| 第 3 档探测有效 | 加载宿主 cordis 后清空环境变量 | ✅ 仍能定位到 D:\dsh |
| CLIS 晚装载也能用 | 先装 meta、后装 CLIS | `clis_available` 从 false 变 true |
| CLIS 不可用时不崩 | `ctx.get()` 强制抛错 | 降级返回，不中断 |
| 三种"没判出类型"可区分 | 不给作答 / 服务不可用 / 未知 | note 分别准确说明 |
| 探针结构对齐 dsh-clis | 对比返回形状 | `{plugin, status, findings}` 同构 |
| 四问字段名 | 逐字核对契约 `FourAnswers` | 四个全对 |
| 参数 schema | 检查 `parameters` | `required:["description"]`，四问带 enum |
| 边界输入 | 空串 / 1 万字符 / 特殊字符 | 均安全处理 |
| 打包内容 | `npm pack --dry-run` | 5 个文件，无调试脚本、无测试 |
| 测试 | 连跑多次 | **29/29** 稳定通过 |

---

## 七、遗留项（明确不修，附理由）

| 项 | 为什么保留 |
| --- | --- |
| mock classifier 测不出"真 CLIS 会怎么判" | 固化需拉起真 CLIS 插件，成本高于收益；已手工验过三次 |
| `causal_answers` 是契约外字段 | 这是库自己约定的扩展读法，插件是唯一正确用法；改用契约内字段需改库 |
| 无 icon / locale | 面板回退默认图与裸名，不影响功能 |
| 未做 trace 轮转/清理 | 与库自身行为一致（库也不清理），不是插件该管的事 |

---

## 八、一句话

**两轮审查（三路分工 + 两轮复审）发现的全部阻塞与重要问题已修完并验证，
29 个用例守住；trace 经库自带守卫 `assertRunResultConsistent()` 校验通过，
不会撒谎。**

最值得记的一条教训来自复审：**"没有记录"和"记录里写了假话"是两个不同量级的
缺陷**。trace 不落盘使用者能察觉（找不到文件），而分类器崩溃时那句 note
主动给出"这问题不属于已知结构"的假结论 —— 后者会让人做出错误决策却不自知。
修这类问题的判据不是"输出有没有值"，而是"这个值在说真话吗"。

更根本的：这个插件的价值上限是 meta-framework 的价值上限。D11 已证明那套
框架"擅长诊断结构、不擅长给可执行方案"，插件如实继承了这一点
（工具描述与 README 都写明"这是诊断工具，不是决策工具"），
这比包装成万能工具要诚实得多。