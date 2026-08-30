import { readFileSync } from 'node:fs'

/**
 * dsh-phoenix — a persistent DeepSeek Harness (dsh) host plugin that makes a
 * dsh Web restart safe, seamless, and resumable:
 *
 *   1. Graceful restart  — after a plugin update, restart dsh only when no
 *      agent is running, so an in-flight task finishes before the reboot.
 *   2. Client reconnect  — a tiny injected heartbeat keeps the browser page
 *      aligned with the backend; when dsh restarts the page reloads itself.
 *   3. Goal re-arm       — after a restart, re-arm a disarmed goal so a
 *      long-running objective resumes instead of stopping.
 */

const CORDIS_TOOLS = { cordis_define: true, cordis_run: true }
const HEALTH_PATH = '/__dsh_health'

function clampInt(raw, min, max, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

// Env-driven defaults keep the package free of external dependencies and free
// of machine-specific paths, while staying safe for any dsh profile.
const cfg = {
  unit: process.env.DSH_PHOENIX_UNIT || 'dsh-web',
  delay: clampInt(process.env.DSH_PHOENIX_DELAY, 0, 300, 8),
  armingMs: clampInt(process.env.DSH_PHOENIX_ARMING_MS, 0, 60000, 5000),
  debounceMs: clampInt(process.env.DSH_PHOENIX_DEBOUNCE_MS, 0, 60000, 3000),
  deferPollMs: clampInt(process.env.DSH_PHOENIX_DEFER_POLL_MS, 500, 60000, 3000),
  deferCapMs: clampInt(process.env.DSH_PHOENIX_DEFER_CAP_MS, 1000, 3600000, 300000),
  healthMs: clampInt(process.env.DSH_PHOENIX_HEALTH_MS, 1000, 60000, 4000),
  stateFile: process.env.DSH_PHOENIX_STATE_FILE || '',
}

// Per-process boot token; changes whenever dsh-web restarts. The injected
// heartbeat compares its loaded token to this and reloads on mismatch.
const BOOT_TOKEN = String(Date.now()) + '-' + Math.random().toString(36).slice(2)

export const name = 'dsh-phoenix'
export const inject = ['timer']

export function apply(ctx) {
  console.log('[dsh-phoenix] loaded (graceful restart + client reconnect' +
    (cfg.stateFile ? ' + goal re-arm' : '') + ')')
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
    let inner = '/usr/bin/systemctl --user stop ' + cfg.unit
    if (cfg.delay > 0) inner += '; /usr/bin/sleep ' + cfg.delay
    inner += '; /usr/bin/systemctl --user start ' + cfg.unit
    const cmd = '/usr/bin/systemd-run --user --no-block --collect /bin/sh -c ' + JSON.stringify(inner)
    console.log('[dsh-phoenix] scheduling restart (' + reason + '): ' + cmd)
    const shell = ctx.get('shell')
    if (shell === undefined) {
      console.error('[dsh-phoenix] shell unavailable')
      return
    }
    const spec = shell.resolve({ command: cmd })
    shell.run(spec).then((res) => {
      console.log('[dsh-phoenix] systemd-run exit=' + res.exitCode)
    }).catch((e) => {
      console.error('[dsh-phoenix] error: ' + String((e && e.message) || e))
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

  // Host-level plugin updates through the cordis tools need a dsh reload.
  ctx.on('tools/result', (exec) => {
    const nm = exec && exec.name
    if (nm && CORDIS_TOOLS[nm]) {
      console.log('[dsh-phoenix] cordis tool: ' + nm)
      debounced()
    }
  })

  // Re-arm a disarmed active goal after a restart, so a long-running objective
  // resumes. Gated on a configured state file; the file's `pendingResume === true`
  // is the "this restart was part of the loop, keep going" signal.
  if (cfg.stateFile) {
    function reArmLoop() {
      let state = null
      try {
        state = JSON.parse(readFileSync(cfg.stateFile, 'utf8'))
      } catch (e) {
        state = null
      }
      if (!state || state.pendingResume !== true) return
      const agentsSvc = ctx.get('agents')
      const goalsSvc = ctx.get('goals')
      if (!agentsSvc || !goalsSvc) return
      const live = agentsSvc.list()
      let did = 0
      for (const a of live) {
        try {
          const g = goalsSvc.get(a)
          if (g && g.phase === 'active' && g.activation === 'disarmed') {
            goalsSvc.resume(a, { id: g.id, revision: g.revision })
            console.log('[dsh-phoenix] re-armed goal after resume (rev=' + g.revision + ')')
            did += 1
          }
        } catch (e) {
          console.error('[dsh-phoenix] re-arm error: ' + String((e && e.message) || e))
        }
      }
      if (did === 0) ctx.timeout(reArmLoop, 5000)
    }
    ctx.timeout(() => { reArmLoop() }, 8000)
  }

  // Client auto-reconnect: register the health endpoint and inject a heartbeat
  // script. This is best-effort — webServer appears on the web profile, and we
  // lazily retry a handful of times so boot ordering cannot stall the plugin.
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
      const last = JSON.stringify(BOOT_TOKEN)
      const script = '<script async>(function(){var last=' + last + ';function chk(){fetch(' +
        JSON.stringify(HEALTH_PATH) + ',{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j&&j.token&&j.token!==last){location.reload()}}).catch(function(){})}setInterval(chk,' +
        cfg.healthMs + '})();</script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', script + '</body>')
      return html + script
    }))
  }
  setupClient()
}
