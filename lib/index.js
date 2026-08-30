import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * dsh-phoenix — a persistent DeepSeek Harness (dsh) host plugin that makes a
 * dsh Web restart safe, seamless, and resumable:
 *
 *   1. Graceful restart  — after a plugin (re)activation, restart dsh only when
 *      no agent is running, so an in-flight task finishes before the reboot.
 *   2. Client reconnect  — a tiny injected heartbeat keeps the browser page
 *      aligned with the backend; when dsh restarts the page reloads itself.
 *   3. Goal re-arm       — after a restart, re-arm a disarmed goal so a
 *      long-running objective resumes instead of stopping.
 */

const CORDIS_TRIGGER = { cordis_run: true } // narrowed: only actual plugin (re)activation
const HEALTH_PATH = '/__dsh_health'

export function clampInt(raw, min, max, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function sanitizeUnit(u) {
  return String(u || '').replace(/[^a-zA-Z0-9_.-]/g, '') || 'dsh-web'
}

// Resolve a command on PATH (relaxes hardcoded /usr/bin and detects systemd
// availability). Returns the absolute path or null.
export function findInPath(cmd) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean)
  for (const d of dirs) {
    const p = join(d, cmd)
    try {
      if (existsSync(p)) return p
    } catch (e) {
      /* ignore */
    }
  }
  return null
}

// The restart provider: an operator-set command overrides the systemd default,
// which is the explicit escape hatch for non-systemd deployments (macOS,
// containers, `pnpm run dev:web`).
export function buildRestartCommand(cfg, bin) {
  if (cfg.restartCmd) return cfg.restartCmd
  const sc = bin.systemctl
  const sl = bin.sleep
  let inner = sc + ' --user stop ' + cfg.unit
  if (cfg.delay > 0) inner += '; ' + sl + ' ' + cfg.delay
  inner += '; ' + sc + ' --user start ' + cfg.unit
  return bin.systemdRun + ' --user --no-block --collect /bin/sh -c ' + JSON.stringify(inner)
}

function resolveBin() {
  const sdr = findInPath('systemd-run')
  const sc = findInPath('systemctl')
  const sl = findInPath('sleep')
  return {
    systemdRun: sdr || 'systemd-run',
    systemctl: sc || 'systemctl',
    sleep: sl || 'sleep',
    systemdAvailable: !!(sdr && sc && sl),
  }
}

// Narrow interface over the (pre-1.0, internal) dsh goal API. Guarded so a
// future shape change fails loudly instead of silently skipping.
function goalsInterfaceUsable(goalsSvc) {
  return !!goalsSvc && typeof goalsSvc.get === 'function' && typeof goalsSvc.resume === 'function'
}

const cfg = {
  unit: sanitizeUnit(process.env.DSH_PHOENIX_UNIT || 'dsh-web'),
  delay: clampInt(process.env.DSH_PHOENIX_DELAY, 0, 300, 8),
  armingMs: clampInt(process.env.DSH_PHOENIX_ARMING_MS, 0, 60000, 5000),
  debounceMs: clampInt(process.env.DSH_PHOENIX_DEBOUNCE_MS, 0, 60000, 3000),
  deferPollMs: clampInt(process.env.DSH_PHOENIX_DEFER_POLL_MS, 500, 60000, 3000),
  deferCapMs: clampInt(process.env.DSH_PHOENIX_DEFER_CAP_MS, 1000, 3600000, 300000),
  healthMs: clampInt(process.env.DSH_PHOENIX_HEALTH_MS, 1000, 60000, 4000),
  stateFile: process.env.DSH_PHOENIX_STATE_FILE || '',
  restartCmd: String(process.env.DSH_PHOENIX_RESTART_CMD || '').trim(),
  maxReArmAttempts: clampInt(process.env.DSH_PHOENIX_MAX_REARM_ATTEMPTS, 1, 100, 20),
  rearmMs: clampInt(process.env.DSH_PHOENIX_REARM_MS, 0, 60000, 8000),
  rearmRetryMs: clampInt(process.env.DSH_PHOENIX_REARM_RETRY_MS, 0, 60000, 5000),
}

// Per-process boot token; changes whenever dsh-web restarts. The injected
// heartbeat compares its loaded token to this and reloads on mismatch.
export const BOOT_TOKEN = String(Date.now()) + '-' + Math.random().toString(36).slice(2)

export function heartbeatScript(token, healthPath, intervalMs) {
  return '<script async>(function(){var last=' + JSON.stringify(token) +
    ';function chk(){fetch(' + JSON.stringify(healthPath) +
    ',{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j&&j.token&&j.token!==last){location.reload()}}).catch(function(){})}setInterval(chk,' +
    intervalMs + '})();</script>'
}

export const name = 'dsh-phoenix'
export const inject = ['timer']

