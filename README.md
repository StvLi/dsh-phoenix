# 🐦 dsh-phoenix

### Never-interrupt, resumable lifecycle for DeepSeek Harness (dsh)

`dsh-phoenix` is a persistent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that turns **"plugin update → restart dsh"** from a disruptive break into a **graceful, seamless, resumable loop** — so a running task finishes, the browser keeps up, and a long-running objective resumes and keeps evolving across restarts.

<p align="center"><img src="assets/dsh-phoenix-banner.png" alt="dsh-phoenix banner" width="100%"></p>

**English** · [中文版](./README.zh.md)

<p>
  <a href="https://github.com/StvLi/dsh-phoenix"><img alt="GitHub repo" src="https://img.shields.io/github/v/release/StvLi/dsh-phoenix?style=flat-square&label=release"></a>
  <a href="https://www.npmjs.com/package/dsh-phoenix"><img alt="npm" src="https://img.shields.io/npm/v/dsh-phoenix?style=flat-square"></a>
  <a href="https://github.com/StvLi/dsh-phoenix/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/StvLi/dsh-phoenix?style=flat-square"></a>
  <a href="https://github.com/topics/dsh-plugin"><img alt="dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-1f883d?style=flat-square"></a>
  <img alt="language" src="https://img.shields.io/badge/language-JavaScript-7c6cff?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/dependencies-none-2ea44f?style=flat-square">
</p>

---

## Why you need it

DeepSeek Harness is "everything is a plugin," and a dsh Web is a single long-running process managed by *systemd*. That creates three painful realities:

| Pain | What dsh-phoenix does |
| --- | --- |
| Updating a plugin means hard-restarting dsh, **cutting off whatever is running** | **Gracefully restarts** — waits until no agent is turning, so the current task finishes before the reboot. |
| After a backend restart the browser page **drops its connection and freezes** ("stopped") | **Auto-reconnects** — a tiny injected heartbeat reloads the page the moment the backend returns. |
| A restart destroys in-memory goal state, so an objective **cannot continue across restarts** | **Re-arms the goal** — after the reboot it re-activates a disarmed goal so a long-running objective resumes and keeps evolving. |

---

## ✨ Features

### 1. Graceful restart — reboots only when it's safe
- Detects a plugin **(re)activation** through the dsh plugin tools (`cordis_run`) and **does not** restart immediately.
- Checks every live agent (including sub-agents): if any is `running`, it **defers** and re-checks every few seconds, restarting only when the agent goes **idle** (a 5-minute cap prevents a never-restart).
- Runs the restart through `systemd-run --user` as an **independent transient unit**, so even the process being restarted survives until the reboot completes.
- React only to `cordis_run` — client bundle source edits that dsh's own HMR reloads are not `cordis_run` operations, so they do **not** trigger a dsh-phoenix reboot.

### 2. Client auto-reconnect — the page keeps up with the backend
- Registers a `/__dsh_health` endpoint that returns a **per-boot token**.
- Injects a **zero-dependency heartbeat** into the served index: every few seconds it polls `/__dsh_health`; when the token changes (the backend restarted), the page **reloads itself**.
- No more "frozen / stopped" page. Backend restarts become invisible.

### 3. Cross-restart goal re-arm — a task keeps evolving
- Goals are durable (session-log backed), but dsh disarms an active goal on every restart, so automatic continuation stops.
- `dsh-phoenix` reads a **persistent checkpoint** (a JSON state file); when it says `pendingResume: true`, it finds the live agent's *active + disarmed* goal and calls `goals.resume()` to **re-arm** it.
- Re-armed, the harness's goal round driver continues driving the next iteration.

### 🧬 The whole point: a self-evolving loop
Combine the three and you get a **cross-restart autonomous evolution loop** (reproducible steps in [docs/VERIFY.md](docs/VERIFY.md)):

```
read checkpoint → decide next step → test / modify the plugin
  → write checkpoint (pendingResume) → graceful restart
  → dsh boots → dsh-phoenix re-arms the goal → next round … until done
```

The checkpoint is the loop's durable memory; the goal is its driver; the re-arm hook is its resurrection point.

---

## 🆚 How this is different

