import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-phoenix-test-'))
const stateFile = join(tmp, 'state.json')
writeFileSync(stateFile, JSON.stringify({ generation: 0, lifecycleState: 'idle', pendingResume: false }))

process.env.DSH_PHOENIX_ARMING_MS = '5'
process.env.DSH_PHOENIX_DEBOUNCE_MS = '5'
process.env.DSH_PHOENIX_DEFER_POLL_MS = '500'
process.env.DSH_PHOENIX_DEFER_SOFT_MS = '100'
process.env.DSH_PHOENIX_DEFER_HARD_MS = '200'
process.env.DSH_PHOENIX_DEFER_POLICY = 'auto'
process.env.DSH_PHOENIX_REARM_MS = '5'
process.env.DSH_PHOENIX_REARM_RETRY_MS = '10'
process.env.DSH_PHOENIX_REARM_FIND_ATTEMPTS = '2'
process.env.DSH_PHOENIX_MAX_RESUME_ATTEMPTS = '1'
process.env.DSH_PHOENIX_STATE_FILE = stateFile
delete process.env.DSH_PHOENIX_RESTART_CMD

const mod = await import('../lib/index.js')
const {
  apply, defaultState, parseState, requestRestart, reachSafePoint, deferDecision,
  beginRecovery, resumeDecision, markResumeStarted, afterResume, buildRestartCommand,
  sanitizeUnit, heartbeatScript,
} = mod

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx(services) {
  const listeners = {}
  const ctx = {
    get: (k) => services[k],
    on: (ev, fn) => { listeners[ev] = fn },
    effect: (fn) => fn(),
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
    interval: (cb, ms) => { const t = setInterval(cb, ms); return () => clearInterval(t) },
    debounce: (cb, ms) => {
      let timer = null
      const fn = (...a) => { clearTimeout(timer); timer = setTimeout(() => cb(...a), ms) }
      fn.dispose = () => clearTimeout(timer)
      return fn
    },
  }
  return { ctx, listeners }
}

const resetState = (obj) => writeFileSync(stateFile, JSON.stringify(Object.assign({ generation: 0, lifecycleState: 'idle', goalId: null, pendingResume: false, resumeAttempt: 0, deferDeadline: 0, updatedAt: 0 }, obj)))

after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* ignore */ } })

// ---------------------------------------------------------------------------
// Pure state machine — the deterministic core
// ---------------------------------------------------------------------------

