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

/** One-line contract shown at the start of the run_code description. */
const DATA_RULE = (
  '**Data goes in extra fields:** pass payloads as JSON values in the top-level call and read them from @run_code_itself@; '
  + 'do not inline JSON, nested tool arguments, or long text in @code@.'
).replaceAll('@', TICK)

/** Model-facing contract for extra arguments, appended to run_code's description. */
export const GUIDANCE = [
  '',
  '**Extra fields are JSON**',
  '',
  'The whole @run_code@ call is one JSON object. Besides @code@ and @description@, you may add any extra top-level fields (for example @rows@, @regex@, @write@, @bash@). Their values are ordinary JSON values in that same object — arrays, objects, strings, numbers — written directly, not as a quoted JSON string. For @rows@, write [{"id": "AB-123-4567"}], not a string containing that JSON.',
  '',
  'Inside the program, @run_code_itself@ is the complete argument object: @run_code_itself.code@ is the exact @code@ source, and every extra field is already parsed (@run_code_itself.rows@, @run_code_itself.write@). Do not declare it; do not call @JSON.parse@ on extra fields.',
  '',
  '**Why this is easier than inlining**',
  '',
  'Inside @code@, a payload must be written as a JavaScript literal and then escaped again as part of the @code@ JSON string — two layers. An extra field has only the outer JSON layer; the program receives the parsed value directly. This matters most for JSON documents, arrays, nested tool arguments, quotes, newlines, and long text.',
  '',
  '**Prepare nested tool arguments as extra fields**',
  '',
  'Put the subtool argument object in a field and pass it through:',
  '',
  '{"code":"await tools.write(run_code_itself.write); return 1","description":"Write the SVG","write":{"file_path":"out.svg","content":"<svg ...>...</svg>"}}',
  '',
  '{"code":"const r = await tools.bash(run_code_itself.bash); return r.stdout.text","description":"List files","bash":{"description":"List files","command":"ls -la"}}',
  '',
  'This keeps the nested JSON in the tool call instead of rebuilding and escaping it inside @code@.',
  '',
  '**Size**',
  '',
  'Keep each extra field small (a few KB). Do not put a complete large SVG/HTML/Markdown document in one field; split it into fields (for example @svgHead@, @svgBody@) or multiple calls, and let @code@ assemble it. Do not inline data in @code@ when it can live in an extra field.',
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
          description: DATA_RULE + '\n\n' + schema.description + GUIDANCE,
          parameters: {
            ...parameters,
            additionalProperties: true,
            properties: {
              ...properties,
              ...code === undefined ? {} : {
                code: {
                  ...code,
                  description: (typeof code.description === 'string' ? code.description + ' ' : '')
                    + 'Program logic only: put data and nested tool arguments in extra top-level JSON fields and read them from run_code_itself.',
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
