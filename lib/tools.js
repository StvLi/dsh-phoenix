/**
 * dsh-phoenix → creation-mode tool plugin.
 *
 * Exposed at the `dsh-phoenix/tools` subpath so an agent preset can mount it as
 * an AGENT-PLANE row: `- id: dsh-phoenix-tools, name: dsh-phoenix/tools`.
 * Because the row lives in a preset's composition (not the host bundle stack),
 * the tools are scoped to that preset's sessions only — in practice the copied
 * `cordis` preset that delivers 创造模式.
 *
 * It depends on the `dsh.phoenix` service that the host bundle's `apply`
 * publishes (graceful restart path, defer policy, durable lifecycle state), and
 * on the `tools` registry. Both are read as optional capabilities; if either is
 * absent (e.g. the bundle is not installed) the plugin contributes nothing
 * instead of failing the session.
 *
 * NOTE: this module deliberately does NOT import `@deepseek-ai/dsh-tools`.
 * When dsh-phoenix is installed as a `link:` dependency the harness's
 * `nodeLinker` does not guarantee that package is reachable from this file, so
 * the tools are built with an inline definition compiler that produces exactly
 * the object `ctx.tools.register(definition)` accepts (a bare tool object:
 * name, description, parameters as JSON Schema, output { schema, render }).
 */
export const name = 'dsh-phoenix-tools'
export const inject = ['dsh.phoenix', 'tools']

// Compile a compact value-schema property map into a JSON Schema object root,
// mirroring the harness's `parameterSchemaSpecToJsonSchema`. Each property is
// `{ type, required?, enum?, description? }`; `required: true` promotes the key.
function parametersToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(spec || {})) {
    const node = { type: String(prop.type || 'string') }
    if (prop.enum !== undefined) node.enum = prop.enum
    if (prop.description !== undefined) node.description = String(prop.description)
    properties[key] = node
    if (prop.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function stateView(phoenix) {
  // Keep only lossless leaf fields — never live internal state objects.
  const s = phoenix.state()
  const c = phoenix.config
  return {
    generation: Number(s.generation) || 0,
    lifecycleState: String(s.lifecycleState || 'idle'),
    goalId: typeof s.goalId === 'string' && s.goalId ? s.goalId : null,
    pendingResume: s.pendingResume === true,
    resumeAttempt: Number(s.resumeAttempt) || 0,
    deferDeadline: Number(s.deferDeadline) || 0,
    updatedAt: Number(s.updatedAt) || 0,
    canRestart: phoenix.canRestart(),
    stateFile: c && c.stateFile ? String(c.stateFile) : '',
    unit: c && c.unit ? String(c.unit) : '',
    deferPolicy: c && c.deferPolicy ? String(c.deferPolicy) : '',
    maxResumeAttempts: c && c.maxResumeAttempts ? c.maxResumeAttempts : 1,
  }
}

function mkTool({ name, description, parameters, execute }) {
  return {
    name,
    description,
    parameters: parametersToJsonSchema(parameters),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    execute,
  }
}

export function apply(ctx) {
  const phoenix = ctx.get('dsh.phoenix')
  const tools = ctx.get('tools')
  if (phoenix === undefined || tools === undefined) return

  const disposers = [
    tools.register(mkTool({
      name: 'dsh_phoenix_state',
      description: 'Read the dsh-phoenix lifecycle state: generation, lifecycle state (idle/deferred/restarting/recovering/running), the marked goal and whether a resume is pending, the defer deadline, and whether a graceful restart is available. Use before restarting to see whether a restart is already in flight.',
      parameters: {},
      execute(_args, _exec) {
        return Promise.resolve({ state: stateView(phoenix) })
      },
    })),

    tools.register(mkTool({
      name: 'dsh_phoenix_restart',
      description: 'Request a graceful dsh restart through dsh-phoenix after a plugin change or to pick up an edit. With force=false (default) it runs the safe idempotent path: if an agent is busy the restart is deferred (and coalesces any in-flight restart) until idle or the safety deadline; pass force=true to schedule the reboot immediately, bypassing the defer. Use reason to note what changed. Does not stop you from finishing the current turn.',
      parameters: {
        reason: {
          type: 'string',
          required: false,
          description: 'Short human-readable reason logged with the restart, e.g. the plugin/package that was updated.',
        },
        force: {
          type: 'boolean',
          required: false,
          description: 'Set true to restart immediately (skip the idle/safety defer). Default false.',
        },
      },
      execute(args, _exec) {
        const reason = (args && args.reason) ? String(args.reason) : 'phoenix-tool'
        const force = !!(args && args.force)
        if (force) return Promise.resolve(phoenix.forceRestart(reason))
        return Promise.resolve(phoenix.requestRestart(reason))
      },
    })),
  ]

  ctx.effect(() => () => disposers.forEach((d) => d()))
}
