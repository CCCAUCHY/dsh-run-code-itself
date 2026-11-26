/**
 * run_code_itself: expose the complete run_code tool-call arguments to the
 * program, with preloaded subtool templates.
 * @module
 */
import { jsonSchemaToTs, PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
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

/** Tools whose full definitions stay in the system prompt. */
const COMMON_TOOLS = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep'])

/** Short note appended to the run_code description; the hard rules live in the system prompt. */
const TOOL_NOTE = '\n\nExtra top-level sibling fields are allowed. Inside the program they become parsed values on run_code_itself; the system prompt defines the Code-Data Separation rules.'

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

/** TypeScript call signature for one tool definition. */
function signatureFor(definition) {
  const parameters = isObjectRecord(definition.parameters) ? definition.parameters : { type: 'object', properties: {} }
  const output = definition.output !== undefined && isObjectRecord(definition.output.schema)
    ? definition.output.schema : {}
  return 'tools.' + definition.name + '(args: ' + jsonSchemaToTs(parameters) + '): Promise<' + jsonSchemaToTs(output) + '>'
}

/**
 * Build one argument template per visible tool, including its description,
 * call signature, parameter schema, and output schema.
 * @param definitions - visible tool definitions.
 * @returns templates keyed by tool name.
 */
export function buildTemplates(definitions) {
  const templates = Object.create(null)
  for (const definition of definitions) {
    const parameters = isObjectRecord(definition.parameters) ? definition.parameters : {}
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
    const output = definition.output === undefined ? undefined : definition.output.schema
    const template = {
      description: definition.description === undefined ? '' : String(definition.description),
      signature: signatureFor(definition),
      keys,
      required,
      sample,
      parameters,
    }
    if (output !== undefined) template.output = output
    if (Object.keys(defaults).length > 0) template.defaults = defaults
    templates[definition.name] = template
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
/** Escape one-line JSDoc text. */
function docText(text) {
  return (typeof text === 'string' ? text : '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()
}

export function renderCompactSdk(tools) {
  const common = tools.filter(tool => COMMON_TOOLS.has(tool.name))
  const other = tools.filter(tool => !COMMON_TOOLS.has(tool.name))
  const lines = [
    '## Code-Data Separation',
    '',
    'This runtime separates code from data. code is program logic; data and subtool arguments are sibling JSON fields of the run_code call, read inside the program as parsed values on run_code_itself.',
    '',
    '1. **Subtool JSON MUST be a sibling field.** Put the argument object in a field named after the tool (bash, read, ...) and call tools.bash(run_code_itself.bash). Never write tools.x({...}) inline, regardless of payload size.',
    '2. **Escape-prone values MUST be sibling fields:** multi-line text, regex or paths with backslashes, JSON arrays/objects, templates.',
    '3. **Other values:** use a sibling field when it reduces escaping or is long; simple literals, numbers, status strings, and control flow stay in code.',
    '',
    'Do not JSON.stringify or JSON.parse sibling values; do not declare run_code_itself.',
    '',
    'All tool templates are preloaded in run_code_templates; print run_code_templates.<tool> for its description, signature, parameters, output, and sample.',
    '',
    '## SDK',
    '',
    'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }',
    '',
    'declare const run_code_itself: {',
    '  code: string;',
    '  description: string;',
    '  [key: string]: JsonValue;',
    '}',
    '',
    'interface ToolArgsMap {',
  ]
  for (const tool of common) {
    const description = docText(tool.description)
    if (description !== '') lines.push('  /** ' + description + ' */')
    const parameters = isObjectRecord(tool.parameters) ? tool.parameters : { type: 'object', properties: {} }
    lines.push('  ' + JSON.stringify(tool.name) + ': ' + jsonSchemaToTs(parameters) + ';')
  }
  lines.push('}', '', 'interface ToolOutputMap {')
  for (const tool of common) {
    const output = tool.output !== undefined && isObjectRecord(tool.output.schema) ? tool.output.schema : {}
    lines.push('  ' + JSON.stringify(tool.name) + ': ' + jsonSchemaToTs(output) + ';')
  }
  lines.push(
    '}',
    '',
    'declare const tools: { [K in keyof ToolArgsMap]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]> }',
    '',
    '// Code-Data Separation example:',
    '// run_code({',
    '//   code: "return await tools.bash(run_code_itself.bash)",',
    '//   description: "List files",',
    '//   bash: { command: "ls -la", description: "List files" },',
    '// })',
    '',
    '## Other tools',
    '',
    'These tools are callable but not declared in the compact SDK. Print their template for signature, parameters, and output:',
    '',
  )
  for (const tool of other) lines.push('- ' + tool.name + ': ' + firstSentence(tool.description))
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
          description: schema.description + TOOL_NOTE,
          parameters: {
            ...parameters,
            additionalProperties: true,
            properties: {
              ...properties,
              ...code === undefined ? {} : {
                code: {
                  ...code,
                  description: (typeof code.description === 'string' ? code.description + ' ' : '')
                    + 'Extra sibling fields are parsed values on run_code_itself; run_code_itself.code is this exact source text and can be inspected or evaluated for metaprogramming.',
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
