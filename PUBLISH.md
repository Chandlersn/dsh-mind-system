# 发布说明 · 心智系统 monorepo

> 仓库：<https://github.com/Chandlersn/dsh-mind-system>
> 日期：2026-11-02

## 已完成

**GitHub**：`Chandlersn/dsh-mind-system`（public，main 分支）

四家合成一个仓库，`packages/` 下各自独立：

| 包 | 目录 | 说明 |
|---|---|---|
| `dsh-agent-mind` | `packages/dsh-agent-mind` | 调度层：判断顺序分节 + 按处境重排工具面 + 命中率回归与采样 |
| `dsh-clis` | `packages/dsh-clis` | 因果结构判据 + 系统监督 + 介入漏判分母 |
| `dsh-meta-framework` | `packages/dsh-meta-framework` | 重定义 → 边界 → 选择 → 观测 |
| `dsh-memory-manager` | `packages/dsh-memory-manager` | 五层记忆判据 + 写入前拒绝 + 落盘后回读复核 |
| `dsh-mind-system` | `packages/dsh-mind-system` | 聚合包：装载四家（唯一入口形态） |

**安装形态**（别人怎么用）：

```bash
dsh plugin --profile web add dsh-mind-system
```

装完重启宿主。聚合包是四家唯一的装载入口，**不要**再单独装其中一家（会双装载）。

**本机已切到 monorepo 为唯一真源**：profile 的 junction 全部指向 `packages/` 下对应目录 ——
改代码与发仓库是同一处。

> ⚠️ **安装声明必须是 `link:`，不能是 `file:`。**
> | 声明 | pnpm 行为 | node_modules 里的形态 | 改源码后 |
> |---|---|---|---|
> | `link:C:/...` | 建目录链接 | **Junction** | **立即生效**（配合 HMR） |
> | `file:C:/...` | 打包拷贝 | 真实拷贝（无 LinkType） | **不生效**，必须重建+重装+重启 |
>
> 实测对照：本 profile 里 `dsh-learning-mode` / `dsh-syskeeper` / `dsh-session-tools` /
> `dsh-video-studio` / `dsh-workbuddy-channels` 全是 `link:` → 全是 Junction；
> 只有 `dsh-mind-system` 曾是 `file:` → 是拷贝。差别不在 pnpm 版本，只在声明方式。
>
> 判据（一条命令）：
> ```powershell
> Get-Item 'C:\Users\lyq\.dsh\profiles\web\node_modules\dsh-mind-system' -Force |
>   Select-Object LinkType, Target
> # LinkType=Junction → 正确（或至少是链接形态）
> # LinkType 为空     → 是拷贝，改源码不会生效
> ```

---

## 🚨 运行状态警示：改这个仓库等于改正在运行的系统

**本机安装形态是 junction（`node_modules/dsh-mind-system` → `packages/dsh-mind-system`），
加上 `cordis.patch.yml` 的 HMR root 覆盖 `clis` / `meta` / `memory` / `mind` 四个目录。**

这意味着：

| 你做的事 | 会发生什么 |
|---|---|
| 改 `packages/*/` 下的 `.js` 并保存 | HMR **约 300ms 后自动重载该插件**，可能中断正在跑的会话 |
| 改到一半保存 | 运行中的模型看到一个**半成品实现**，行为不可预测 |
| 改 `src/dispatch.js` 这类被多处 import 的模块 | 依赖它的插件可能整组重载 |
| 在仓库里跑 `git checkout` / `git stash` / 切分支 | **运行中的系统立刻变成那个版本**，包括回退到旧代码 |
| 跑测试（`node --test`） | 默认不会写用户数据；但**若 `DSH_HOME` 未隔离**，测试会写进真实采样文件 |

**因此：**

1. **不要在运行时段做大范围改动**。需要重构、切分支、回滚时，先停宿主
   （或明确接受会话被中断）。
2. **一次只改一个可工作的最小步**。junction 下没有"改完再一起生效"这回事 ——
   每次保存都是一次部署。
3. **改完立刻验证**，不要攒着改完再测。HMR 已经把它推给运行实例了。
4. **提交前确认工作区干净**。junction 意味着仓库工作区就是生产代码；
   未提交的改动 = 未发布的线上代码。
5. 需要**彻底回滚**时，`git checkout` 就够了（不用重装），但会立即影响运行实例。

> 这条规则与"拷贝形态"相反：拷贝形态下改源码是安全的（不影响运行），
> 必须显式部署才生效；**junction 形态下改源码就是部署**。
> 切换形态前请确认你接受这个代价。

### 热重载机制（依据官方文档 + 源码，不是推断）