| Project | Focus | dsh-phoenix adds |
| --- | --- | --- |
| [dsh-doctor](https://github.com/d86e/dsh-doctor) | Self-healing *startup*: recover from plugin-induced boot failures, doctor runs, stuck-turn detection | **Idle-aware graceful restart** (never interrupt a running task), **client auto-reconnect**, **goal continuation** |
| [dsh-daemon](https://github.com/chenkai2/dsh-daemon) | Register dsh web as an auto-start self-healing *background service* | The **resumable, self-evolving lifecycle** on top of the process that's already there |

dsh-doctor and dsh-daemon heal the *launch*; **dsh-phoenix makes the *lifetime* graceful, connected, and resumable.** They are complementary — dsh-phoenix sits comfortably on top of a dsh-daemon-managed process.

---

## 📦 Requirements

> [!WARNING]
> **The graceful-restart feature requires dsh to run as a `systemd --user` service** (default unit `dsh-web`). On other setups — macOS, containers without systemd, or `pnpm run dev:web` — the restart is the one feature that cannot work. On those, either set `DSH_PHOENIX_RESTART_CMD` to a command that restarts your dsh process, or accept that only **client auto-reconnect** and **goal re-arm** are active. The plugin detects this at startup and logs `graceful restart DISABLED` so it never *silently* fails.

- A DeepSeek Harness `dsh` installation whose Web runs as a **systemd --user service** (default unit `dsh-web`).
- Node `>= 22`.
- **Zero external dependencies** — the plugin uses only dsh's own runtime services (`timer`, `webServer`, `agents`, `goals`, `shell`).

---

## 🚀 Installation

`dsh-phoenix` is an official dsh **bundle** (it declares `dsh.bundle`), so it installs with the standard tooling.

**From npm (recommended)**

```sh
dsh plugin --profile <profile> add dsh-phoenix
```

**From git / tarball**

```sh
# git (needs a prepare build + allowBuilds on pnpm >= 10)
dsh plugin --profile <profile> add github:StvLi/dsh-phoenix

# tarball
pnpm pack && dsh plugin --profile <profile> add ./dsh-phoenix-0.1.0.tgz
```

Then verify the layer and start:

```sh
dsh --profile <profile> --dump-config   # expect a "# == dsh-phoenix" layer
dsh --profile <profile>
```

Once installed, the row is injected automatically (see `cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-phoenix
      name: dsh-phoenix
```

---

## ⚙️ Configuration

All knobs are environment variables with safe defaults — no configuration file required.

| Env | Default | Purpose |
| --- | --- | --- |
| `DSH_PHOENIX_UNIT` | `dsh-web` | systemd user unit to restart |
| `DSH_PHOENIX_DELAY` | `8` | seconds between `stop` and `start` |
| `DSH_PHOENIX_ARMING_MS` | `5000` | ignore signals for N ms after load (prevents self-trigger) |
| `DSH_PHOENIX_DEBOUNCE_MS` | `3000` | collapse burst signals into one reboot |
| `DSH_PHOENIX_DEFER_POLL_MS` | `3000` | idle re-check interval while deferring |
| `DSH_PHOENIX_DEFER_CAP_MS` | `300000` | max deferral before forcing a reboot |
| `DSH_PHOENIX_HEALTH_MS` | `4000` | browser heartbeat interval |
| `DSH_PHOENIX_RESTART_CMD` | *(empty)* | custom restart command override for non-systemd deployments (see the Requirements warning) |
| `DSH_PHOENIX_REARM_MS` | `8000` | initial delay before the goal re-arm check |
| `DSH_PHOENIX_REARM_RETRY_MS` | `5000` | re-check interval while waiting for a re-armable goal |
| `DSH_PHOENIX_MAX_REARM_ATTEMPTS` | `20` | cap on re-arm checks before giving up |
| `DSH_PHOENIX_STATE_FILE` | *(empty)* | path to the checkpoint file that enables goal re-arm; empty disables it |

---

## 🧠 How it works

- **Detect** — subscribes to `tools/result` and reacts to a plugin **(re)activation** (`cordis_run`).
- **Defer** — if any agent is `running`, hold the restart and re-check until idle (or the cap).
- **Reboot** — `systemd-run --user` schedules `stop → sleep → start`, decoupled from the dsh cgroup.
- **Reconnect** — the health endpoint + injected heartbeat reload the page when the boot token changes.
- **Resume** — on boot, reads the checkpoint; if `pendingResume`, re-arms the disarmed goal via `goals.resume()`.

Everything logs `[dsh-phoenix]` to the dsh journal for easy inspection.

---

## ✅ Verify it works

The claims in this README are backed by a reproducible checklist in
**[docs/VERIFY.md](docs/VERIFY.md)** and a unit-test suite (`npm test`, 10
tests). Quick start:

```sh
npm test                                  # 10 tests: command build, sanitize, heartbeat, narrow trigger, idle defer, re-arm + one-shot, disabled mode

# after a real plugin update, watch the journal:
journalctl --user -u dsh-web -f | grep dsh-phoenix
# you should see "deferring (agent busy)" then, at idle, "executing deferred restart"
# and, after the reboot, "re-armed goal after resume (rev=N)"
```

`curl http://127.0.0.1:3080/__dsh_health` should return `{"token":"…"}`.

---

## 📄 License

[MIT](./LICENSE) © [Steven P.LI](https://github.com/StvLi)
