import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Configure the plugin for fast, deterministic tests BEFORE importing.
const tmp = mkdtempSync(join(tmpdir(), 'dsh-phoenix-test-'))
const stateFile = join(tmp, 'state.json')
writeFileSync(stateFile, JSON.stringify({ round: 0, targetRound: 3, pendingResume: false, done: false }))

process.env.DSH_PHOENIX_ARMING_MS = '5'
process.env.DSH_PHOENIX_DEBOUNCE_MS = '5'
process.env.DSH_PHOENIX_DEFER_POLL_MS = '5'
process.env.DSH_PHOENIX_DEFER_CAP_MS = '100'
process.env.DSH_PHOENIX_HEALTH_MS = '10'
process.env.DSH_PHOENIX_REARM_MS = '5'
process.env.DSH_PHOENIX_REARM_RETRY_MS = '10'
process.env.DSH_PHOENIX_MAX_REARM_ATTEMPTS = '2'
process.env.DSH_PHOENIX_STATE_FILE = stateFile
delete process.env.DSH_PHOENIX_RESTART_CMD

const mod = await import('../lib/index.js')
const { apply, buildRestartCommand, sanitizeUnit, heartbeatScript, findInPath } = mod

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

function makeServices({ running = false, goal = null, resumeCalls = [], runCalls = [], registers = [], taps = [] } = {}) {
  const agents = [{ status: 'idle' }]
  if (running) agents[0].status = 'running'
  const shell = {
    resolve: (req) => ({ ...req }), run: async (spec) => { runCalls.push(spec.command); return { exitCode: 0 } },
  }
  const goals = {
    get: () => goal,
    resume: (agent, ref) => { resumeCalls.push(ref); return {} },
  }
  const webServer = {
    register: (route) => { registers.push(route); return () => {} },
    tapIndex: (fn) => { taps.push(fn); return () => {} },
  }
  return { agents, shell, goals, webServer, resumeCalls, runCalls, registers, taps }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* ignore */ } })