> 本节依据 `@deepseek-ai/dsh-hmr` 自带的 **README.zh.md** 与 `lib/index.js` 源码，
> 每条附出处。早前本文件曾写「HMR 只监视 root、`node_modules` 被 ignored 所以不生效」——
> **那句是错的**，已按官方说明改正，见下面的机制说明。

#### 两条独立的监听通道

HMR 有两套机制，触发源不同，**不要混为一谈**：

| 通道 | 监听对象 | 触发什么 | 源码 |
|---|---|---|---|
| **A. 模块通道** | `root` 目录下的源码文件（chokidar） | 热替换已加载的模块 | `this.watcher = watch(...)` **L883** |
| **B. profile 通道** | **只有**三个文件：`cordis.patch.yml`、home 下 patch、profile `package.json` | `reconcileProfile()` 重新组合 | **L830–L871**（`refresh` → `reconcileProfile()` **L865**） |

**关键**：通道 B **不会**因为改 `.js` 而触发。README 第 49 行说的是"每次重新组合时"会替换
磁盘已变的插件——那要求**先有重新组合**（由 patch/manifest 变化或 Plugin Manager 操作触发）。
所以想让"改 `.js` 就生效"，必须靠**通道 A**。

#### 通道 A 的判定条件（**L900–L912**）

```js
const url = pathToFileURL(filename).href;          // L903
...
if (this.esmHas(url) || this.esmHas(url, "json")) {  // L908
  this.stashed.add(url);       // ← 进热替换候选
  continue;
}
```

`esmHas(url)` 查的是 **Node 的 ESM `loadCache`**（**L802–L804**）。也就是说：

> **只有该文件已经被加载过，改它才会触发热替换。**

没被 import 过的新文件改了 → HMR 什么也不做（这解释了我此前"新增探针文件无反应"为什么是预期行为，不是失败）。

#### junction 为什么是前提（这才能解释它为什么现在能工作）

README 第 81 行：被监听模块的路径沿用 **`realpathSync()`** 表示。
`esmHas` 查的是 `loadCache`，而 `loadCache` 的键也是 realpath。

于是 junction 把两条路径合并成一条：

```
宿主 import: node_modules/dsh-mind-system/mind/src/dispatch.js
                    │
                    └─ realpathSync → packages/dsh-mind-system/mind/src/dispatch.js
                                              ↑
chokidar 在 root 里监视的就是这个路径 ─────────┘
```

实测（`realpathSync` 两条路径返回**同一字符串**）：

```
inst realpath: ...\dsh-mind-system-repo\packages\dsh-mind-system\mind\src\dispatch.js
repo realpath: ...\dsh-mind-system-repo\packages\dsh-mind-system\mind\src\dispatch.js
两者相同  : true
```

**拷贝形态下这条链是断的**：`loadCache` 的键是 `node_modules/...`（无链接，
realpath 就是它自己），而 chokidar 监视的是仓库路径 → 两者不相等 → `esmHas` 不命中 →
文件事件走到 `else this.ctx.emit("hmr/change", url)` 分支，不产生重载。
**这就是"拷贝形态改了必须重启"的真正原因**，不是 `ignored` 配置。

#### `ignored` 不是障碍（纠正此前的错误理解）

`ignored` 的默认值含 `**/node_modules`，但它**只作用于通道 A 的 chokidar**
（**L879** `picomatch(ignored)`；**L886** `ignored: (path) => match(relative(watchBaseDir, path))`）。
root 配的是**仓库路径**，不是 `node_modules`，所以这个 ignore 规则对 mind 不生效。

> 反过来说：如果 root 指向的是 `node_modules` 里的路径，`**/node_modules` 才会把一切屏蔽掉。

#### 重载发生在哪里（链路的终点）

命中候选后走 `partialReload()`（**L1015**），真正替换插件在 **L1110–L1124**：

```js
this.ctx.registry.delete(plugin);            // L1112  停旧插件
await Promise.all(fibers.map(...fiber.await()));  // L1113  等它干净退出
await reload(replacement, fibers, ...);      // L1119  用新模块重新激活
this.ctx.logger.info("reload plugin at %C", path);  // L1120  ← 成功的直接证据点
```

`reload` 会重新跑插件的 `apply()`。这有个**行为副作用必须知道**：
插件里所有**模块级状态会被重建** —— 比如 mind 的 `situation.js` 那些 `let latestDecision`、
信号注册表、以及采样写入队列，重载后**全部归零**。正在进行的对话中，
这等于插件的记忆被清空（对话历史本身不受影响，因为它不归插件管）。

> 所以热重载对"改了逻辑"是好事，对"改到一半"是坏事：
> 半成品的 `apply()` 会以半成品状态激活，且旧状态救不回来。

#### 已验证的事实

