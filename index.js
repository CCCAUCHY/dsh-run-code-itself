/**
 * run_code_itself: expose the complete run_code tool-call arguments to the
 * program, with preloaded subtool templates.
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

/** Tools whose full definitions stay in the system prompt. */
const COMMON_TOOLS = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep'])

/** One-line note placed immediately after the base description. */
const EXTRA_FIELDS_NOTE = (
  'The parameter schema sets @additionalProperties: true@: extra sibling fields are allowed and MUST be used for subtool JSON and escape-prone values.'
).replaceAll('@', TICK)

/** Model-facing contract appended after the base description. */
export const GUIDANCE = [
  '**Preset variables**',
  '',
  '@run_code_itself@ is the complete arguments object of this @run_code@ call; extra sibling fields are already parsed JavaScript values. @run_code_templates@ contains every visible tool argument template; print @run_code_templates.<tool>@ for keys, required fields, and a sample.',
  '',
  '**Sibling fields — hard rules**',
  '',
  '1. **Subtool JSON MUST be a sibling field.** Put the argument object in a field named after the tool (@bash@, @read@, @write@, ...) and call @tools.bash(run_code_itself.bash)@. Never write @tools.x({...})@ inline, regardless of payload size.',
  '2. **Values that need escaping MUST be sibling fields:** multi-line text, regex or paths with backslashes, JSON arrays/objects, templates.',
  '3. **Other values:** use a sibling field when it reduces escaping or is long; simple literals, numbers, status strings, and control flow stay in @code@.',
  '',
  'Do not @JSON.stringify@ or @JSON.parse@ sibling values; do not declare the preset variables.',
  '',
  '**Metaprogramming**',
  '',
  '@run_code_itself.code@ is the exact source; read, split, or @eval@ it. Use @run_code_templates@ to look up tool arguments.',
  '',
  'Example: {"code":"return await tools.bash(run_code_itself.bash)","description":"List files","bash":{"command":"ls -la","description":"List files"}}',
].join('\n').replaceAll('@', TICK)

/** True for the argument object shape a JSON tool call can produce. */
function isObjectRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON text safe to embed as a JavaScript expression. */
function jsonLiteral(value) {
  const json = JSON.stringify(value)
  const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return safe.includes('"__proto__"') ? 'JSON.parse(' + JSON.stringify(safe) + ')' : safe
}

/**
 * Build the one declaration that binds the program variable to the exact
 * arguments the model passed.
 * @param payload - the parsed run_code arguments.
 * @returns one declaration statement.
 */
export function declarationFor(payload) {
  return 'const ' + RUN_CODE_ITSELF + ' = ' + jsonLiteral(payload) + ';'
}

/** Placeholder value for one JSON Schema property. */
function sampleValue(property) {
  if (Object.prototype.hasOwnProperty.call(property, 'const')) return property.const
  if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0]
  switch (property.type) {
    case 'string': return ''
    case 'number': return 0
    case 'integer': return 0
    case 'boolean': return false
    case 'array': return []
    case 'object': return {}
    default: return null
  }
}

/**
 * Build one argument template per visible tool from its projected schema.
 * @param schemas - visible tool schemas.
 * @returns templates keyed by tool name.
 */
export function buildTemplates(schemas) {
  const templates = Object.create(null)
  for (const schema of schemas) {
    const parameters = isObjectRecord(schema.parameters) ? schema.parameters : {}
    const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
    const keys = Object.keys(properties)
    const required = Array.isArray(parameters.required) ? parameters.required.slice() : []
    const sample = Object.create(null)
    const defaults = Object.create(null)
    for (const key of keys) {
      const property = properties[key]
      if (!isObjectRecord(property)) continue
      sample[key] = sampleValue(property)
      if (Object.prototype.hasOwnProperty.call(property, 'default')) defaults[key] = property.default
    }
    const template = {
      description: schema.description === undefined ? '' : String(schema.description),
      keys,
      required,
      sample,
      parameters,
    }
    if (Object.keys(defaults).length > 0) template.defaults = defaults
    templates[schema.name] = template
  }
  return templates
}

