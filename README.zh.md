# 🐦 dsh-phoenix

### 为 DeepSeek Harness（dsh）提供"永不中断、可续跑"的生命周期

`dsh-phoenix` 是一个持久的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host 插件，它把 **"插件更新 → 重启 dsh"** 从一次破坏性的中断，变成一条**优雅、无缝、可续跑**的循环——让正在运行的任务能跑完、浏览器能保持连接、长时目标能跨重启继续进化。

<p align="center"><img src="assets/dsh-phoenix-banner.png" alt="dsh-phoenix 宣传图" width="100%"></p>

[English](./README.md) · **中文版**

<p>
  <a href="https://github.com/StvLi/dsh-phoenix"><img alt="GitHub repo" src="https://img.shields.io/github/v/release/StvLi/dsh-phoenix?style=flat-square&label=release"></a>
  <a href="https://www.npmjs.com/package/dsh-phoenix"><img alt="npm" src="https://img.shields.io/npm/v/dsh-phoenix?style=flat-square"></a>
  <a href="https://github.com/StvLi/dsh-phoenix/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/StvLi/dsh-phoenix?style=flat-square"></a>
  <a href="https://github.com/topics/dsh-plugin"><img alt="dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-1f883d?style=flat-square"></a>
  <img alt="language" src="https://img.shields.io/badge/language-JavaScript-7c6cff?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/dependencies-none-2ea44f?style=flat-square">
</p>

---

## 为什么你需要它

DeepSeek Harness 是"一切都是插件"，而 dsh Web 是由 *systemd* 托管的单个常驻进程。这带来三个痛点：

| 痛点 | dsh-phoenix 的做法 |
| --- | --- |
| 更新插件意味着硬重启 dsh，**会切断正在运行的任务** | **优雅重启**——等地步空闲才重启，让当前任务先跑完再重启。 |
| 后端重启后，浏览器页面**掉线并卡死**（"已停止"） | **自动重连**——注入一段极小心跳脚本，后端一恢复页面就自动刷新。 |
| 重启会清空内存中的目标状态，目标**无法跨重启继续** | **重新武装目标**——重启后重新激活一个被解武装的目标，让长时目标恢复并继续进化。 |

---

## ✨ 功能特性

### 1. 优雅重启——只在安全时重启
- 通过 dsh 插件工具识别插件**（重新）激活**（`cordis_run`），**不**立即重启。
- 检查所有活体 agent（含子代理）：只要有 `running`，就**延后**，每隔几秒复查，等地步**空闲**才重启（5 分钟兜底，避免永不重启）。
- 通过 `systemd-run --user` 以**独立瞬时 unit** 执行重启，即使被重启的进程本身也能等到重启完成。
- 只响应 `cordis_run`——dsh 自带 HMR 热载的客户端 bundle 源码改动不属于 `cordis_run` 操作，因此**不会**触发 dsh-phoenix 重启。

### 2. 客户端自动重连——页面始终与后端同步
- 注册一个 `/__dsh_health` 端点，返回**本次启动 token**。
- 向被服务的 index 注入一段**零依赖心跳**：每几秒轮询 `/__dsh_health`；当 token 变化（后端已重启）时，页面**自动 reload**。
- 不再有"卡死 / 已停止"。后端重启变得无感。

### 3. 跨重启目标重新武装——任务继续进化
- 目标由会话日志背书、**持久**，但 dsh 每次重启都会解武装 active 目标，导致自动续跑停止。
- `dsh-phoenix` 读取一个**持久断点**（JSON 状态文件）；当其 `pendingResume: true` 时，找到活体 agent 的 *active + disarmed* 目标并 `goals.resume()` **重新武装**。
- 重新武装后，harness 的目标轮次驱动会继续驱动下一轮迭代。

### 🧬 完整目标：自进化循环
把三者组合起来，就得到一条**跨重启的自主进化闭环**（可复现步骤见 [docs/VERIFY.md](docs/VERIFY.md)）：

```
读断点 → 判断下一步 → 测试 / 修改插件
  → 写断点（pendingResume）→ 优雅重启
  → dsh 启动 → dsh-phoenix 重新武装目标 → 下一轮 … 直到完成
```

断点是循环的持久记忆；目标是它的驱动器；重新武装钩子是它的复活点。

---

## 🆚 与同类项目的差异

