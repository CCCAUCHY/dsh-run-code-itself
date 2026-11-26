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
  promptMode: z.union(['system', 'tool']).default('system').description(
    'Where to put the Code-Data Separation guide: the system prompt SDK section or the run_code tool description.',
  ),
  sdkStyle: z.union(['declarations', 'index']).default('declarations').description(
    'System-prompt SDK style: TypeScript declarations or a compact tool index without PTC-like declarations.',
  ),
})

/** The program-visible preset variable. */
export const RUN_CODE_ITSELF = 'run_code_itself'

/** Tools whose full definitions stay in the system prompt. */
const COMMON_TOOLS = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep'])

/** Short note appended to the run_code description. */
const TOOL_NOTE = '\n\nExtra top-level sibling fields are allowed and become parsed values on run_code_itself.'

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

/** Empty placeholder for one JSON Schema property. */
function emptyValue(property) {
  if (Object.prototype.hasOwnProperty.call(property, 'const')) return property.const
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
 * Build the per-tool metadata wrapper: the full tool description plus a
 * template containing every field (required empty, optional default value).
 * @param definitions - visible tool definitions.
 * @returns wrapper objects keyed by tool name.
 */
export function buildSubtools(definitions) {
  const subtools = Object.create(null)
  for (const definition of definitions) {
    const parameters = isObjectRecord(definition.parameters) ? definition.parameters : {}
    const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
    const required = Array.isArray(parameters.required) ? parameters.required : []
    const template = Object.create(null)
    for (const [key, property] of Object.entries(properties)) {
      if (!isObjectRecord(property) || required.includes(key)) continue
      if (Object.prototype.hasOwnProperty.call(property, 'default')) template[key] = property.default
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(template, key)) template[key] = ''
    }
    subtools[definition.name] = {
      description: definition.description === undefined ? '' : String(definition.description),
      template,
    }
  }
  return subtools
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

export function renderCompactSdk(tools, options = {}) {
  const sdkStyle = options.sdkStyle ?? 'declarations'
  const lines = [
    '## Code-Data Separation',
    '',
    'code is program logic. Keep data out of it: use free-form sibling fields, read inside the program as run_code_itself.<field>, or the preloaded subtool template.',
    '',
    '1. **Do not inline subtool JSON.** Use a free-form sibling field (bash: {...}) and call tools.bash(run_code_itself.bash), or fill and pass run_code_subtools.<tool>.template. Never write tools.x({...}).',
    '2. **Minimize escaping in code.** Move a value into a sibling field when that removes quotes, backslashes, newlines, or a large literal; keep it inline when it costs nothing.',
    '3. **Decide by actual escaping cost, not by type or size.**',
    '',
    '**Subtool metadata**',
    '',
    'run_code_subtools.<tool> = { description, template }.',
    '- description: full tool description.',
    '- template: required fields empty, optional fields with schema defaults; fill required values from run_code_itself and pass it directly to tools.<tool>.',
    '- Do not pass run_code_subtools.<tool> itself as arguments.',
    '- Print run_code_subtools.<tool> to inspect both.',
    '',
    'Do not JSON.stringify or JSON.parse sibling values; do not declare run_code_itself or run_code_subtools.',
    '',
  ]
  const examples = [
    '## Examples',
    '',
    '// Sibling field:',
    '// run_code({',
    '//   code: "return await tools.bash(run_code_itself.bash)",',
    '//   description: "List files",',
    '//   bash: { description: "List files", command: "ls -la" },',
    '// })',
    '//',
    '// Template variable, values from extra fields:',
    '// run_code({',
    '//   code: "const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)",',
    '//   description: "List files",',
    '//   label: "List files",',
    '//   command: "ls -la",',
    '// })',
    '',
  ]
  if (sdkStyle === 'index') {
    lines.push('## Tools', '', 'All tools are callable as await tools.name(args). run_code_subtools.<tool> has the full description and template.', '')
    for (const tool of tools) {
      lines.push('- ' + tool.name + ': ' + (options.fullDescriptions ? docText(tool.description) : firstSentence(tool.description)))
    }
    lines.push('', ...examples)
    return lines.join('\n')
  }
  const common = tools.filter(tool => COMMON_TOOLS.has(tool.name))
  const other = tools.filter(tool => !COMMON_TOOLS.has(tool.name))
  lines.push(
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
    'declare const run_code_subtools: Record<string, {',
    '  description: string;',
    '  template: Record<string, JsonValue>;',
    '}>',
    '',
    'interface ToolArgsMap {',
  )
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
    ...examples,
    '## Other tools',
    '',
    'These tools are callable but not declared in the compact SDK. Print run_code_subtools.<tool> for its full description and template:',
    '',
  )
  for (const tool of other) lines.push('- ' + tool.name + ': ' + firstSentence(tool.description))
  return lines.join('\n')
}


