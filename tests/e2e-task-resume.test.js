import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// E2E gate: "a goal and its task keep running across a dsh restart."
//
// This exercises the REAL `recover()` path in lib/index.js (the same code the
// plugin runs on boot) against an injectable host-service layer. It asserts the
// two things the restart contract promises:
//   1. the durable GOAL is re-armed (goals.resume), and
//   2. the agent SESSION / TASK that carries the round is re-driven
//      (agentLoop.resume), so the round continues rather than the goal sitting
//      armed with nothing running.
// It also asserts the no-double-load guard and graceful degradation.
//
// `npm test` (`node --test`) discovers this file, so it gates every release.
const tmp = mkdtempSync(join(tmpdir(), 'dsh-phoenix-e2e-'))
const stateFile = join(tmp, 'state.json')
writeFileSync(stateFile, JSON.stringify({ generation: 0, lifecycleState: 'idle', pendingResume: false, goalId: null }))

process.env.DSH_PHOENIX_ARMING_MS = '5'
process.env.DSH_PHOENIX_DEBOUNCE_MS = '5'
process.env.DSH_PHOENIX_DEFER_POLL_MS = '500'
process.env.DSH_PHOENIX_DEFER_SOFT_MS = '600000'
process.env.DSH_PHOENIX_DEFER_HARD_MS = '1200000'
process.env.DSH_PHOENIX_DEFER_POLICY = 'auto'
process.env.DSH_PHOENIX_REARM_MS = '5'
process.env.DSH_PHOENIX_REARM_RETRY_MS = '10'
process.env.DSH_PHOENIX_REARM_FIND_ATTEMPTS = '2'
process.env.DSH_PHOENIX_MAX_RESUME_ATTEMPTS = '1'
process.env.DSH_PHOENIX_STATE_FILE = stateFile
delete process.env.DSH_PHOENIX_RESTART_CMD

const { apply } = await import('../lib/index.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx(services) {
  const listeners = {}
  const provided = {}
  const ctx = {
    get: (k) => services[k],
    provide: (k, v) => { provided[k] = v; return () => { delete provided[k] } },
    on: (ev, fn) => { listeners[ev] = fn },
    effect: (fn) => fn(),
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
    interval: (cb, ms) => { const t = setInterval(cb, ms); if (t && t.unref) t.unref(); return () => clearInterval(t) },
    debounce: (cb, ms) => {
      let timer = null
      const fn = (...a) => { clearTimeout(timer); timer = setTimeout(() => cb(...a), ms) }
      fn.dispose = () => clearTimeout(timer)
      return fn
    },
  }
  return { ctx, listeners, provided }
}

const resetState = (obj) => writeFileSync(stateFile, JSON.stringify(Object.assign(
  { generation: 0, lifecycleState: 'idle', goalId: null, pendingResume: false, resumeAttempt: 0, deferDeadline: 0, updatedAt: 0 },
  obj
)))

// The resumed agent seen by `agentLoop.resume`. Each boot may produce a new one,
// but its id (resumeSessionId) must equal the goal-owning session id.
function bootCtx(overrides = {}) {
  const goalResumes = []
  const taskResumes = []
  const runCalls = []
  const agents = overrides.agents ?? [{ id: 'g1', status: 'idle' }]
  const goal = overrides.goal ?? { id: 'g1', revision: 3, phase: 'active', activation: 'disarmed', maxGoalRounds: 3 }
  const agentLoop = overrides.agentLoop ?? {
    resume: async (ownerCtx, opts) => { taskResumes.push(opts); return { agent: { id: opts.resumeSessionId } } },
    create: async () => ({ agent: { id: 'g1' } }),
  }
  const agentPresets = overrides.agentPresets ?? {
    resolve: async (id) => ({ id }),
    mount: async () => {},
  }
  const sessionPersistence = overrides.sessionPersistence ?? {
    inspect: async (id) => ({ meta: { id, agentPreset: 'cordis', cwd: '/home/stvli/tmp' }, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'cordis' } }] }),
  }
  const services = {
    agents: { list: () => agents, get: (id) => (overrides.liveAgent ? { id } : undefined) },
    goals: { get: () => goal, resume: (agent, ref) => { goalResumes.push(ref); return {} } },
    shell: overrides.shell ?? { resolve: (r) => r, run: async (s) => { runCalls.push(s.command); return { exitCode: 0 } } },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    agentLoop, agentPresets, sessionPersistence,
  }
  const { ctx } = makeCtx(services)
  return { ctx, goalResumes, taskResumes, runCalls }
}

after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* ignore */ } })