| 项目 | 关注点 | dsh-phoenix 的补充 |
| --- | --- | --- |
| [dsh-doctor](https://github.com/d86e/dsh-doctor) | 自愈*启动*：从插件引发的启动失败中恢复、doctor 运行、卡死回合检测 | **等地步空闲的优雅重启**（绝不打断运行中的任务）、**客户端自动重连**、**目标续跑** |
| [dsh-daemon](https://github.com/chenkai2/dsh-daemon) | 把 dsh web 注册为自启动、自愈的*后台服务* | 在已有进程之上叠加**可续跑、自进化**的生命周期 |

dsh-doctor 与 dsh-daemon 是在"救活启动"；**dsh-phoenix 让"生命周期"变得优雅、连接、可续跑。** 它们互补——dsh-phoenix 可以舒服地架在 dsh-daemon 管理的进程之上。

### 互补而非竞争——两个轴，一套防漏的分层

"phoenix" 和 "hot" 常被看作对手——都"围绕插件更新"，都为了让变更生效。这种看法误读了系统。一个 dsh 进程有**两个相互独立的轴**，两家各占其一。

#### 轴 1 · 组合（dsh 由什么构成）
dsh 是一个 Cordis *组合*：由 patch 层 diff 出来的插件行树。它在启动时被加载，但**不是冻结的**——行可以通过 loader 的 diff 机制**当场增/删/换**。dsh 自带的 HMR（`cordis-plugin-hmr`）已经能热载这一层，但它*刻意忽略 `node_modules`*，所以**升级一个已安装的插件包仍需要重启**——这正是 hot 家族要补的缺口。

**hot 家族拥有这条轴。** 当你在 CLI 里 `dsh plugin add/remove/update` 一个 bundle 时，[`dsh-hot-installer`](https://github.com/KYinCode/dsh-hot-installer) 监听 profile 清单（`dsh.profile.bundles`），[`dsh-hot-reload`](https://github.com/stuarthu/dsh-hot-reload) 监听 `pnpm-lock.yaml`。它们驱动的是*与启动完全相同的挂载路径*，只是改为现场执行：解析该包、读它的 `dsh.bundle.patch`、把行注入运行中的树、重新 import 新模块（缓存失效 + 纤维重建）。失败时**回滚**到可用旧版并标记"需要重启"。它们**从不碰进程本身——从不替你重启 dsh。**

#### 轴 2 · 进程生命周期
有些东西**不是**组合里的行，它们活在进程边界：systemd 用户单元与其 cgroup、HTTP/WebSocket 服务、内存中的目标激活、浏览器的实时连接。**这些都无法热换。** 一旦重置跨过它们，诚实的选择就是重启——而**这个重启正是 dsh-phoenix 拥有的那部分。**

dsh-phoenix 把它做得**优雅**（地步空闲——等到没有 agent 在跑）、**连接**（注入心跳在后端启动 token 变化时刷新浏览器）、**可续跑**（重新武装被解武装的目标，长时目标得以继续）。它还通过 `systemd-run --user` 以**脱离的瞬时 unit** 执行重启，被杀的进程永远不会把重启序列一起拖下水。

#### 边界由这两个轴自然得出
二者因**变更路径不同**而不相交，且各是自己所辖轴上"正确的那把工具"：

| 变更路径 | 轴 | 处理方 | dsh-phoenix 是否重启 |
| --- | --- | --- | --- |
| `dsh plugin add/remove/update`（CLI，已安装 bundle） | 组合 | hot 家族 → 现场挂载/重载 | **否** |
| 通过 dsh **cordis 工具**（`cordis_run`）改动插件树 | 组合（运行时、agent 驱动） | dsh-phoenix | **是**，优雅重启 |
| 热换**失败**（import 坏 / `apply` 抛错） | 组合 | hot 家族回滚并**标记**"需要重启" | dsh-phoenix 把这个重启做安全 |

所以不是"谁抢到同一次变更"，而是**源头预防 + 兜住泄漏**：hot 家族在变更入口消除*可避免*的重启；dsh-phoenix 是下面那层，保证*剩下的、真正必要*的重启不会打断任务、不会掉浏览器、不会杀掉进行中的目标。这是经典的分层系统分隔，不是竞争。

> [!NOTE]
> **这是对当前行为的描述，不是保证。** 今天 `dsh-hot-installer` / `dsh-hot-reload` 监听 profile 清单与 lockfile，**不**响应 `cordis_run`；dsh-phoenix 监听 `tools/result`，**不**监听清单。若任一方将来扩大触发范围，请复核此表——边界是行为性的，不是架构性的。

---

## 📦 环境要求

> [!WARNING]
> **优雅重启功能要求 dsh 以 `systemd --user` 服务运行**（默认单元 `dsh-web`）。在其它形态下——macOS、无 systemd 的容器、或 `pnpm run dev:web`——只有重启这一项无法工作。此时要么设置 `DSH_PHOENIX_RESTART_CMD` 指向能重启你 dsh 进程的命令，要么接受只有**客户端自动重连**和**目标重新武装**生效。插件会在启动时检测并打印 `graceful restart DISABLED`，确保它**永不静默失效**。

- 一个 `dsh` 安装，其 Web 以 **systemd --user 服务**运行（默认单元 `dsh-web`）。
- Node `>= 22`。
- **零外部依赖**——只用 dsh 自身的运行时服务（`timer`、`webServer`、`agents`、`goals`、`shell`）。

---

## 🚀 安装

`dsh-phoenix` 是一个官方 dsh **bundle**（声明了 `dsh.bundle`），用标准工具即可安装。

**从 npm（推荐）**

```sh
dsh plugin --profile <profile> add dsh-phoenix
```

**从 git / tarball**

```sh
# git（需 prepare 构建 + pnpm >= 10 的 allowBuilds）
dsh plugin --profile <profile> add github:StvLi/dsh-phoenix

# tarball
pnpm pack && dsh plugin --profile <profile> add ./dsh-phoenix-0.1.0.tgz
```

然后校验该层并启动：

```sh
dsh --profile <profile> --dump-config   # 期待一个 "# == dsh-phoenix" 层
dsh --profile <profile>
```

安装后，插件行会被自动注入（见 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-phoenix
      name: dsh-phoenix
```

---

## ⚙️ 配置

所有参数都是带安全默认值的环境变量——无需配置文件。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_PHOENIX_UNIT` | `dsh-web` | 要重启的 systemd 用户单元 |
| `DSH_PHOENIX_DELAY` | `8` | `stop` 与 `start` 之间的秒数 |
| `DSH_PHOENIX_ARMING_MS` | `5000` | 加载后 N 毫秒内忽略信号（防自触发） |
| `DSH_PHOENIX_DEBOUNCE_MS` | `3000` | 把突发信号合并为一次重启 |
| `DSH_PHOENIX_DEFER_POLL_MS` | `3000` | 延后期间的空闲复查间隔 |
| `DSH_PHOENIX_DEFER_CAP_MS` | `300000` | 延后上限，超时则强制重启 |
| `DSH_PHOENIX_HEALTH_MS` | `4000` | 浏览器心跳间隔 |
| `DSH_PHOENIX_RESTART_CMD` | *(空)* | 非 systemd 部署的自定义重启命令覆盖（见环境要求警告） |
| `DSH_PHOENIX_REARM_MS` | `8000` | 目标重新武装检查的初始延迟 |
| `DSH_PHOENIX_REARM_RETRY_MS` | `5000` | 等待可重新武装目标时的复查间隔 |
| `DSH_PHOENIX_MAX_REARM_ATTEMPTS` | `20` | 重新武装检查的最大次数（超出则放弃） |
| `DSH_PHOENIX_STATE_FILE` | *(空)* | 启用目标重新武装所需的断点文件路径；为空则禁用 |

---

## 🧠 工作原理

- **检测**——订阅 `tools/result`，响应插件**（重新）激活**（`cordis_run`）。
- **延后**——若有 agent `running`，暂缓重启并复查直到空闲（或到上限）。
- **重启**——`systemd-run --user` 调度 `stop → sleep → start`，与 dsh 的 cgroup 解耦。
- **重连**——健康端点 + 注入心跳在启动 token 变化时刷新页面。
- **续跑**——启动时读断点；若 `pendingResume`，则通过 `goals.resume()` 重新武装被解武装的目标。

所有日志都以 `[dsh-phoenix]` 前缀写入 dsh journal，便于排查。

---

## ✅ 如何验证它生效

本 README 中的结论由 **[docs/VERIFY.md](docs/VERIFY.md)** 的可复现清单 + 单测（`npm test`，10 项）支撑。快速开始：

```sh
npm test                                  # 10 项：命令构建、sanitize、心跳、窄触发、空闲延后、re-arm+一次性、禁用模式

# 在真实插件更新后，观察 journal：
journalctl --user -u dsh-web -f | grep dsh-phoenix
# 你会看到 "deferring (agent busy)"，随后在地步空闲时 "executing deferred restart"
# 重启后会看到 "re-armed goal after resume (rev=N)"
```

`curl http://127.0.0.1:3080/__dsh_health` 应返回 `{"token":"…"}`。

---

## 📄 许可证

[MIT](./LICENSE) © [Steven P.LI](https://github.com/StvLi)
