# DL-3.4 合成构建与隔离装载：证据

本文记录 DL-3.4 在**隔离工作树**内的验收。生产装配、活动 junction 与 profile 默认启用均不在本文范围。

隔离树：`D:\个人开发\dsh-execution-runtime`，分支 `feat/dual-loop-runtime`。
活动 junction `C:\Users\lyq\.dsh\profiles\web\node_modules\dsh-mind-system` 指向**另一仓库**（`dsh-mind-system-repo`），本树构建无法触及宿主——这一点在动手前用 `Get-Item -Force` 核过：本树 `packages/dsh-mind-system` 是普通 `Directory`，而活动 entry 是 `ReparsePoint/Junction`，且守卫脚本会拒绝在链接上构建。

## 1. 先说清上一轮的误判

上一轮我把 `verify-combined` 的失败记为"原仓库构建用的部分输入未入库"，这个结论**过重了**。本轮做了分层取证的实测：

1. 用 `git -c core.autocrlf=false checkout-index` 导出纯 LF 树，改写规则**全部命中**，只剩 1 项差异；
2. 对那 19 个哈希不符的产物逐字节验证：**19/19 的磁盘产物都等于按其源文件算出的内容**，只是 `build-stamp.json` 里记录的哈希过期；
3. 根因是**行尾**：本树全局 `core.autocrlf=true`，签出为 CRLF，而索引与已提交指纹是 LF。按字节比较必然不等。

结论修正：**产物本身正确，过期的是元数据**；缺的不是上游输入，而是行尾一致性与一次指纹重建。

## 2. 修法：让工作树与索引字节一致

不走"让构建容忍行尾差异"的捷径——那会让字节级比较失去意义，等于把闸门调松。

- `git config --local core.autocrlf false`（本树局部设置，不动全局 `D:/Git/etc/gitconfig`）；
- 删除 270 个 `w/crlf` 文件后由索引重签出，全部变为 `w/lf`（`git ls-files --eol` 复核：`w/crlf` 计数 0）；
- `git add --renormalize .` 刷新 stat 缓存；过程中它把 `recovery.test.js` 的索引条目改成 CRLF，已用 `git restore --staged` 回退并从索引重写工作树，复核为 `i/lf w/lf` 且 7 项测试通过。

`core.autocrlf=false` 会写进 `.git/config`（非版本控制内容）。这是隔离树的本地环境设置，不改变仓库内容，也不影响活动 junction 指向的仓库。

## 3. 运行依赖：gitignored 但运行必需

`verify-combined` 有一条独立断言：`meta/node_modules/@causal-layers/meta-framework` 必须存在且入口可解析。它被 gitignore 覆盖，**任何 checkout 都不会有**，因此原仓库有、隔离树没有。

从原仓库复制该依赖（82 个文件，含 59 个上游文件）到本树对应位置。它仍在 gitignore 下，不污染工作树（`git status` 只有 `build-stamp.json`）。

这条断言值得留意：它单独存在，是因为构建指纹看不到 `node_modules`——删掉那批 `.js`，构建照样报"已是最新"，部署回执全对而运行崩。这正是"绿灯来自一条没检查过依赖的回路"的形状。

## 4. 构建与守卫结果

```
node scripts/build-combined.mjs
  合成包产物：243 个文件（来自 5 个成员，排除 10 项）
    ~ build-stamp.json           ← 只重建指纹，产物无一改动
  写入 1 个，删除 0 个。

node scripts/verify-combined.mjs
  verify-combined: ALL PASS（243 个产物文件与源一致；1 个运行依赖在位且可解析）

node scripts/verify-subpackages.mjs        → ALL PASS
node scripts/verify-subpackage-structure.mjs → ALL PASS
node scripts/verify-readme.mjs             → ALL PASS
node scripts/verify-plan.mjs               → plan-check: ALL PASS
```

`build-combined` 只写了 1 个文件（指纹），其余 242 个产物本就与源一致——这是对第 1 节结论的独立印证，不是同一条回路的自证。

## 5. 隔离装载（新增守卫）

新增 `scripts/verify-isolation-load.mjs`（`npm run verify-isolation-load`）。它先拒绝在链接目录上运行，然后按宿主的方式经**声明的 exports** 装载合成包，共 13 项：

- 合成包经 `.` 导出可导入；
- 全部子路径导出逐个导入（`./client` 是浏览器侧，Node 不可导入 → 标 SKIP 并说明）；
- 执行运行时插件暴露 `createExecutionRuntimePlugin`；
- 装载前后 `build-stamp.json` 可读（装载不得改写包）。

结果：**ALL PASS（13 项，6 项因环境跳过）**。

**必须如实说明这 6 项 SKIP 的口径**：4 个 `clis` 系列导出与 `./client` 之外的跳过，唯一缺失模块实测为 `@deepseek-ai/cordis`——本树**完全没有 `node_modules`**（`Test-Path node_modules\@deepseek-ai` 为 False），原仓库同样解析不到。这是**环境前置缺失，不是合成包缺陷**，但也不能记成"已验证通过"。所以：

- 已验：包结构与 `.`/`agent-mind`/`meta-framework`/`valves`/`memory-manager` 五个子路径可导入，运行时插件工厂可用；
- 未验：`clis` 系列在**真实 Cordis 宿主**内的行为（需先安装 peer 依赖）。

## 6. DL-3.4 结项口径

| 子项 | 状态 | 依据 |
|---|---|---|
| 源/产物一致性 | ✅ 已验 | `verify-combined` ALL PASS（243 文件） |
| 结构、README、计划守卫 | ✅ 已验 | 三个守卫 ALL PASS |
| 装载：包结构与主要子路径 | ✅ 已验 | `verify-isolation-load` 13 项 ALL PASS |
| 装载：`clis` 在真实宿主内 | ⚠ 未验 | peer `@deepseek-ai/cordis` 未安装（环境前置） |
| HMR 卸载 stop-then-drain | ✅ 已验（另有套件） | `plugin.test.js` 卸载/排空语义 |

因此 DL-3.4 记为**部分已验**：构建与装载主干已通，`clis` 在真实宿主内的行为待补 peer 依赖后再验。上一轮记的"环境前置缺失，无法通过"已被本轮推翻——**构建在这棵树里是能绿的**，前提是把行尾与依赖补齐。

## 7. 仍未做的事

- 未向活动 junction 构建、未改 profile 默认工厂、未发布、未 push；
- 真实宿主内的 `clis` 行为验证（需 `@deepseek-ai/cordis`）；
- DR-17/18 对照实验与真实 Jev：需真实任务集与凭据。