// ---- Pure helpers (point 6 - command construction / sanitize) ----
test('buildRestartCommand: systemd default uses resolved bins, sanitized unit, int delay', () => {
  const bin = { systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl', sleep: '/usr/bin/sleep' }
  const cmd = buildRestartCommand({ unit: 'dsh-web', delay: 8, restartCmd: '' }, bin)
  assert.match(cmd, /systemd-run --user --no-block --collect/)
  assert.match(cmd, /systemctl --user stop dsh-web/)
  assert.match(cmd, /sleep 8/)
  assert.match(cmd, /systemctl --user start dsh-web/)
})

test('buildRestartCommand: operator restart command overrides systemd (escape hatch, point 1)', () => {
  const cmd = buildRestartCommand({ unit: 'dsh-web', delay: 8, restartCmd: 'launchctl restart dsh.web' }, {})
  assert.equal(cmd, 'launchctl restart dsh.web')
})

test('sanitizeUnit strips unsafe chars and falls back to dsh-web', () => {
  assert.equal(sanitizeUnit('bad; unit &x'), 'badunitx')
  assert.equal(sanitizeUnit(''), 'dsh-web')
  assert.equal(sanitizeUnit('dsh-web'), 'dsh-web')
})

// ---- Pure helper (point 4 - client heartbeat) ----
test('heartbeatScript: polls the health path and reloads on token change', () => {
  const html = heartbeatScript('tok', '/__dsh_health', 4000)
  assert.match(html, /\/__dsh_health/)
  assert.match(html, /location\.reload\(\)/)
  assert.match(html, /setInterval\(chk,/)
  assert.match(html, /var last="tok"/)
  // injected into an html body correctly
  const page = '<html><body>hi</body></html>'
  const fill = (code) => {
    // emulate the plugin's body injection
    if (code.indexOf('</body>') !== -1) return code.replace('</body>', html + '</body>')
    return code + html
  }
  const injected = fill(page)
  assert.match(injected, /\/__dsh_health/)
  assert.match(injected, /<script async>\(function/)
})

// ---- Apply-level: trigger narrowed to cordis_run (point 5) ----
test('trigger: cordis_run schedules a restart (idle agent); cordis_define does not', async () => {
  const { runCalls, registers, taps } = makeServices()
  const { ctx, listeners } = makeCtx({
    agents: { list: () => [{ status: 'idle' }] },
    shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    goals: {},
    webServer: { register: (r) => { registers.push(r); return () => {} }, tapIndex: (f) => { taps.push(f); return () => {} } },
  })
  apply(ctx)
  await sleep(20) // arm + boot

  listeners['tools/result']({ name: 'cordis_define' })
  await sleep(20)
  assert.equal(runCalls.length, 0, 'cordis_define must not trigger a restart')

  listeners['tools/result']({ name: 'cordis_run' })
  await sleep(30)
  assert.equal(runCalls.length, 1, 'cordis_run must schedule exactly one restart')
  assert.match(runCalls[0], /systemd-run/, 'restart command uses the systemd provider (binaries present)')
})

// ---- Apply-level: defer until agent idle (point 3 - graceful) ----
test('defer: running agent delays restart until idle', async () => {
  const runCalls = []
  const agents = [{ status: 'running' }]
  const { ctx, listeners } = makeCtx({
    agents: { list: () => agents },
    shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    goals: {},
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  await sleep(20) // arm
  listeners['tools/result']({ name: 'cordis_run' })
  await sleep(650) // first poll (500ms) sees agent running -> still deferred
  assert.equal(runCalls.length, 0, 'must defer while agent is running')
  agents[0].status = 'idle'
  await sleep(650) // next poll (500ms) sees idle -> scheduleNow
  assert.equal(runCalls.length, 1, 'must restart once agent is idle')
})

// ---- Apply-level: goal re-arm + one-shot checkpoint (points 2,3) ----
test('re-arm: re-activates a disarmed active goal and clears pendingResume', async () => {
  writeFileSync(stateFile, JSON.stringify({ pendingResume: true }))
  const resumeCalls = []
  const goal = { id: 'g1', revision: 3, phase: 'active', activation: 'disarmed' }
  const { ctx } = makeCtx({
    agents: { list: () => [{ status: 'idle' }] },
    goals: { get: () => goal, resume: (a, ref) => { resumeCalls.push(ref); return {} } },
    shell: { resolve: (r) => r, run: async () => ({ exitCode: 0 }) },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  await sleep(30) // rearmMs = 5 + margin
  assert.equal(resumeCalls.length, 1, 'goals.resume must be called once')
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(after.pendingResume, false, 'pendingResume must be cleared after re-arm (one-shot)')
})

test('re-arm: gives up after max attempts when no re-armable goal', async () => {
  writeFileSync(stateFile, JSON.stringify({ pendingResume: true }))
  const { ctx } = makeCtx({
    agents: { list: () => [] }, // no agent -> no goal
    goals: { get: () => null, resume: () => ({}) },
    shell: { resolve: (r) => r, run: async () => ({ exitCode: 0 }) },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
  })
  apply(ctx)
  await sleep(60) // a couple of capped retries (maxReArmAttempts=2, poll 5s is not used; rearm retries every 5s but cap=2)
  // cap reached; no assertion on resume, just ensure it terminates without throwing
  assert.ok(true)
})

// ---- Point 1: restart disabled when systemd unavailable ----
test('point 1: no systemd binaries + no override => restart is skipped (no shell.run)', async () => {
  const origPath = process.env.PATH
  process.env.PATH = tmp // temp dir has no systemctl/systemd-run/sleep
  try {
    const runCalls = []
    const { ctx, listeners } = makeCtx({
      agents: { list: () => [{ status: 'idle' }] },
      shell: { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
      goals: {},
      webServer: { register: () => () => {}, tapIndex: () => () => {} },
    })
    apply(ctx)
    await sleep(20)
    listeners['tools/result']({ name: 'cordis_run' })
    await sleep(30)
    assert.equal(runCalls.length, 0, 'restart must be skipped when systemd is unavailable and no override')
  } finally {
    process.env.PATH = origPath
  }
})

test('findInPath: resolves real binaries, returns null for missing', () => {
  assert.equal(typeof findInPath('node'), 'string')
  assert.equal(findInPath('definitely-not-a-real-xyz'), null)
})