test('heartbeatScript: injects valid JS that polls and reloads on token change', () => {
  const html = heartbeatScript('tok', '/__dsh_health', 4000)
  assert.match(html, /\/__dsh_health/)
  assert.match(html, /location\.replace\(/)
  assert.match(html, /setInterval\(chk,/)
  assert.match(html, /var last="tok"/)
  // The browser refuses a malformed script entirely -> heartbeat never runs.
  const js = html.replace(/^<script async>/, '').replace(/<\/script>$/, '')
  assert.doesNotThrow(() => new Function(js), 'injected heartbeat must parse as valid JS')
  const page = '<html><body>hi</body></html>'
  const injected = page.replace('</body>', html + '</body>')
  assert.match(injected, /\/__dsh_health/)
})

test('parseState: valid, malformed, empty all collapse to a usable state', () => {
  const ok = parseState('{"generation":3,"lifecycleState":"restarting","pendingResume":true,"goalId":"g1"}')
  assert.equal(ok.generation, 3)
  assert.equal(ok.lifecycleState, 'restarting')
  assert.equal(ok.pendingResume, true)
  assert.equal(ok.goalId, 'g1')

  const bad = parseState('not json {')
  assert.equal(bad.lifecycleState, 'idle') // no resume from a corrupt checkpoint
  assert.equal(bad.pendingResume, false)
  assert.equal(bad.corrupt, true)

  const badState = parseState('{"lifecycleState":"bogus","pendingResume":true}')
  assert.equal(badState.lifecycleState, 'idle', 'unknown lifecycleState -> idle, never recover')
})

test('requestRestart: idle agent -> restarting, generation bumps, no coalesce', () => {
  const s = requestRestart(defaultState(), { agentBusy: false, now: 1000, deferHardMs: 200 })
  assert.equal(s.lifecycleState, 'restarting')
  assert.equal(s.generation, 1)
  assert.equal(s.coalesced, false)
  assert.equal(s.deferDeadline, 0)
})

test('requestRestart: busy agent -> deferred, deferDeadline set, generation bumps', () => {
  const s = requestRestart(defaultState(), { agentBusy: true, now: 1000, deferHardMs: 200 })
  assert.equal(s.lifecycleState, 'deferred')
  assert.equal(s.generation, 1)
  assert.equal(s.deferDeadline, 1200)
})

test('requestRestart: in-flight cycle coalesces (no second restart, no generation bump)', () => {
  const inFlight = { ...defaultState(), lifecycleState: 'deferred', generation: 1 }
  const s = requestRestart(inFlight, { agentBusy: true, now: 2000, deferHardMs: 200 })
  assert.equal(s.coalesced, true)
  assert.equal(s.generation, 1, 'no generation bump on coalesce')
  const s2 = requestRestart({ ...defaultState(), lifecycleState: 'restarting', generation: 2 }, { agentBusy: false, now: 2000, deferHardMs: 200 })
  assert.equal(s2.coalesced, true)
  assert.equal(s2.generation, 2)
})

test('reachSafePoint: only deferred -> restarting (clears deadline)', () => {
  const d = { ...defaultState(), lifecycleState: 'deferred', deferDeadline: 1200 }
  const r = reachSafePoint(d, { now: 1300 })
  assert.equal(r.lifecycleState, 'restarting')
  assert.equal(r.deferDeadline, 0)
  assert.equal(reachSafePoint({ ...defaultState(), lifecycleState: 'restarting' }, { now: 1300 }).lifecycleState, 'restarting')
})

test('deferDecision: wait -> warn -> force escalation (safety deadline, not unconditional)', () => {
  const d = { ...defaultState(), lifecycleState: 'deferred', deferDeadline: 200 }
  assert.equal(deferDecision(d, { now: 50, softDeadline: 100, hardDeadline: 200, policy: 'auto' }), 'wait')
  assert.equal(deferDecision(d, { now: 120, softDeadline: 100, hardDeadline: 200, policy: 'auto' }), 'warn')
  assert.equal(deferDecision(d, { now: 210, softDeadline: 100, hardDeadline: 200, policy: 'auto' }), 'force')
  // policy wait never forces
  assert.equal(deferDecision(d, { now: 9999, softDeadline: 100, hardDeadline: 200, policy: 'wait' }), 'warn')
})

test('beginRecovery: mid-cycle -> recovering; fresh -> running', () => {
  assert.equal(beginRecovery({ ...defaultState(), lifecycleState: 'restarting' }, { now: 1 }).lifecycleState, 'recovering')
  assert.equal(beginRecovery({ ...defaultState(), lifecycleState: 'recovering' }, { now: 1 }).lifecycleState, 'recovering')
  assert.equal(beginRecovery(defaultState(), { now: 1 }).lifecycleState, 'running')
})

test('resumeDecision: attempt / exhausted / none (at-most-once per generation)', () => {
  const pend = { ...defaultState(), pendingResume: true, resumeAttempt: 0 }
  assert.equal(resumeDecision(pend, { maxResumeAttempts: 1 }).action, 'attempt')
  const used = { ...pend, resumeAttempt: 1 }
  assert.equal(resumeDecision(used, { maxResumeAttempts: 1 }).action, 'exhausted')
  assert.equal(resumeDecision({ ...defaultState(), pendingResume: false }, { maxResumeAttempts: 1 }).action, 'none')
})

test('markResumeStarted + afterResume: one-shot + clear stale pending', () => {
  const pend = { ...defaultState(), pendingResume: true, resumeAttempt: 0, goalId: 'g1' }
  const marked = markResumeStarted(pend, { now: 5 })
  assert.equal(marked.resumeAttempt, 1)
  const done = afterResume(marked, { now: 6 })
  assert.equal(done.lifecycleState, 'running')
  assert.equal(done.pendingResume, false)
  assert.equal(done.goalId, null)
})

test('full cycle state machine: idle -> restarting -> recovering -> running with at-most-once resume', () => {
  let s = defaultState()
  s = requestRestart(s, { agentBusy: false, now: 1, deferHardMs: 200 })
  assert.equal(s.lifecycleState, 'restarting')
  s = beginRecovery(s, { now: 2 })
  assert.equal(s.lifecycleState, 'recovering')
  // pretend the loop wrote a resume request
  s = { ...s, pendingResume: true, goalId: 'g1' }
  const dec = resumeDecision(s, { maxResumeAttempts: 1 })
  assert.equal(dec.action, 'attempt')
  s = markResumeStarted(s, { now: 3 })
  s = afterResume(s, { now: 4 })
  assert.equal(s.lifecycleState, 'running')
  assert.equal(s.pendingResume, false)
})

// ---------------------------------------------------------------------------
// Apply-level I/O wiring (deterministic injection)
// ---------------------------------------------------------------------------

function bootCtx(overrides = {}) {
  const resumeCalls = []
  const runCalls = []
  const agents = overrides.agents ?? [{ status: 'idle' }]
  const goal = overrides.goal ?? { id: 'g1', revision: 3, phase: 'active', activation: 'disarmed' }
  const services = {
    agents: { list: () => agents },
    goals: { get: () => goal, resume: (agent, ref) => { resumeCalls.push(ref); return {} } },
    shell: overrides.shell ?? { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  }
  const { ctx } = makeCtx(services)
  return { ctx, resumeCalls, runCalls }
}

test('recovery: resumes matching disarmed goal once, settles to running, clears pending', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  const { ctx, resumeCalls } = bootCtx()
  apply(ctx)
  await sleep(20)
  assert.equal(resumeCalls.length, 1, 'resume called exactly once')
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.lifecycleState, 'running')
  assert.equal(final.pendingResume, false)
  assert.equal(final.generation, 7)
})

test('recovery: stale goalId -> no resume, settles to running', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'NOT-THERE' })
  const { ctx, resumeCalls } = bootCtx()
  apply(ctx)
  await sleep(20)
  assert.equal(resumeCalls.length, 0, 'stale goalId must not resume')
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.lifecycleState, 'running')
  assert.equal(final.pendingResume, false)
})

