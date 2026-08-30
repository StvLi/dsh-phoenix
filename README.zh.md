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
- 识别真正的插件更新（`cordis_define` / `cordis_run`），**不**立即重启。
- 检查所有活体 agent（含子代理）：只要有 `running`，就**延后**，每 3s 复查，等地步**空闲**才重启（5 分钟兜底，避免永不重启）。
- 通过 `systemd-run --user` 以**独立瞬时 unit** 执行重启，即使被重启的进程本身也能等到重启完成。
- 客户端 bundle 变更交由 dsh 自带的 **HMR 热载**，**刻意不**触发整机重启。

### 2. 客户端自动重连——页面始终与后端同步
- 注册一个 `/__dsh_health` 端点，返回**本次启动 token**。
- 向被服务的 index 注入一段**零依赖心跳**：每几秒轮询 `/__dsh_health`；当 token 变化（后端已重启）时，页面**自动 reload**。
- 不再有"卡死 / 已停止"。后端重启变得无感。

### 3. 跨重启目标重新武装——任务继续进化
- 目标由会话日志背书、**持久**，但 dsh 每次重启都会解武装 active 目标，导致自动续跑停止。
- `dsh-phoenix` 读取一个**持久断点**（JSON 状态文件）；当其 `pendingResume: true` 时，找到活体 agent 的 *active + disarmed* 目标并 `goals.resume()` **重新武装**。
- 重新武装后，harness 的目标轮次驱动会继续驱动下一轮迭代。

### 🧬 完整目标：自进化循环
把三者组合起来，就得到一条**跨重启的自主进化闭环**（已跨多次真实 dsh 重启端到端验证）：

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

---

## 📦 环境要求

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
| `DSH_PHOENIX_STATE_FILE` | *(空)* | 启用目标重新武装所需的断点文件路径；为空则禁用 |

---

## 🧠 工作原理

- **检测**——订阅 `tools/result`，响应 `cordis_define` / `cordis_run`。
- **延后**——若有 agent `running`，暂缓重启并复查直到空闲（或到上限）。
- **重启**——`systemd-run --user` 调度 `stop → sleep → start`，与 dsh 的 cgroup 解耦。
- **重连**——健康端点 + 注入心跳在启动 token 变化时刷新页面。
- **续跑**——启动时读断点；若 `pendingResume`，则通过 `goals.resume()` 重新武装被解武装的目标。

所有日志都以 `[dsh-phoenix]` 前缀写入 dsh journal，便于排查。

---

## ✅ 如何验证它生效

```sh
# 在真实插件更新后，观察 journal：
journalctl --user -u dsh-web -f | grep dsh-phoenix
# 你会看到 "deferring (agent busy)"，随后在地步空闲时 "executing deferred restart"
# 重启后会看到 "re-armed goal after resume (rev=N)"
```

`curl http://127.0.0.1:3080/__dsh_health` 应返回 `{"token":"…"}`。

---

## 📄 许可证

[MIT](./LICENSE) © [Steven P.LI](https://github.com/StvLi)