/** First sentence of a tool description, for the compact index. */
function firstSentence(text) {
  const value = typeof text === 'string' ? text : ''
  const index = value.indexOf('. ')
  return index === -1 ? value : value.slice(0, index + 1)
}

/**
 * Compact SDK section: full definitions for common tools, names and one-line
 * descriptions for the rest, with templates preloaded in the program.
 * @param tools - visible capability definitions.
 * @returns the generated system-prompt section.
 */
export function renderCompactSdk(tools) {
  const common = tools.filter(tool => COMMON_TOOLS.has(tool.name))
  const other = tools.filter(tool => !COMMON_TOOLS.has(tool.name))
  const lines = [
    '## Tools',
    '',
    'All tools are callable as await tools.name(args). All argument templates are preloaded in run_code_templates; print one with console.log(run_code_templates.<tool>) when you need its keys, required fields, or sample.',
    '',
    '### Common tools (full definitions)',
    '',
  ]
  for (const tool of common) {
    lines.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  }
  lines.push('', '### Other tools (name, description; print the template for parameters)', '')
  for (const tool of other) lines.push('- ' + tool.name + ': ' + firstSentence(tool.description))
  lines.push(
    '',
    '### Calling',
    '',
    '- Put subtool JSON in a sibling field (bash, read, ...) and call tools.bash(run_code_itself.bash).',
    '- run_code_templates is preloaded; print run_code_templates.<tool> for argument keys and samples.',
    '- run_code_itself contains the complete call arguments.',
  )
  return lines.join('\n')
}

/**
 * The run_code transport with injected arguments and tool templates.
 * Everything else (validation, presentation, live schema getters, output
 * rendering) stays owned by the wrapped transport.
 */
export class RunCodeItselfExecutor extends PtcExecutor {
  #transport

  /**
   * Replace the generated SDK section with the on-demand form.
   * @param ctx - agent-scoped context the PTC transport executes in.
   * @param config - validated program limits.
   */
  constructor(ctx, config) {
    super(ctx, config)
    const sections = this.sections
    if (sections.length > 1) {
      this.sections = [
        sections[0],
        {
          name: sections[1].name,
          order: sections[1].order,
          interpolate: false,
          text: tools => renderCompactSdk(tools),
        },
      ]
    }
  }

  /**
   * Wrap the reserved transport once.
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
   * Keep the model-facing schema, add the sibling-field contract, and add the
   * metaprogramming note to the code parameter.
   * @param tools - visible capability definitions.
   * @returns the run_code schema with open parameters.
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
                    + 'Program logic only: put subtool JSON and escape-prone values in extra sibling fields. run_code_itself.code is this exact source text and can be inspected or evaluated for metaprogramming.',
                },
              },
            },
          },
        }
      }),
    }
  }

  /**
   * Inject run_code_itself and all tool templates.
   * @param transport - the unwrapped run_code definition.
   * @param args - parsed model arguments, possibly with sibling fields.
   * @param exec - the tool run context.
   * @returns the transport result.
   */
  async #execute(transport, args, exec) {
    if (!isObjectRecord(args) || typeof args.code !== 'string') return transport.execute(args, exec)
    const templates = buildTemplates(this.ctx.tools.schemas(exec.agent, exec.toolSet))
    const prelude = [
      'const run_code_templates = ' + jsonLiteral(templates) + ';',
      declarationFor(args),
    ].join('\n')
    return transport.execute({ ...args, code: prelude + '\n' + args.code }, exec)
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
 * PTC executor.
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
  if (scopeOf(ctx) !== undefined) {
    ctx.tools.setExecutor(new RunCodeItselfExecutor(ctx, executorConfig(settings, {})))
    ctx.logger.info('run-code-itself: registered as this preset tool executor')
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