export function apply(ctx) {
  const bin = resolveBin()
  const canRestart = !!(cfg.restartCmd || bin.systemdAvailable)
  if (!canRestart) {
    console.warn('[dsh-phoenix] systemd user services not detected; graceful restart DISABLED. ' +
      'Run dsh as a systemd --user service (e.g. dsh-web.service) or set DSH_PHOENIX_RESTART_CMD to a custom ' +
      'restart command. Client auto-reconnect and goal re-arm still work.')
  }
  console.log('[dsh-phoenix] loaded (graceful restart' + (canRestart ? '' : ' [disabled]') +
    ' + client reconnect' + (cfg.stateFile ? ' + goal re-arm' : '') + ')')
  let armed = false
  ctx.timeout(() => { armed = true }, cfg.armingMs)

  function anyAgentRunning() {
    const agentsSvc = ctx.get('agents')
    if (agentsSvc === undefined) return true // conservative: defer if we cannot tell
    const live = agentsSvc.list()
    for (const a of live) {
      if (a && a.status === 'running') return true
    }
    return false
  }

  function scheduleNow(reason) {
    if (!canRestart) {
      console.warn('[dsh-phoenix] restart skipped (no systemd / no DSH_PHOENIX_RESTART_CMD): ' + reason)
      return
    }
    const cmd = buildRestartCommand(cfg, bin)
    console.log('[dsh-phoenix] scheduling restart (' + reason + '): ' + cmd)
    const shell = ctx.get('shell')
    if (shell === undefined) {
      console.error('[dsh-phoenix] shell unavailable')
      return
    }
    const spec = shell.resolve({ command: cmd })
    shell.run(spec).then((res) => {
      console.log('[dsh-phoenix] restart cmd exit=' + res.exitCode)
    }).catch((e) => {
      console.error('[dsh-phoenix] restart error: ' + String((e && e.message) || e))
    })
  }

  function trigger(reason) {
    if (!armed) {
      console.log('[dsh-phoenix] ignored (arming): ' + reason)
      return
    }
    if (anyAgentRunning()) {
      console.log('[dsh-phoenix] deferring (agent busy): ' + reason)
      const startedAt = Date.now()
      const timer = ctx.interval(() => {
        if (!anyAgentRunning()) {
          timer()
          console.log('[dsh-phoenix] agent idle; executing deferred restart: ' + reason)
          scheduleNow(reason)
        } else if (Date.now() - startedAt > cfg.deferCapMs) {
          timer()
          console.log('[dsh-phoenix] defer cap reached; restarting anyway: ' + reason)
          scheduleNow(reason)
        }
      }, cfg.deferPollMs)
      return
    }
    scheduleNow(reason)
  }

  const debounced = ctx.debounce(() => trigger('plugin-change'), cfg.debounceMs)

  // Plugin (re)activation via the dsh plugin tools needs a dsh reload. Narrowed
  // to cordis_run (an apply op) — define/inspect/undefine do not reboot.
  ctx.on('tools/result', (exec) => {
    const nm = exec && exec.name
    if (nm && CORDIS_TRIGGER[nm]) {
      console.log('[dsh-phoenix] cordis tool: ' + nm)
      debounced()
    }
  })

  // Re-arm a disarmed active goal after a restart, so a long-running objective
  // resumes. Gated on a configured state file; `pendingResume === true` is the
  // "this restart was part of the loop, keep going" signal. Bounded retries, and
  // pendingResume is cleared once consumed (one-shot).
  let reArmAttempts = 0
  function clearPendingResume() {
    try {
      const s = JSON.parse(readFileSync(cfg.stateFile, 'utf8'))
      if (s && s.pendingResume === true) {
        s.pendingResume = false
        writeFileSync(cfg.stateFile, JSON.stringify(s, null, 2))
        console.log('[dsh-phoenix] cleared pendingResume after re-arm')
      }
    } catch (e) {
      /* ignore */
    }
  }
  function reArmLoop() {
    if (!cfg.stateFile) return
    let state = null
    try {
      state = JSON.parse(readFileSync(cfg.stateFile, 'utf8'))
    } catch (e) {
      state = null
    }
    if (!state || state.pendingResume !== true) return
    const agentsSvc = ctx.get('agents')
    const goalsSvc = ctx.get('goals')
    if (!agentsSvc || typeof agentsSvc.list !== 'function' || !goalsInterfaceUsable(goalsSvc)) {
      console.warn('[dsh-phoenix] goal re-arm skipped: agents/goals service interface unavailable or changed ' +
        '(internal dsh API, may need an update)')
      return
    }
    let did = 0
    for (const a of agentsSvc.list()) {
      try {
        const g = goalsSvc.get(a)
        if (!g || typeof g.id !== 'string' || typeof g.revision !== 'number' || !g.phase || !g.activation) {
          console.warn('[dsh-phoenix] unexpected goal view shape; skipping re-arm (internal dsh API)')
          continue
        }
        if (g.phase === 'active' && g.activation === 'disarmed') {
          goalsSvc.resume(a, { id: g.id, revision: g.revision })
          console.log('[dsh-phoenix] re-armed goal after resume (rev=' + g.revision + ')')
          did += 1
        }
      } catch (e) {
        console.error('[dsh-phoenix] re-arm error: ' + String((e && e.message) || e))
      }
    }
    if (did > 0) {
      clearPendingResume()
      return
    }
    reArmAttempts += 1
    if (reArmAttempts < cfg.maxReArmAttempts) {
      ctx.timeout(reArmLoop, cfg.rearmRetryMs)
    } else {
      console.warn('[dsh-phoenix] re-arm gave up after ' + cfg.maxReArmAttempts + ' attempts (no active+disarmed goal found)')
    }
  }
  if (cfg.stateFile) {
    ctx.timeout(() => { reArmLoop() }, cfg.rearmMs)
  }

  // Client auto-reconnect: register the health endpoint and inject a heartbeat
  // script. Best-effort — webServer appears on the web profile; we lazily retry
  // so boot ordering cannot stall the plugin.
  let wsAttempts = 0
  function setupClient() {
    const ws = ctx.get('webServer')
    if (ws === undefined) {
      if (wsAttempts < 40) {
        wsAttempts += 1
        ctx.timeout(setupClient, 2000)
      }
      return
    }
    ctx.effect(() => ws.register({
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ token: BOOT_TOKEN }))
      },
    }))
    ctx.effect(() => ws.tapIndex((html) => {
      const script = heartbeatScript(BOOT_TOKEN, HEALTH_PATH, cfg.healthMs)
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', script + '</body>')
      return html + script
    }))
  }
  setupClient()
}
