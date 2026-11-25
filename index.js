/**
 * run_code_itself: expose the complete run_code tool-call arguments to the
 * program as a preset variable, so structured payloads never have to be
 * escaped into the code string.
 * @module
 */
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'run-code-itself'

/** Host services the executor and the per-agent installation depend on. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime', 'agents']

/** Plugin configuration: limits forwarded to the per-agent PTC executor. */
export const Config = z.object({
  maxSubCallsPerMinute: z.natural().min(1).description(
    'Nested tool-call attempts per minute of run_code timeout for this executor; inherits the replaced PTC executor when omitted.',
  ),
  maxParallelSubCalls: z.natural().min(1).description(
    'Maximum overlapping concurrency-safe program subcalls for this executor; inherits the replaced PTC executor when omitted.',
  ),
})

/** The program-visible preset variable. */
export const RUN_CODE_ITSELF = 'run_code_itself'

/** Backtick, kept as a code point so this file needs no template literals. */
const TICK = '\x60'
const q = (text) => TICK + text + TICK

/** Note placed at the end of the description, next to the parameter schema. */
const EXTRA_FIELDS_NOTE = (
  'The parameter schema sets @additionalProperties: true@: extra sibling fields are allowed. '
  + 'Prefer them for subtool arguments and escape-prone data, regardless of payload size — writing JSON directly in a sibling field avoids the escaping burden.'
).replaceAll('@', TICK)

/** Model-facing contract for extra arguments, appended after the base description. */
export const GUIDANCE = [
  '**Passing data and subtool arguments**',
  '',
  'The complete arguments object of this @run_code@ call is available inside the program as @run_code_itself@. Any extra sibling fields you add to the JSON arguments become parsed JavaScript values on @run_code_itself.<field>@.',
  '',
  '**Put in extra sibling fields**',
  '',
  '- **Subtool argument objects**: pass the whole object as a sibling field and forward it — @await tools.bash(run_code_itself.bash)@, @await tools.read(run_code_itself.read)@. Do this for every subtool call, regardless of payload size.',
  '- **Escape-prone or structured data**: multi-line text, regex with backslashes, paths, JSON arrays and objects, templates. Values are ordinary JSON values in the same call object, not stringified JSON.',
  '',
  '**Keep in @code@ directly**',
  '',
  '- Control flow, loop bounds, simple numbers, short status strings, and inline logic (@for (let i = 0; i < 3; i++)@, @status === "ok"@).',
  '',
  'Why this is easier than inlining: inside @code@, a payload needs a JavaScript literal and then a second escaping layer for the @code@ string. A sibling field has only the outer JSON layer, and the program receives the parsed value directly. Do not call @JSON.parse@ on extra fields; do not declare @run_code_itself@.',
  '',
  '**Good — subtool arguments in a sibling field:**',
  '',
  '@@@json',
  '',
  '{"code":"const res = await tools.bash(run_code_itself.bash); return res.stdout.text;","description":"Read the last app log lines","bash":{"command":"tail -n 5 /var/log/app.log"}}',
  '',
  '@@@',
  '',
  '**Good — data used by code:**',
  '',
  '@@@json',
  '',
  '{"code":"const { rows, regex } = run_code_itself; return rows.filter(row => new RegExp(regex).test(row.id));","description":"Filter rows by id pattern","regex":"[0-9]{3}-[0-9]{4}","rows":[{"id":"AB-123-4567"},{"id":"ZZ-9999"}]}',
  '',
  '@@@',
  '',
  '**Metaprogramming**',
  '',
  '@run_code_itself.code@ is the exact source of this program. A program can read it, split it at its own markers, or @eval@ a piece to generate code from a template. Extra fields are the easiest place to carry the template or its data.',
  '',
  'Example — data in extra fields, code generated and evaluated at runtime:',
  '',
  '@@@json',
  '',
  '{"code":"const t = run_code_itself.template; return await eval(t)","description":"Evaluate a code template with data from extra fields","rows":[{"id":"AB-123-4567"},{"id":"ZZ-9999"}],"regex":"[0-9]{3}-[0-9]{4}","template":"(async () => run_code_itself.rows.filter(row => new RegExp(run_code_itself.regex).test(row.id)))()"}',
  '',
  '@@@',
].join('\n').replaceAll('@', TICK)

/** True for the argument object shape a JSON tool call can produce. */
function isObjectRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the one declaration that binds the program variable to the exact
 * arguments the model passed. The JSON text is valid JavaScript except for the
 * two line-separator code points, and object literals would give a __proto__
 * key prototype semantics, so that rare shape round-trips through JSON.parse.
 * @param payload - the parsed run_code arguments.
 * @returns one 'const run_code_itself = <literal>;' line.
 */
export function declarationFor(payload) {
  const json = JSON.stringify(payload)
  const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const literal = safe.includes('"__proto__"') ? 'JSON.parse(' + JSON.stringify(safe) + ')' : safe
  return 'const ' + RUN_CODE_ITSELF + ' = ' + literal + ';'
}

/**
 * The run_code transport with the injected arguments declaration. Everything
 * else (validation, presentation, live schema getters, output rendering) stays
 * owned by the wrapped transport.
 */
export class RunCodeItselfExecutor extends PtcExecutor {
  #transport