test('recovery: resume throws -> still settles to running (no loop)', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  const { ctx, resumeCalls } = bootCtx({
    goals: { get: () => ({ id: 'g1', revision: 3, phase: 'active', activation: 'disarmed' }), resume: () => { throw new Error('boom') } },
  })
  apply(ctx)
  await sleep(20)
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.lifecycleState, 'running')
  assert.equal(final.pendingResume, false, 'no stale pending after failed resume')
})

test('recovery: corrupt/missing checkpoint -> fresh running, no resume', async () => {
  writeFileSync(stateFile, '{corrupt')
  const { ctx, resumeCalls } = bootCtx()
  apply(ctx)
  await sleep(20)
  assert.equal(resumeCalls.length, 0)
})

test('restart command failure -> state reverts to running (not stuck RESTARTING)', async () => {
  resetState({ lifecycleState: 'idle', generation: 0 })
  const runCalls = []
  const { ctx, listeners } = makeCtx({
    agents: { list: () => [{ status: 'idle' }] },
    goals: { get: () => null, resume: () => ({}) },
    shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 5 } } },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  await sleep(20) // arm + boot
  listeners['tools/result']({ name: 'cordis_run' })
  await sleep(30) // debounce + restart attempt (restarting) + async run resolves exit 5 -> revert
  assert.equal(runCalls.length, 1)
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.lifecycleState, 'running', 'on restart failure, revert to running')
  assert.equal(final.pendingResume, false)
})

test('trigger coalescing: second request while deferred schedules no extra restart', async () => {
  resetState({ lifecycleState: 'idle', generation: 0 })
  const agents = [{ status: 'running' }]
  const runCalls = []
  const { ctx, listeners } = makeCtx({
    agents: { list: () => agents },
    goals: { get: () => null, resume: () => ({}) },
    shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  await sleep(20)
  listeners['tools/result']({ name: 'cordis_run' })   // -> deferred (busy)
  await sleep(20)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lifecycleState, 'deferred')
  const genBefore = JSON.parse(readFileSync(stateFile, 'utf8')).generation
  listeners['tools/result']({ name: 'cordis_run' })   // second request -> coalesced
  await sleep(20)
  assert.equal(runCalls.length, 0, 'only one pending restart')
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).generation, genBefore, 'no generation bump on coalesce')
  agents[0].status = 'idle'
  await sleep(600) // defer poll (500ms) -> restart
  assert.equal(runCalls.length, 1, 'exactly one restart after coalesce')
})

test('defer: busy -> deferred, idle -> restart (graceful)', async () => {
  resetState({ lifecycleState: 'idle', generation: 0 })
  const agents = [{ status: 'running' }]
  const runCalls = []
  const { ctx, listeners } = makeCtx({
    agents: { list: () => agents },
    goals: { get: () => null, resume: () => ({}) },
    shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  await sleep(20)
  listeners['tools/result']({ name: 'cordis_run' })
  await sleep(20)
  assert.equal(runCalls.length, 0, 'deferred while busy')
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lifecycleState, 'deferred')
  agents[0].status = 'idle'
  await sleep(600) // defer poll (500ms) sees idle -> restart
  assert.equal(runCalls.length, 1, 'restart once idle')
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lifecycleState, 'restarting')
})

test('no state file: graceful restart still works (in-memory lifecycle)', async () => {
  const prev = process.env.DSH_PHOENIX_STATE_FILE
  process.env.DSH_PHOENIX_STATE_FILE = ''
  const m2 = await import('../lib/index.js?nofile=' + Date.now())
  process.env.DSH_PHOENIX_STATE_FILE = prev
  const runCalls = []
  const { ctx, listeners } = makeCtx({
    agents: { list: () => [{ status: 'idle' }] },
    goals: { get: () => null, resume: () => ({}) },
    shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  m2.apply(ctx)
  await sleep(20)
  listeners['tools/result']({ name: 'cordis_run' })
  await sleep(30)
  assert.equal(runCalls.length, 1, 'graceful restart works even without a state file')
})

test('recovery: waits for a late-registering goal (bounded re-scan, no false stale)', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  let goalReady = false
  const resumeCalls = []
  const { ctx } = makeCtx({
    agents: { list: () => [{ status: 'idle' }] },
    goals: {
      get: () => goalReady ? { id: 'g1', revision: 3, phase: 'active', activation: 'disarmed' } : null,
      resume: (a, ref) => { resumeCalls.push(ref); return {} },
    },
    shell: { resolve: (r) => r, run: async () => ({ exitCode: 0 }) },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  setTimeout(() => { goalReady = true }, 12) // after first find (rearmMs=5) but before the re-scan retry
  await sleep(60)
  assert.equal(resumeCalls.length, 1, 'a goal registered shortly after boot is still resumed (no false stale)')
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lifecycleState, 'running')
})