// ---------------------------------------------------------------------------
// The restart contract: goal AND task keep running across a restart.
// ---------------------------------------------------------------------------

test('E2E: after a restart, recover() re-arms the goal AND resumes the agent session (task)', async () => {
  // Pre-restart state: an active goal that was disarmed by the reboot edge,
  // with phoenix carrying a pending-resume marker for it.
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  const { ctx, goalResumes, taskResumes } = bootCtx({ liveAgent: false })
  apply(ctx)
  await sleep(25) // arming(5) + recover (async task resume)
  // 1. The durable goal is re-armed for this goal id/revision.
  assert.equal(goalResumes.length, 1, 'goal re-armed exactly once')
  assert.deepEqual(goalResumes[0], { id: 'g1', revision: 3 })
  // 2. The task (agent session owning that goal) is resumed.
  assert.equal(taskResumes.length, 1, 'agent session/task resumed exactly once')
  assert.equal(taskResumes[0].resumeSessionId, 'g1', 'resumes the session that owns the goal')
  assert.equal(typeof taskResumes[0].setup, 'function', 'provides the preset setup for the fresh ctx')
  // 3. Job still in flight: state settles to running and continuation is kept.
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.lifecycleState, 'running')
  assert.equal(final.pendingResume, true, 'continuation is kept so the goal survives the NEXT restart')
  assert.equal(final.goalId, 'g1')
})

test('E2E: a second restart re-resumes the same task (persistent continuation)', async () => {
  // First restart: resume happens, goal stays active + continuation kept.
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  let b = bootCtx({ liveAgent: false })
  apply(b.ctx)
  await sleep(25)
  assert.equal(b.taskResumes.length, 1)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).pendingResume, true)

  // Second restart (new generation): re-drive the task again.
  resetState({ lifecycleState: 'restarting', generation: 8, pendingResume: true, goalId: 'g1' })
  const b2 = bootCtx({ liveAgent: false })
  apply(b2.ctx)
  await sleep(25)
  assert.equal(b2.taskResumes.length, 1, 'second restart resumes the task again (continuation kept)')
  assert.equal(b2.taskResumes[0].resumeSessionId, 'g1')
})

test('E2E: no double-load — skips task resume when the agent session is already live', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  const { ctx, taskResumes } = bootCtx({ liveAgent: true })
  apply(ctx)
  await sleep(25)
  assert.equal(taskResumes.length, 0, 'a live agent must not be re-resumed')
})

test('E2E: goal completed/absent ends the continuation (no infinite re-resume)', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  let goalResumes = 0
  let taskResumes = 0
  const services = {
    agents: { list: () => [{ id: 'g1', status: 'idle' }], get: () => undefined },
    goals: {
      // After the restart the goal is no longer active (e.g. complete) -> no resume.
      get: () => ({ id: 'g1', revision: 3, phase: 'complete', activation: 'disarmed', maxGoalRounds: 3 }),
      resume: () => { goalResumes += 1; return {} },
    },
    shell: { resolve: (r) => r, run: async () => ({ exitCode: 0 }) },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    agentLoop: { resume: async () => { taskResumes += 1; return { agent: { id: 'g1' } } }, create: async () => ({ agent: { id: 'g1' } }) },
    agentPresets: { resolve: async (id) => ({ id }), mount: async () => {} },
    sessionPersistence: { inspect: async (id) => ({ meta: { id, agentPreset: 'cordis' }, events: [] }) },
  }
  const { ctx } = makeCtx(services)
  apply(ctx)
  await sleep(40) // allow the bounded re-scan to exhaust (rearmFindAttempts=2)
  assert.equal(goalResumes, 0, 'a non-active goal must not be resumed')
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.pendingResume, false, 'continuation ended when the goal is no longer resumable')
})

test('E2E: degrades gracefully when the task-resume services are absent (goal still re-armed)', async () => {
  resetState({ lifecycleState: 'restarting', generation: 7, pendingResume: true, goalId: 'g1' })
  const services = {
    agents: { list: () => [{ id: 'g1', status: 'idle' }], get: () => undefined },
    goals: { get: () => ({ id: 'g1', revision: 3, phase: 'active', activation: 'disarmed', maxGoalRounds: 3 }), resume: () => ({}) },
    shell: { resolve: (r) => r, run: async () => ({ exitCode: 0 }) },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    // No agentLoop / agentPresets / sessionPersistence -> task resume unavailable.
  }
  const { ctx } = makeCtx(services)
  apply(ctx)
  await sleep(25)
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.lifecycleState, 'running', 'state settles even when task resume is unavailable')
})
