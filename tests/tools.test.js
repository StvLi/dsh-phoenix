import { test } from 'node:test'
import assert from 'node:assert/strict'

const toolsMod = await import('../lib/tools.js')
const { name, inject, apply } = toolsMod

// Minimal fake `tools` registry capturing registered definitions.
function fakeTools() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return () => {
        const i = registered.indexOf(definition)
        if (i !== -1) registered.splice(i, 1)
      }
    },
  }
}

function fakePhoenix(overrides = {}) {
  const calls = []
  const phoenix = {
    config: { unit: 'dsh-web', stateFile: '/tmp/x', deferPolicy: 'auto', maxResumeAttempts: 1 },
    state: () => ({ generation: 7, lifecycleState: 'running', goalId: 'goal-1', pendingResume: true, resumeAttempt: 1, deferDeadline: 123, updatedAt: 456 }),
    canRestart: () => true,
    requestRestart: (reason) => { calls.push(['requestRestart', reason]); return { ok: true, reason } },
    forceRestart: (reason) => { calls.push(['forceRestart', reason]); return { ok: true, reason } },
    ...overrides,
  }
  return { phoenix, calls }
}

function makeCtx(services) {
  const ctx = {
    get: (k) => services[k],
    effect: (fn) => fn(),
  }
  return ctx
}

test('tools plugin declares stable name and inject list', () => {
  assert.equal(name, 'dsh-phoenix-tools')
  assert.deepEqual(inject, ['dsh.phoenix', 'tools'])
  assert.equal(typeof apply, 'function')
})

test('apply registers dsh_phoenix_state and dsh_phoenix_restart', () => {
  const tools = fakeTools()
  const { phoenix } = fakePhoenix()
  apply(makeCtx({ 'dsh.phoenix': phoenix, tools }))
  const names = tools.registered.map((t) => t.name).sort()
  assert.deepEqual(names, ['dsh_phoenix_restart', 'dsh_phoenix_state'])
})

test('apply is a no-op when dsh.phoenix service absent', () => {
  const tools = fakeTools()
  apply(makeCtx({ tools }))
  assert.equal(tools.registered.length, 0)
})

test('apply is a no-op when tools registry absent', () => {
  const { phoenix } = fakePhoenix()
  apply(makeCtx({ 'dsh.phoenix': phoenix }))
  // No throw; nothing registered.
  assert.ok(true)
})

test('dsh_phoenix_state returns detached leaf fields', async () => {
  const tools = fakeTools()
  const { phoenix } = fakePhoenix()
  apply(makeCtx({ 'dsh.phoenix': phoenix, tools }))
  const stateTool = tools.registered.find((t) => t.name === 'dsh_phoenix_state')
  const result = await stateTool.execute({}, {})
  assert.equal(result.state.generation, 7)
  assert.equal(result.state.lifecycleState, 'running')
  assert.equal(result.state.goalId, 'goal-1')
  assert.equal(result.state.pendingResume, true)
  assert.equal(result.state.canRestart, true)
  assert.equal(result.state.unit, 'dsh-web')
})

test('dsh_phoenix_restart default (no force) calls requestRestart with reason', async () => {
  const tools = fakeTools()
  const { phoenix, calls } = fakePhoenix()
  apply(makeCtx({ 'dsh.phoenix': phoenix, tools }))
  const restart = tools.registered.find((t) => t.name === 'dsh_phoenix_restart')
  const exec = (args) => restart.execute(args, {})
  let r = await exec({ reason: 'after-plugin-edit' })
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['requestRestart', 'after-plugin-edit'])
  // Default reason when none passed.
  r = await exec({})
  assert.deepEqual(calls[1], ['requestRestart', 'phoenix-tool'])
})

test('dsh_phoenix_restart force=true calls forceRestart', async () => {
  const tools = fakeTools()
  const { phoenix, calls } = fakePhoenix()
  apply(makeCtx({ 'dsh.phoenix': phoenix, tools }))
  const restart = tools.registered.find((t) => t.name === 'dsh_phoenix_restart')
  const r = await restart.execute({ force: true, reason: 'reboot-now' }, {})
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['forceRestart', 'reboot-now'])
})

test('tools expose parameters as JSON Schema object roots', () => {
  const tools = fakeTools()
  const { phoenix } = fakePhoenix()
  apply(makeCtx({ 'dsh.phoenix': phoenix, tools }))
  const restart = tools.registered.find((t) => t.name === 'dsh_phoenix_restart')
  assert.equal(restart.parameters.type, 'object')
  assert.ok(restart.parameters.properties.reason)
  assert.equal(restart.parameters.properties.reason.type, 'string')
  assert.ok(restart.parameters.properties.force)
  assert.equal(restart.output.schema.type, 'object')
  assert.equal(typeof restart.output.render, 'function')
  const state = tools.registered.find((t) => t.name === 'dsh_phoenix_state')
  assert.equal(state.parameters.type, 'object')
  assert.deepEqual(state.parameters.properties, {})
})

test('registered tools are unregistered on effect dispose', () => {
  const tools = fakeTools()
  const { phoenix } = fakePhoenix()
  let disposer
  const ctx = {
    get: (k) => (k === 'dsh.phoenix' ? phoenix : k === 'tools' ? tools : undefined),
    effect: (fn) => { disposer = fn(); return () => {} },
  }
  apply(ctx)
  assert.equal(tools.registered.length, 2)
  disposer()
  assert.equal(tools.registered.length, 0)
})