/** Compact argument and return names for one tool. */
function signatureFor(definition) {
  const parameters = isObjectRecord(definition.parameters) ? definition.parameters : {}
  const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  const args = Object.keys(properties).map(key => required.has(key) ? key : key + '?').join(', ')
  const output = definition.output !== undefined && isObjectRecord(definition.output.schema) ? definition.output.schema : {}
  const outputProperties = isObjectRecord(output.properties) ? Object.keys(output.properties) : []
  const returns = outputProperties.length > 0 ? '{' + outputProperties.join(', ') + '}' : 'JsonValue'
  return definition.name + '(' + args + ') -> ' + returns
}

/** Tool list for the run_code description, without usage rules. */
export function renderToolList(tools, options = {}) {
  const lines = [
    '## Tools',
    '',
    'All tools are callable as await tools.name(args). run_code_subtools.<tool> has the full description and template.',
    '',
  ]
  for (const tool of tools) {
    lines.push('- ' + signatureFor(tool) + ': ' + (options.fullDescriptions ? docText(tool.description) : firstSentence(tool.description)))
  }
  return lines.join('\n')
}

/** The usage rules that belong at the end of the run_code description. */
export function renderUsageRules() {
  return [
    '## run_code Usage Rules',
    '',
    'You must follow these rules.',
    '',
    'Extra top-level sibling fields are allowed and become parsed values on run_code_itself.',
    '',
    '### Code-Data Separation',
    '',
    'code is program logic. Keep data out of it: use free-form sibling fields, read inside the program as run_code_itself.<field>, or the preloaded subtool template.',
    '',
    '1. **Do not inline subtool JSON.** Use a free-form sibling field (bash: {...}) and call tools.bash(run_code_itself.bash), or fill and pass run_code_subtools.<tool>.template. Never write tools.x({...}).',
    '2. **Minimize escaping in code.** Move a value into a sibling field when that removes quotes, backslashes, newlines, or a large literal; keep it inline when it costs nothing.',
    '3. **Decide by actual escaping cost, not by type or size.**',
    '',
    '### Subtool metadata',
    '',
    'run_code_subtools.<tool> = { description, template }.',
    '- description: full tool description.',
    '- template: required fields empty, optional fields with schema defaults; fill required values from run_code_itself and pass it directly to tools.<tool>.',
    '- Do not pass run_code_subtools.<tool> itself as arguments.',
    '- Print run_code_subtools.<tool> to inspect both.',
    '',
    'Do not JSON.stringify or JSON.parse sibling values; do not declare run_code_itself or run_code_subtools.',
    '',
    '### Examples',
    '',
    '// Sibling field:',
    '// run_code({',
    '//   code: "return await tools.bash(run_code_itself.bash)",',
    '//   description: "List files",',
    '//   bash: { description: "List files", command: "ls -la" },',
    '// })',
    '//',
    '// Template variable, values from extra fields:',
    '// run_code({',
    '//   code: "const args = run_code_subtools.bash.template; args.description = run_code_itself.label; args.command = run_code_itself.command; return await tools.bash(args)",',
    '//   description: "List files",',
    '//   label: "List files",',
    '//   command: "ls -la",',
    '// })',
  ].join('\n')
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
    const { promptMode = 'system', sdkStyle = 'declarations', ...limits } = config ?? {}
    super(ctx, limits)
    this.promptMode = promptMode
    this.sdkStyle = sdkStyle
    const sections = this.sections
    if (promptMode === 'tool') {
      this.sections = []
    } else if (sections.length > 1) {
      this.sections = [
        sections[0],
        {
          name: sections[1].name,
          order: sections[1].order,
          interpolate: false,
          text: tools => renderCompactSdk(tools, { sdkStyle: this.sdkStyle }),
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
    const toolGuide = this.promptMode === 'tool'
      ? '\n\n' + renderToolList(tools, { fullDescriptions: true }) + '\n\n' + renderUsageRules()
      : ''
    return {
      ...description,
      schemas: description.schemas.map(schema => {
        if (schema.name !== RUN_CODE_NAME || !isObjectRecord(schema.parameters)) return schema
        const parameters = schema.parameters
        const properties = isObjectRecord(parameters.properties) ? parameters.properties : {}
        const code = isObjectRecord(properties.code) ? properties.code : undefined
        const base = this.promptMode === 'tool'
          ? schema.description.replace('per the declarations in the system prompt', 'using the tool list and rules in this description')
          : schema.description
        return {
          ...schema,
          description: base + (toolGuide === '' ? TOOL_NOTE : toolGuide),
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
   * Inject run_code_itself and the run_code_subtools wrapper.
   * @param transport - the unwrapped run_code definition.
   * @param args - parsed model arguments, possibly with sibling fields.
   * @param exec - the tool run context.
   * @returns the transport result.
   */
  async #execute(transport, args, exec) {
    if (!isObjectRecord(args) || typeof args.code !== 'string') return transport.execute(args, exec)
    const subtools = buildSubtools(this.ctx.tools.definitions(exec.agent, exec.toolSet))
    const prelude = [
      'const run_code_subtools = ' + jsonLiteral(subtools) + ';',
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
  if (settings.promptMode !== undefined) config.promptMode = settings.promptMode
  if (settings.sdkStyle !== undefined) config.sdkStyle = settings.sdkStyle
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