| 事实 | 判据 |
|---|---|
| 安装形态是 Junction | `Get-Item ... -Force` → `LinkType=Junction`，`Target` → `packages/dsh-mind-system` |
| 两路径 realpath 相同 | `realpathSync()` 双向比较返回同一字符串 |
| 双向写入 | 通过 `node_modules/...` 写入，仓库侧哈希同步改变 |
| `mind` 在 root 内 | `cordis.patch.yml` 的 `hmr.root` 含 `.../dsh-mind-system/mind` |
| 判定链条成立 | `esmHas` 查 `loadCache`（`:802`），键为 realpath；root 监视同一 realpath |

#### 仍未直接观测到的部分（诚实标注）

**「保存 `dispatch.js` 后，HMR 在 300ms 内真的重载了 mind 插件」这一步，没有直接的运行日志证据。**
原因：HMR 不往 `D:\dsh\logs\web-3080.log` 写记录（该日志启动后只有 5 行），
而 PID 不变只能说明"没整进程重启"，不能反推"模块级重载成功"。

上面的机制链条（`loadCache` 键 = realpath = root 监视路径）是从源码推出来的，
**逻辑上闭合**，但没有一条"我看见了它重载"的观测。

想拿到直接证据，可用的办法（未实施，因为需要在生产代码里留探针）：
改 `mind/index.js` 让它启动时打一条带版本号的日志，然后看下次保存是否出现新日志。
不建议为了验证去做这件事 —— junction 下探针就是生产代码。

**因此的操作建议**：
- 改**被 import 过的** `.js` → 预期 HMR 会自动重载；**改完看行为验证一次**，别假设。
- 改**新增**文件、改 `package.json`、改 `exports` → 不保证，重启。
- 拿不准就重启（几秒，确定生效）。把"热重载会救我"当前提，是这里最容易犯的错。

#### 已知限制（摘自官方 README 第 104-124 行）

- 仅 `package.json` 的变化**不会**被检测到；`node_modules` 下 manifest 的通知被忽略。
- 替换沿静态导入传播；已存在的 Worker 与 TSX loader 线程保留各自缓存。
- 导入或启动失败的替换版本**保持未激活**，旧版本不会被恢复（修正文件后才再试）。
- 宿主依赖图中的模块变化保持**待处理**，直到进程重启。
- 比较记录属于单个 HMR 实例；重启 `hmr` 条目本身会重记当前文件，此时待处理变化不再报出。

## 三个设计决定（都有实测依据）

**1. monorepo 而非四个仓**：四家是一套心智系统的四个部件，走同一版本节奏。分散在四个仓时，"这四家能一起用吗"没有单一答案。

**2. 聚合包装载四家，且四家不在 `bundles` 里**。三种形态各验证一次：

| 形态 | 结果 |
|---|---|
| 聚合包不装载四家 | 单独装 = 四家全都不在（`clis_probe` 消失） |
| 聚合包装载 + 四家也在 `bundles` | 双装载，**聚合包自己被挤掉**（user_plugins 14，mind-system 消失） |
| **聚合包装载 + 四家不在 `bundles`** | **唯一入口、零重复**（采用） |

**3. `dsh-mind` → `dsh-agent-mind`**：npm 上 `dsh-mind` 已被他人占用（"心智·数字组织"，维护者 wjthqyj）。目录名未改（profile 的 link 依赖它），只改包名。

## 待办

- [ ] **删两个空壳仓**（`dsh-agent-mind` / `dsh-meta-framework`）：当前 GitHub token 缺 `delete_repo` scope，API 删不了（403）。**在网页上删即可** —— 内容已全部并入 monorepo。
- [ ] **npm 发布**：本轮不发布（需 npm token）。发布前跑 `node packages/dsh-mind-system/scripts/publish-check.mjs`，它验四组：装载点可解析 / 依赖声明完整 / 唯一入口形态 / 版本区间对得上。
- [ ] **CLIS 的同步路径**：`packages/dsh-clis` 放的是**发布产物**（来自 `D:\个人开发\CLIS` 的 `dist-package`）。CLIS 的真正源码在那个独立仓（多包 workspace：`@causal-layers/clis-*`）。改 CLIS 源码后要重新 `bundle.mjs` → `package.mjs` → 同步到 `packages/dsh-clis`。这条链已踩过坑（见「拷贝式打包不重建中间产物」那条法）。

## 发布前的验证命令

```bash
node packages/dsh-mind-system/scripts/publish-check.mjs   # 聚合包发布前检查
node packages/dsh-agent-mind/test/*.test.js               # 调度层 53 例
node packages/dsh-agent-mind/scripts/verify-assembly.mjs   # 真实 cordis 装配验证
```
