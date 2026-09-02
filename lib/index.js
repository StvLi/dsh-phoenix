import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * dsh-phoenix — a persistent DeepSeek Harness (dsh) host plugin that makes a
 * dsh Web restart safe, seamless, and resumable:
 *
 *   1. Graceful restart  — after a plugin (re)activation, restart dsh only when
 *      no agent is running, so an in-flight task finishes before the reboot.
 *   2. Client reconnect  — a tiny injected heartbeat keeps the browser page
 *      aligned with the backend; when dsh restarts the page reloads itself.
 *   3. Durable resume    — a lifecycle state machine + goal re-arm, so a
 *      long-running objective resumes (idempotently) across crashes/restarts.
 *
 * The lifecycle is modelled as an explicit, durable state machine written to a
 * JSON state file atomically (`.tmp` + rename). States: idle → deferred →
 * restarting → recovering → running. See README for transitions + invariants.
 */

const CORDIS_TRIGGER = { cordis_run: true } // narrowed: only actual plugin (re)activation
const HEALTH_PATH = '/__dsh_health'
const VALID_STATES = ['idle', 'deferred', 'restarting', 'recovering', 'running']

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

function goalsInterfaceUsable(goalsSvc) {
  return !!goalsSvc && typeof goalsSvc.get === 'function' && typeof goalsSvc.resume === 'function'
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

// ---------------------------------------------------------------------------
// Pure lifecycle state machine (exported for deterministic tests).
// ---------------------------------------------------------------------------

export function defaultState() {
  return {
    generation: 0,
    lifecycleState: 'idle',
    goalId: null,
    pendingResume: false,
    resumeAttempt: 0,
    deferDeadline: 0,
    updatedAt: 0,
  }
}

// Parse + normalise a state file; a missing/corrupt file collapses to a fresh
// "idle" state (with a `corrupt` flag) so a bad checkpoint can never trigger a
// resume or a restore.
export function parseState(text) {
  try {
    const raw = JSON.parse(text)
    return {
      generation: Math.max(0, Number(raw.generation) || 0),
      lifecycleState: VALID_STATES.includes(raw.lifecycleState) ? raw.lifecycleState : 'idle',
      goalId: typeof raw.goalId === 'string' && raw.goalId ? raw.goalId : null,
      pendingResume: raw.pendingResume === true,
      resumeAttempt: Math.max(0, Number(raw.resumeAttempt) || 0),
      deferDeadline: Number(raw.deferDeadline) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch (e) {
    return { ...defaultState(), corrupt: true }
  }
}

// A restart was requested. If a cycle is already in flight (deferred/restarting/
// recovering), COALESCE — no second restart may be scheduled. Otherwise start a
// fresh generation, going to `restarting` (agent idle) or `deferred` (busy).
export function requestRestart(state, { agentBusy, now, deferHardMs }) {
  const inFlight = state.lifecycleState === 'deferred' ||
    state.lifecycleState === 'restarting' ||
    state.lifecycleState === 'recovering'
  if (inFlight) return { ...state, coalesced: true }
  const generation = state.generation + 1
  return {
    ...state,
    generation,
    lifecycleState: agentBusy ? 'deferred' : 'restarting',
    resumeAttempt: 0,
    deferDeadline: agentBusy ? (now + deferHardMs) : 0,
    updatedAt: now,
    coalesced: false,
  }
}

export function reachSafePoint(state, { now }) {
  if (state.lifecycleState !== 'deferred') return state
  return { ...state, lifecycleState: 'restarting', deferDeadline: 0, updatedAt: now }
}

// Safety-deadline escalation: the timeout is a *deadline* not an unconditional
// "restart now". soft => warn (keep waiting); hard+policy!=='wait' => force.
export function deferDecision(state, { now, softDeadline, hardDeadline, policy }) {
  if (state.lifecycleState !== 'deferred') return null
  const hard = policy !== 'wait' && hardDeadline > 0 && now >= hardDeadline
  if (hard) return 'force'
  if (softDeadline > 0 && now >= softDeadline) return 'warn'
  return 'wait'
}

// On boot: if we were mid-cycle, we are RECOVERING; otherwise a clean RUNNING.
export function beginRecovery(state, { now }) {
  const midCycle = state.lifecycleState === 'deferred' ||
    state.lifecycleState === 'restarting' ||
    state.lifecycleState === 'recovering'
  if (!midCycle) return { ...state, lifecycleState: 'running', updatedAt: now }
  return { ...state, lifecycleState: 'recovering', updatedAt: now }
}

// At-most-once per generation: resume is attempted only if pending and not
// already exhausted.
export function resumeDecision(state, { maxResumeAttempts }) {
  if (!state.pendingResume) return { action: 'none' }
  if (state.resumeAttempt >= maxResumeAttempts) return { action: 'exhausted' }
  return { action: 'attempt' }
}

// Increment the attempt counter durably BEFORE the real resume() call, so a
// crash mid-resume cannot make the next boot resume the same goal again.
export function markResumeStarted(state, { now }) {
  return { ...state, resumeAttempt: state.resumeAttempt + 1, updatedAt: now }
}

// Terminal recovery transition: back to RUNNING with no stale pendingResume.
// Settle to RUNNING but KEEP the continuation (goalId + pendingResume): a
// marked goal is re-resumed after each restart while it stays active.
export function afterResume(state, { now }) {
  return {
    ...state,
    lifecycleState: 'running',
    deferDeadline: 0,
    updatedAt: now,
  }
}

// End the continuation (goal completed / blocked / stale / exhausted).
export function endContinuation(state, { now }) {
  return {
    ...state,
    lifecycleState: 'running',
    pendingResume: false,
    goalId: null,
    deferDeadline: 0,
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------

const cfg = {
  unit: sanitizeUnit(process.env.DSH_PHOENIX_UNIT || 'dsh-web'),
  delay: clampInt(process.env.DSH_PHOENIX_DELAY, 0, 300, 8),
  armingMs: clampInt(process.env.DSH_PHOENIX_ARMING_MS, 0, 60000, 5000),
  debounceMs: clampInt(process.env.DSH_PHOENIX_DEBOUNCE_MS, 0, 60000, 3000),
  deferPollMs: clampInt(process.env.DSH_PHOENIX_DEFER_POLL_MS, 500, 60000, 3000),
  deferSoftMs: clampInt(process.env.DSH_PHOENIX_DEFER_SOFT_MS, 0, 3600000, 300000),
  deferHardMs: clampInt(process.env.DSH_PHOENIX_DEFER_HARD_MS, 0, 86400000, 900000),
  deferPolicy: (process.env.DSH_PHOENIX_DEFER_POLICY || 'auto') === 'wait' ? 'wait' : 'auto',
  healthMs: clampInt(process.env.DSH_PHOENIX_HEALTH_MS, 1000, 60000, 4000),
  stateFile: process.env.DSH_PHOENIX_STATE_FILE || '',
  restartCmd: String(process.env.DSH_PHOENIX_RESTART_CMD || '').trim(),
  maxResumeAttempts: clampInt(process.env.DSH_PHOENIX_MAX_RESUME_ATTEMPTS, 1, 100, 1),
  rearmMs: clampInt(process.env.DSH_PHOENIX_REARM_MS, 0, 60000, 8000),
  rearmRetryMs: clampInt(process.env.DSH_PHOENIX_REARM_RETRY_MS, 0, 60000, 5000),
  rearmFindAttempts: clampInt(process.env.DSH_PHOENIX_REARM_FIND_ATTEMPTS, 1, 20, 3),
}

// Per-process boot token; changes whenever dsh-web restarts. The injected
// heartbeat compares its loaded token to this and reloads on mismatch.
export const BOOT_TOKEN = String(Date.now()) + '-' + Math.random().toString(36).slice(2)

export function heartbeatScript(token, healthPath, intervalMs) {
  return '<script async>(function(){var last=' + JSON.stringify(token) +
    ';function chk(){fetch(' + JSON.stringify(healthPath) +
    ',{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j&&j.token&&j.token!==last){location.replace(location.pathname+location.search+(location.search?"&":"?")+"_phoenix="+Date.now())}}).catch(function(){})}chk();setInterval(chk,' +
    intervalMs + ')})();</script>'
}

export const name = 'dsh-phoenix'
export const inject = ['timer']

export function apply(ctx) {
  const bin = resolveBin()
  const canRestart = !!(cfg.restartCmd || bin.systemdAvailable)
  if (!canRestart) {
    console.warn('[dsh-phoenix] systemd user services not detected; graceful restart DISABLED. ' +
      'Run dsh as a systemd --user service (e.g. dsh-web.service) or set DSH_PHOENIX_RESTART_CMD to a custom ' +
      'restart command. Client auto-reconnect and the durable lifecycle still work.')
  }
  console.log('[dsh-phoenix] loaded (graceful restart' + (canRestart ? '' : ' [disabled]') +
    ' + client reconnect' + (cfg.stateFile ? ' + lifecycle' : '') + ')')
  let armed = false
  ctx.timeout(() => { armed = true }, cfg.armingMs)

  // In-memory lifecycle state (used when no state file is configured, so a bare
  // graceful restart still works — only durable recovery/resume needs a file).
  let memState = defaultState()
  const readState = () => {
    if (!cfg.stateFile) return memState
    try {
      return parseState(readFileSync(cfg.stateFile, 'utf8'))
    } catch (e) {
      // A missing file is a fresh start, not corruption.
      try {
        if (!existsSync(cfg.stateFile)) return defaultState()
      } catch (e2) { /* ignore */ }
      return { ...defaultState(), corrupt: true }
    }
  }
  const writeState = (s) => {
    if (!cfg.stateFile) {
      memState = s
      return
    }
    const tmp = cfg.stateFile + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(s, null, 2))
      renameSync(tmp, cfg.stateFile)
    } catch (e) {
      console.error('[dsh-phoenix] state write failed: ' + String((e && e.message) || e))
    }
  }

  function anyAgentRunning() {
    const agentsSvc = ctx.get('agents')
    if (agentsSvc === undefined) return true // conservative: defer if we cannot tell
    const live = agentsSvc.list()
    for (const a of live) {
      if (a && a.status === 'running') return true
    }
    return false
  }

  function scheduleNow(state, reason) {
    if (!canRestart) {
      console.warn('[dsh-phoenix] restart skipped (no systemd / no DSH_PHOENIX_RESTART_CMD): ' + reason)
      writeState({ ...state, lifecycleState: 'running', deferDeadline: 0 })
      return
    }
    const cmd = buildRestartCommand(cfg, bin)
    console.log('[dsh-phoenix] scheduling restart (' + reason + ', gen ' + state.generation + '): ' + cmd)
    const shell = ctx.get('shell')
    if (shell === undefined) {
      console.error('[dsh-phoenix] shell unavailable')
      writeState({ ...state, lifecycleState: 'running', deferDeadline: 0 })
      return
    }
    const spec = shell.resolve({ command: cmd })
    shell.run(spec).then((res) => {
      console.log('[dsh-phoenix] restart cmd exit=' + res.exitCode)
      if (res.exitCode !== 0) {
        console.warn('[dsh-phoenix] restart command FAILED (exit ' + res.exitCode + ') — dsh not restarted; reverting to running')
        writeState({ ...state, lifecycleState: 'running', deferDeadline: 0 })
      }
    }).catch((e) => {
      console.error('[dsh-phoenix] restart error: ' + String((e && e.message) || e))
      writeState({ ...state, lifecycleState: 'running', deferDeadline: 0 })
    })
  }

  function startDeferLoop(initial, reason) {
    let softWarned = false
    const timer = ctx.interval(() => {
      const cur = readState() || initial
      if (!anyAgentRunning()) {
        timer()
        const ns = reachSafePoint(cur, { now: Date.now() })
        writeState(ns)
        console.log('[dsh-phoenix] agent idle; executing deferred restart (gen ' + ns.generation + ')')
        scheduleNow(ns, reason)
        return
      }
      const decision = deferDecision(cur, {
        now: Date.now(),
        // cur.deferDeadline is the epoch hard deadline; the soft deadline is that
        // minus the soft/hard span. Passing durations here (a past bug) made
        // `now >= hardDeadline` always true -> immediate force.
        hardDeadline: cur.deferDeadline,
        softDeadline: cur.deferDeadline - (cfg.deferHardMs - cfg.deferSoftMs),
        policy: cfg.deferPolicy,
      })
      if (decision === 'warn') {
        if (!softWarned) {
          softWarned = true
          console.warn('[dsh-phoenix] soft defer deadline reached; agent still busy — ' +
            'restart will be forced at the hard deadline (policy=' + cfg.deferPolicy + ')')
        }
      } else if (decision === 'force') {
        timer()
        const ns = { ...cur, lifecycleState: 'restarting', deferDeadline: 0, updatedAt: Date.now() }
        writeState(ns)
        console.warn('[dsh-phoenix] HARD defer deadline reached; forcing restart (policy=' + cfg.deferPolicy + '): ' + reason)
        scheduleNow(ns, reason)
      }
    }, cfg.deferPollMs)
  }

  function handleTrigger(reason) {
    if (!armed) {
      console.log('[dsh-phoenix] ignored (arming): ' + reason)
      return
    }
    const st = readState()
    const next = requestRestart(st, { agentBusy: anyAgentRunning(), now: Date.now(), deferHardMs: cfg.deferHardMs })
    writeState(next)
    if (next.coalesced) {
      console.log('[dsh-phoenix] restart already in-flight; coalesced ' + reason)
      return
    }
    console.log('[dsh-phoenix] restart requested (gen ' + next.generation + '): ' + reason)
    if (next.lifecycleState === 'restarting') {
      scheduleNow(next, reason)
    } else {
      startDeferLoop(next, reason)
    }
  }

  const debounced = ctx.debounce(() => handleTrigger('plugin-change'), cfg.debounceMs)
  ctx.on('tools/result', (exec) => {
    const nm = exec && exec.name
    if (nm && CORDIS_TRIGGER[nm]) {
      console.log('[dsh-phoenix] cordis tool: ' + nm)
      debounced()
    }
  })

  // Recovery: on every boot, if a continuation is active (pendingResume + goalId),
  // re-resume the marked goal after each restart while it stays active (at-most-once
  // per restart/generation), and end the continuation when the goal completes or a
  // resume is exhausted/stale — no infinite loop.
  function findGoalInfo(state) {
    const agentsSvc = ctx.get('agents')
    const goalsSvc = ctx.get('goals')
    if (!agentsSvc || typeof agentsSvc.list !== 'function' || !goalsInterfaceUsable(goalsSvc)) {
      console.warn('[dsh-phoenix] agents/goals interface unavailable; cannot resume (internal dsh API)')
      return { status: 'none' }
    }
    let anyDisarmed = null
    for (const a of agentsSvc.list()) {
      let g
      try { g = goalsSvc.get(a) } catch (e) { continue }
      if (!g || typeof g.id !== 'string' || typeof g.revision !== 'number' || !g.phase || !g.activation) continue
      if (state.goalId) {
        if (g.id !== state.goalId) continue
        if (g.phase === 'active' && g.activation === 'disarmed') return { status: 'resume', agent: a, goal: g }
        if (g.phase === 'active') return { status: 'already', agent: a, goal: g }
        return { status: 'done', agent: a, goal: g }
      }
      if (g.phase === 'active' && g.activation === 'disarmed' && !anyDisarmed) {
        anyDisarmed = { status: 'resume', agent: a, goal: g }
      }
    }
    return anyDisarmed || { status: 'none' }
  }

  let recoveryFindAttempts = 0

  // Resume the AGENT SESSION (the "task") that owns the persisted goal. Re-arming
  // the goal (goals.resume) only resumes the durable GOAL marker; the round that
  // was executing lives in the session's agent driver, which dsh-web only
  // recreates on demand (`agents.resume` at the api-proxy). A phoenix restart
  // drops that driver, so without this step the goal is armed but no task runs.
  //
  // Uses only public services; degrades gracefully (logs + returns false) when
  // any is absent or the session is not resumable. Skips when the agent is
  // already live — that means the session was recreated by another path and
  // resuming again would double-load it.
  async function resumeAgentTask(agentId) {
    const agentsSvc = ctx.get('agents')
    const agentLoopSvc = ctx.get('agentLoop')
    const presetsSvc = ctx.get('agentPresets')
    const persistenceSvc = ctx.get('sessionPersistence')
    if (!agentId || !agentsSvc || !agentLoopSvc || !presetsSvc || !persistenceSvc) {
      console.warn('[dsh-phoenix] task resume unavailable (missing agents/agentLoop/agentPresets/sessionPersistence); goal re-armed but the session driver will not be resumed')
      return false
    }
    try {
      if (typeof agentLoopSvc.resume !== 'function') return false
      // A live agent for this id means the session is already running — resume
      // again would duplicate the driver.
      if (agentsSvc.get(agentId) !== undefined) {
        console.log('[dsh-phoenix] task resume skipped (agent ' + agentId + ' already live)')
        return false
      }
      const inspected = await persistenceSvc.inspect(agentId)
      if (inspected === undefined) {
        console.warn('[dsh-phoenix] task resume skipped (session ' + agentId + ' not found in persistence)')
        return false
      }
      // Resolve which agent preset the session was composed from. resolveSessionPreset
      // prefers an `agent-preset/selected` event, then the header's `agentPreset`.
      // We read the header/meta and the events, then ask the agentPresets registry.
      const presetId = (inspected.meta && inspected.meta.agentPreset) ||
        (await sessionPresetFromEvents(presetsSvc, inspected.events))
      const resolvedId = presetId ? (await presetsSvc.resolve(presetId)).id : undefined
      // Mirror the api-proxy composeAgent: mount the preset into the fresh ctx.
      const setup = async (agentCtx) => {
        if (resolvedId) await presetsSvc.mount(agentCtx, resolvedId)
      }
      await agentLoopSvc.resume(ctx, { resumeSessionId: agentId, setup })
      console.log('[dsh-phoenix] task resumed (agent session ' + agentId + (resolvedId ? ', preset ' + resolvedId : '') + ')')
      return true
    } catch (e) {
      console.error('[dsh-phoenix] task resume error: ' + String((e && e.message) || e))
      return false
    }
  }

  // Best-effort derivation of a session's preset id from its persisted events,
  // so we don't need a hard import of `resolveSessionPreset`. Reads the
  // `agent-preset/selected` event the session log records. Returns undefined when
  // no such event is present.
  async function sessionPresetFromEvents(presetsSvc, events) {
    if (!Array.isArray(events)) return undefined
    // The last `agent-preset/selected` wins (mirrors resolveSessionPreset).
    let chosen
    for (const ev of events) {
      if (ev && ev.type === 'agent-preset/selected' && ev.data && typeof ev.data.agentPreset === 'string') {
        chosen = ev.data.agentPreset
      }
    }
    return chosen
  }

  function recover() {
    const st = readState()
    const boot = beginRecovery(st, { now: Date.now() })
    writeState(boot)
    if (boot.pendingResume !== true) {
      writeState({ ...boot, lifecycleState: 'running', updatedAt: Date.now() })
      return
    }
    const info = findGoalInfo(boot)
    if (info.status === 'already') {
      writeState(afterResume(boot, { now: Date.now() }))
      console.log('[dsh-phoenix] continuation kept (goal ' + info.goal.id + ' active/armed); state=running')
      return
    }
    if (info.status === 'done' || info.status === 'none') {
      recoveryFindAttempts += 1
      if (recoveryFindAttempts < cfg.rearmFindAttempts) {
        console.log('[dsh-phoenix] continuation goal not active yet; re-checking in ' + cfg.rearmRetryMs + 'ms (attempt ' + recoveryFindAttempts + '/' + cfg.rearmFindAttempts + ')')
        ctx.timeout(() => recover(), cfg.rearmRetryMs)
        return
      }
      writeState(endContinuation(boot, { now: Date.now() }))
      console.warn('[dsh-phoenix] continuation ended: goal not resumable (complete/blocked/stale)')
      return
    }
    // status === 'resume' (disarmed + active)
    if (boot.resumeAttempt >= cfg.maxResumeAttempts) {
      writeState(endContinuation(boot, { now: Date.now() }))
      console.warn('[dsh-phoenix] resume exhausted (attempts=' + boot.resumeAttempt + '); continuation ended (loop prevented)')
      return
    }
    const marked = markResumeStarted(boot, { now: Date.now() })
    writeState(marked)
    let ok = true
    try {
      ctx.get('goals').resume(info.agent, { id: info.goal.id, revision: info.goal.revision })
      console.log('[dsh-phoenix] resumed goal ' + info.goal.id + ' (rev ' + info.goal.revision + ', attempt ' + marked.resumeAttempt + ')')
    } catch (e) {
      ok = false
      console.error('[dsh-phoenix] resume error: ' + String((e && e.message) || e))
    }
    // Settle the DURABLE state machine FIRST (idle -> recovering -> running)
    // before any async work, so a concurrent re-scan cannot read a stale
    // mid-recovery state and race it (an `await` here would let a second
    // recover() interleave and prematurely end the continuation).
    const ns = afterResume(marked, { now: Date.now() })
    writeState(ns)
    console.log('[dsh-phoenix] recovery complete (gen ' + ns.generation + ', state=running, resume=' + (ok ? 'ok' : 'failed') + ', continuation kept)')
    // Resume the AGENT SESSION (the task) that owns the goal AFTER the state
    // machine has settled. Re-arming the goal (_goals.resume_) only re-arms the
    // durable GOAL marker; the round lived in the session's agent driver, which
    // phoenix's restart dropped. Fire-and-forget so it never blocks the state
    // machine or races a re-scan; its result is logged, never load-bearing.
    if (ok) {
      void resumeAgentTask(info.agent.id).then((taskOk) => {
        console.log('[dsh-phoenix] task resume=' + (taskOk ? 'ok' : 'skipped'))
      })
    }
  }
  if (cfg.stateFile) {
    ctx.timeout(() => { recover() }, cfg.rearmMs)
  }

  // Control handle: publish a `dsh.phoenix` service so the agent-plane tool
  // plugin (lib/tools.js, subpath `dsh-phoenix/tools`) can read lifecycle state
  // and request a restart from the model directly. Read-only knowledge plus a
  // single idempotent trigger; the grace/defer/coalesce policy stays here.
  ctx.provide('dsh.phoenix', {
    config: {
      unit: cfg.unit,
      stateFile: cfg.stateFile,
      canRestart,
      deferPolicy: cfg.deferPolicy,
      deferHardMs: cfg.deferHardMs,
      maxResumeAttempts: cfg.maxResumeAttempts,
    },
    state: () => readState(),
    canRestart: () => canRestart,
    // Idempotent: reuse the same coalescing/arming path as a plugin change.
    requestRestart: (reason) => handleTrigger(String(reason || 'phoenix-tool')),
    // Bypass the defer (used when the caller explicitly wants the reboot now).
    forceRestart: (reason) => {
      if (!armed) return { ok: false, error: 'not armed' }
      const st = readState()
      let ns = requestRestart(st, { agentBusy: false, now: Date.now(), deferHardMs: cfg.deferHardMs })
      if (ns.coalesced) {
        // Already in-flight (deferred/restarting/recovering): force the deadline
        // by landing on `restarting` and scheduling immediately.
        ns = { ...ns, lifecycleState: 'restarting', deferDeadline: 0, updatedAt: Date.now() }
      }
      writeState(ns)
      if (ns.lifecycleState === 'restarting') {
        scheduleNow(ns, String(reason || 'phoenix-tool(force)'))
        return { ok: true, reason: String(reason || 'force'), generation: ns.generation }
      }
      return { ok: false, error: 'restart not scheduled' }
    },
  })

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
