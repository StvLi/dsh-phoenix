# Verifying dsh-phoenix

This is a reproducible checklist for confirming dsh-phoenix actually does what it
claims. Everything below is observable from the dsh journal and a couple of HTTP
requests — no debugger needed.

> dsh-phoenix's graceful-restart feature assumes the dsh Web runs as a
> **systemd --user service** (default unit `dsh-web`). On other setups set
> `DSH_PHOENIX_RESTART_CMD` (see README) or only the reconnect/re-arm features
> are active.

## 0. Load check

```sh
# the row is loaded and logs at startup
journalctl --user -u dsh-web -f | grep dsh-phoenix
# expect: [dsh-phoenix] loaded (graceful restart + client reconnect ...)
```

## 1. Client auto-reconnect

```sh
curl -s http://127.0.0.1:3080/__dsh_health
# => {"token":"<boot-token>"}

# the served index carries the injected heartbeat
curl -s http://127.0.0.1:3080/ | grep -o 'var last=' | head -1
```

Restart the backend and watch the token change:

```sh
systemctl --user restart dsh-web
# the browser page reloads itself because the token changed
```

## 2. Graceful restart (idle-aware)

Trigger a real plugin update (e.g. define + run a dynamic plugin via the dsh
plugin tools), then watch the journal:

```sh
journalctl --user -u dsh-web -f | grep dsh-phoenix
```

While an agent is running you should see `deferring (agent busy)`. After the
agent goes idle you should see `agent idle; executing deferred restart` and then
`systemd-run ...` with a `stop → sleep → start` sequence.

## 3. Restart disabled on non-systemd

With no systemd binaries on PATH and no `DSH_PHOENIX_RESTART_CMD` set, the plugin
logs `systemd user services not detected; graceful restart DISABLED` and a
`cordis_run` trigger is skipped (no restart), while reconnect/re-arm still work.

## 4. Cross-restart goal re-arm

1. Create a goal (e.g. `create_goal` with an objective and a round cap).
2. Point `DSH_PHOENIX_STATE_FILE` at a JSON file and set `pendingResume: true`.
3. Restart dsh, then watch the journal:

```sh
journalctl --user -u dsh-web | grep dsh-phoenix
# expect: [dsh-phoenix] re-armed goal after resume (rev=N)
# and the state file's pendingResume is cleared to false (one-shot)
```

The re-armed goal then drives the next round automatically.

## 5. Unit tests

```sh
npm test
# 17 tests covering: state-machine transitions, resume at-most-once per generation,
# stale/corrupt checkpoint, restart coalescing, defer soft/hard escalation,
# restart-command failure, resume failure, restart/resume loop prevention
```