  /**
   * Wrap the reserved transport once. The base class caches the original in
   * ptcTransport, so the Proxy and its target stay one object for the life of
   * this executor.
   * @returns the transport proxy handed to schema projection and dispatch.
   */
  requirePtcTransport() {
    const original = super.requirePtcTransport()
    if (this.#transport !== undefined && this.#transport.original === original) return this.#transport.proxy
    const proxy = new Proxy(original, {
      get: (target, property, receiver) => property === 'execute'
        ? (args, exec) => this.#execute(target, args, exec)
        : Reflect.get(target, property, receiver),
    })
    this.#transport = { original, proxy }
    return proxy
  }

  /**
   * Keep the model-facing schema and add the extra-argument contract.
   * @param tools - visible capability definitions, unused by the PTC transport.
   * @returns the single run_code schema with open parameters.
   */
  describe(tools) {
    const description = super.describe(tools)
    return {
      ...description,
      schemas: description.schemas.map(schema => {
        if (schema.name !== RUN_CODE_NAME || !isObjectRecord(schema.parameters)) return schema
        const parameters = schema.parameters
        const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
        const code = isObjectRecord(properties.code) ? properties.code : undefined
        return {
          ...schema,
          description: schema.description + '\n\n' + EXTRA_FIELDS_NOTE + '\n\n' + GUIDANCE,
          parameters: {
            ...parameters,
            additionalProperties: true,
            properties: {
              ...properties,
              ...code === undefined ? {} : {
                code: {
                  ...code,
                  description: (typeof code.description === 'string' ? code.description + ' ' : '')
                    + 'Program logic only: put subtool argument objects and escape-prone data in extra sibling fields and read them from run_code_itself. '
                    + 'Inside the program, run_code_itself.code is this exact source text, so the program can inspect or eval it for metaprogramming.',
                },
              },
            },
          },
        }
      }),
    }
  }

  /**
   * Prepend the declaration, then hand the derived arguments to the transport.
   * @param transport - the unwrapped run_code definition.
   * @param args - parsed model arguments, possibly with extra fields.
   * @param exec - the tool run context.
   * @returns the transport result.
   */
  async #execute(transport, args, exec) {
    if (!isObjectRecord(args) || typeof args.code !== 'string') return transport.execute(args, exec)
    return transport.execute({ ...args, code: declarationFor(args) + '\n' + args.code }, exec)
  }
}

/** Cross-generation brand so a reloaded plugin never stacks a second executor. */
const ENHANCED = Symbol.for('dsh-run-code-itself/enhanced')
Object.defineProperty(RunCodeItselfExecutor.prototype, ENHANCED, { value: true })

/** Whether a selected executor is a PTC executor this plugin can extend. */
function isPtcExecutor(executor) {
  return executor instanceof PtcExecutor
    || (typeof executor?.requirePtcTransport === 'function' && typeof executor?.describe === 'function')
}

/** Merge plugin overrides with the limits of the executor being replaced. */
function executorConfig(settings, inherited) {
  const config = {}
  const maxSubCalls = settings.maxSubCallsPerMinute ?? inherited.maxSubCallsPerMinute
  const maxParallel = settings.maxParallelSubCalls ?? inherited.maxParallelSubCalls
  if (maxSubCalls !== undefined) config.maxSubCallsPerMinute = maxSubCalls
  if (maxParallel !== undefined) config.maxParallelSubCalls = maxParallel
  return config
}

/**
 * Select the enhanced executor for the mounting scope. A preset-scoped mount is
 * a drop-in replacement for dsh-tool-executor-ptc; a Host-scoped mount installs
 * an agent-scoped executor on every agent that would otherwise use the mounted
 * PTC executor, so presets, other agents, and the native executor stay untouched.
 * @param ctx - mounting context: a preset scope or the Host.
 * @param config - optional executor limits.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  ctx.logger.info('run-code-itself: active')
  const select = ctx.tools.selectExecutor
  if (typeof select !== 'function' || typeof PtcExecutor.prototype.requirePtcTransport !== 'function') {
    ctx.logger.warn('run-code-itself: this DSH version changed its executor internals; the plugin stays inactive')
    return
  }
  // Mounted inside a preset: this row replaces the stock PTC executor in that
  // preset, so register the enhanced executor in the same scope and stop.
  if (scopeOf(ctx) !== undefined) {
    ctx.tools.setExecutor(new RunCodeItselfExecutor(ctx, executorConfig(settings, {})))
    ctx.logger.info('run-code-itself: registered as this preset\'s tool executor')
    return
  }
  const installed = new WeakSet()

  const install = (agent) => {
    if (installed.has(agent)) return
    let selected
    try {
      selected = ctx.tools.selectExecutor(agent)
    } catch {
      return
    }
    if (!isPtcExecutor(selected) || selected[ENHANCED] === true) return
    try {
      const executor = new RunCodeItselfExecutor(agent.ctx, executorConfig(settings, selected.config ?? {}))
      const dispose = agent.ctx.tools.setExecutor(executor)
      installed.add(agent)
      ctx.logger.debug('run-code-itself: enhanced executor installed for agent "' + agent.id + '"')
      ctx.effect(() => () => {
        installed.delete(agent)
        dispose()
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('run-code-itself: cannot install on agent "' + agent.id + '": ' + detail)
    }
  }

  ctx.on('agent/created', ({ agent }) => { install(agent) })
  for (const agent of ctx.agents.list()) install(agent)
}
