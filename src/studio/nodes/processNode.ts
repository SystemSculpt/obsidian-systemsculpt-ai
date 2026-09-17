import {
  dirnameOfAbsolutePath,
  isAbsoluteOsPath,
  joinOsPath,
  resolveExecutableCandidate
} from '../StudioProcessPaths'
import type {
  StudioAssetRef,
  StudioJsonValue,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
  StudioPortDataType,
  StudioPortDefinition
} from '../types'
import {
  isStudioDynamicPortId,
  isStudioFileReferencePortDataType,
  isStudioPortDataType,
  STUDIO_DYNAMIC_PORT_MAX_COUNT,
  STUDIO_DYNAMIC_PORT_ID_SOURCE,
  STUDIO_PROCESS_FIXED_OUTPUT_PORTS
} from '../types'
import { isRecord } from '../utils'
import { validateNodeConfig } from '../StudioNodeConfigValidation'
import { getText, inferMimeTypeFromPath } from './shared'

export const STUDIO_PROCESS_KIND = 'studio.process' as const

const PROCESS_INPUT_SCHEMA = 'studio.process.inputs.v1'
const PROCESS_OUTPUT_SCHEMA = 'studio.process.outputs.v1'
const MAX_INPUT_MANIFEST_BYTES = 1024 * 1024
const MAX_OUTPUT_MANIFEST_BYTES = 1024 * 1024
const PROGRESS_UPDATE_INTERVAL_MS = 100
const EXACT_INPUT_TEMPLATE = new RegExp(
  String.raw`^\{\{\s*input\.(${STUDIO_DYNAMIC_PORT_ID_SOURCE})\s*\}\}$`
)
const ARGUMENT_TEMPLATE = new RegExp(
  String.raw`\{\{\s*(inputs|outputs|run_dir|input\.${STUDIO_DYNAMIC_PORT_ID_SOURCE})\s*\}\}`,
  'g'
)

export type StudioProcessPortConfig = {
  id: string
  type: StudioPortDataType
  required: boolean
}

export function readStudioProcessPorts(
  value: StudioJsonValue | undefined,
  direction: 'input' | 'output'
): StudioProcessPortConfig[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>(
    direction === 'output' ? STUDIO_PROCESS_FIXED_OUTPUT_PORTS.map((port) => port.id) : []
  )
  const ports: StudioProcessPortConfig[] = []
  for (const entry of value) {
    if (ports.length >= STUDIO_DYNAMIC_PORT_MAX_COUNT) break
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const type = isStudioPortDataType(entry.type) ? entry.type : 'any'
    if (!isStudioDynamicPortId(id) || seen.has(id)) continue
    seen.add(id)
    ports.push({ id, type, required: entry.required === true })
  }
  return ports
}

export function resolveStudioProcessInputPorts(
  config: Record<string, StudioJsonValue>
): StudioPortDefinition[] {
  return readStudioProcessPorts(config.inputs, 'input').map((port) => ({
    id: port.id,
    type: port.type,
    required: port.required,
    description: `Available as inputs.${port.id} in the input manifest.`
  }))
}

export function resolveStudioProcessOutputPorts(
  config: Record<string, StudioJsonValue>
): StudioPortDefinition[] {
  return [
    ...STUDIO_PROCESS_FIXED_OUTPUT_PORTS,
    ...readStudioProcessPorts(config.outputs, 'output').map((port) => ({
      id: port.id,
      type: port.type,
      required: port.required,
      description: `Read from outputs.${port.id} in the output manifest.`
    }))
  ]
}

function extractPath(value: StudioJsonValue): string {
  if (typeof value === 'string') return value.trim()
  if (isRecord(value) && typeof value.path === 'string') return value.path.trim()
  return ''
}

function resolveInputPath(context: StudioNodeExecutionContext, value: StudioJsonValue): string {
  const path = extractPath(value)
  if (!path) return getText(value)
  return context.services.resolveAbsolutePath(path)
}

function prepareInputValue(
  context: StudioNodeExecutionContext,
  value: StudioJsonValue,
  type: StudioPortDataType
): StudioJsonValue {
  if (!isStudioFileReferencePortDataType(type)) return value
  if (Array.isArray(value))
    return value.map((entry) => prepareInputValue(context, entry, type))
  return resolveInputPath(context, value)
}

function renderArguments(options: {
  args: string[]
  inputs: Record<string, StudioJsonValue>
  inputManifestPath: string
  outputManifestPath: string
  runDirectory: string
}): string[] {
  const constants: Record<string, string> = {
    inputs: options.inputManifestPath,
    outputs: options.outputManifestPath,
    run_dir: options.runDirectory
  }
  return options.args.flatMap((arg) => {
    const exact = arg.match(EXACT_INPUT_TEMPLATE)
    if (exact) {
      const value = options.inputs[exact[1]]
      return Array.isArray(value) ? value.map((entry) => getText(entry)) : [getText(value)]
    }
    return [
      arg.replace(ARGUMENT_TEMPLATE, (_match, key: string) => {
        if (key.startsWith('input.')) return getText(options.inputs[key.slice(6)])
        return constants[key] ?? ''
      })
    ]
  })
}

function processEnvironment(value: StudioJsonValue | undefined): Record<string, string> {
  if (typeof value === 'undefined' || value === null) return {}
  if (!isRecord(value)) throw new Error('Process environment must be a JSON object.')
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`Process environment variable "${key}" has an invalid name.`)
    if (key.toUpperCase().startsWith('STUDIO_'))
      throw new Error(`Process environment variable "${key}" is reserved by Studio.`)
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean')
      throw new Error(`Process environment variable "${key}" must be a string, number, or boolean.`)
    result[key] = String(entry)
  }
  return result
}

function outputObject(value: unknown): Record<string, StudioJsonValue> {
  if (!isRecord(value)) throw new Error('The process output manifest must be a JSON object.')
  if (value.schema !== PROCESS_OUTPUT_SCHEMA) {
    const schema = typeof value.schema === 'string' ? value.schema : '(missing)'
    throw new Error(`Unsupported process output schema "${schema}".`)
  }
  if (!isRecord(value.outputs))
    throw new Error('The process output manifest must contain an outputs object.')
  return value.outputs as Record<string, StudioJsonValue>
}

function mimeTypeForPort(type: StudioPortDataType, path: string, configured: string): string {
  if (configured) return configured
  const inferred = inferMimeTypeFromPath(path)
  if (inferred !== 'application/octet-stream') return inferred
  if (type === 'image_ref') return 'image/png'
  if (type === 'audio_ref') return 'audio/mpeg'
  if (type === 'video_ref') return 'video/mp4'
  return 'application/octet-stream'
}

async function persistFileOutput(
  context: StudioNodeExecutionContext,
  cwd: string,
  value: StudioJsonValue,
  type: StudioPortDataType,
  maxBytes: number
): Promise<StudioAssetRef> {
  const descriptor = isRecord(value) ? value : null
  const configuredPath = extractPath(value)
  if (!configuredPath) throw new Error('A file output must be a path or an object with a path.')
  const path = isAbsoluteOsPath(configuredPath) ? configuredPath : joinOsPath(cwd, configuredPath)
  context.services.assertFilesystemPath(path)
  const mimeType = mimeTypeForPort(
    type,
    path,
    descriptor && typeof descriptor.mimeType === 'string' ? descriptor.mimeType.trim() : ''
  )
  try {
    const bytes = await context.services.readLocalFileBinary(path, maxBytes)
    if (bytes.byteLength > maxBytes) throw new Error('Process outputs exceed the configured total artifact limit.')
    return await context.services.storeAsset(bytes, mimeType)
  } catch (error) {
    throw new Error(
      `Could not persist process output "${configuredPath}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function assertOutputType(id: string, type: StudioPortDataType, value: StudioJsonValue): void {
  if (type === 'any' || type === 'json' || isStudioFileReferencePortDataType(type)) return
  if (type === 'text' && typeof value === 'string') return
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return
  if (type === 'boolean' && typeof value === 'boolean') return
  throw new Error(`Process output "${id}" must have type ${type}.`)
}

function createLineReporter(context: StudioNodeExecutionContext): {
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  flush: () => void
} {
  let stdoutPending = ''
  let stderrPending = ''
  let lastProgress = ''
  let lastProgressAt = Number.NEGATIVE_INFINITY
  let pendingProgress: { percent: number; message?: string } | null = null
  const flushProgress = (): void => {
    if (!pendingProgress) return
    context.reportProgress?.(Math.min(100, Math.max(0, pendingProgress.percent)), pendingProgress.message)
    pendingProgress = null
    lastProgressAt = Date.now()
  }
  const reportLines = (lines: string[], stream: 'stdout' | 'stderr'): void => {
    let logs: string[] = []
    const flushLogs = (): void => {
      const message = logs.join('\n')
      for (let offset = 0; offset < message.length; offset += 16 * 1024)
        context.log(message.slice(offset, offset + 16 * 1024), stream)
      logs = []
    }
    for (const line of lines) {
      const progress = line.match(/^::studio-progress\s+([0-9]+(?:\.[0-9]+)?)(?:\s+(.*))?$/)
      if (progress) {
        flushLogs()
        const message = progress[2]?.trim() || undefined
        const key = `${progress[1]}:${message || ''}`
        if (key !== lastProgress) {
          lastProgress = key
          pendingProgress = { percent: Number(progress[1]), ...(message ? { message } : {}) }
          if (Date.now() - lastProgressAt >= PROGRESS_UPDATE_INTERVAL_MS) flushProgress()
        }
      } else if (line) {
        logs.push(line)
      }
    }
    flushLogs()
  }
  const consume = (chunk: string, stream: 'stdout' | 'stderr'): void => {
    let pending = (stream === 'stdout' ? stdoutPending : stderrPending) + chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    reportLines(lines, stream)
    if (stream === 'stdout') stdoutPending = pending
    else stderrPending = pending
  }
  return {
    stdout: (chunk) => consume(chunk, 'stdout'),
    stderr: (chunk) => consume(chunk, 'stderr'),
    flush: () => {
      if (stdoutPending) reportLines([stdoutPending], 'stdout')
      if (stderrPending) reportLines([stderrPending], 'stderr')
      flushProgress()
      stdoutPending = ''
      stderrPending = ''
    }
  }
}

export const processNode: StudioNodeDefinition = {
  kind: STUDIO_PROCESS_KIND,
  version: '1.0.0',
  requiredHostCapabilities: ['local-cli', 'local-filesystem', 'absolute-paths'],
  capabilityClass: 'local_io',
  cachePolicy: 'never',
  inputPorts: [],
  outputPorts: [...STUDIO_PROCESS_FIXED_OUTPUT_PORTS],
  configDefaults: {
    executable: '',
    arguments: [],
    workingDirectory: '.',
    environment: {},
    inputs: [],
    outputs: [],
    timeoutMs: 300_000,
    maxOutputBytes: 1024 * 1024,
    maxArtifactMb: 64,
    manifestToStdin: false,
    failOnTimeout: true,
    failOnNonZero: true
  },
  configSchema: {
    fields: [
      {
        key: 'executable',
        label: 'Executable',
        type: 'file_path',
        required: true,
        allowOutsideVault: true,
        description:
          'An executable name on PATH or an absolute executable path. Studio never uses a shell.'
      },
      {
        key: 'arguments',
        label: 'Arguments',
        type: 'string_list',
        placeholder: 'One exact argument per line',
        description:
          'Use {{input.name}}, {{inputs}}, {{outputs}}, or {{run_dir}}. An exact array input expands to several arguments.'
      },
      {
        key: 'workingDirectory',
        label: 'Working directory',
        type: 'directory_path',
        allowOutsideVault: true,
        description: 'Dot means the open vault folder.'
      },
      {
        key: 'inputs',
        label: 'Input ports',
        type: 'port_list',
        portDirection: 'input',
        description:
          'Connected values are written to the input manifest and exposed through STUDIO_INPUTS.'
      },
      {
        key: 'outputs',
        label: 'Output ports',
        type: 'port_list',
        portDirection: 'output',
        description:
          'Write these values to the JSON file at STUDIO_OUTPUTS. File-reference ports become persistent Studio assets.'
      },
      {
        key: 'environment',
        label: 'Environment',
        type: 'json_object',
        description: 'Optional non-secret environment variables. STUDIO_* names are reserved.'
      },
      {
        key: 'manifestToStdin',
        label: 'Send manifest to stdin',
        type: 'boolean',
        description: 'Also sends the input manifest JSON to standard input.'
      },
      {
        key: 'failOnTimeout',
        label: 'Fail on timeout',
        type: 'boolean',
        description: 'When off, timeout details remain available as normal outputs.'
      },
      {
        key: 'failOnNonZero',
        label: 'Fail on non-zero exit',
        type: 'boolean'
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: true,
        min: 100,
        max: 86_400_000,
        integer: true
      },
      {
        key: 'maxOutputBytes',
        label: 'Log limit (bytes)',
        type: 'number',
        required: true,
        min: 1024,
        max: 1024 * 1024,
        integer: true
      },
      {
        key: 'maxArtifactMb',
        label: 'Total artifact limit (MB)',
        type: 'number',
        required: true,
        min: 1,
        max: 64,
        integer: true
      }
    ],
    allowUnknownKeys: true
  },
  async execute(context) {
    const validation = validateNodeConfig(processNode, context.node.config)
    if (!validation.isValid) throw new Error(validation.errors.map((error) => `${error.fieldKey}: ${error.message}`).join(' '))
    if (context.signal.aborted) { const error = new Error('Process cancelled.'); error.name = 'AbortError'; throw error }

    const configuredExecutable = getText(context.node.config.executable).trim()
    if (!configuredExecutable)
      throw new Error(`Process node "${context.node.id}" requires an executable.`)
    const configuredCwd = getText(context.node.config.workingDirectory).trim() || '.'
    const cwd = context.services.resolveAbsolutePath(configuredCwd)
    const executable = resolveExecutableCandidate(configuredExecutable, cwd)
    const inputPorts = readStudioProcessPorts(context.node.config.inputs, 'input')
    const customOutputPorts = readStudioProcessPorts(context.node.config.outputs, 'output')
    const preparedInputs: Record<string, StudioJsonValue> = {}
    for (const port of inputPorts) {
      const value = Object.prototype.hasOwnProperty.call(context.inputs, port.id) ? context.inputs[port.id] : undefined
      if (typeof value === 'undefined') {
        if (port.required) throw new Error(`Process input "${port.id}" is required.`)
        continue
      }
      preparedInputs[port.id] = prepareInputValue(context, value, port.type)
    }

    const inputManifest = {
      schema: PROCESS_INPUT_SCHEMA,
      runId: context.runId,
      nodeId: context.node.id,
      inputs: preparedInputs,
      rawInputs: context.inputs
    }
    const inputJson = `${JSON.stringify(inputManifest, null, 2)}\n`
    const inputBytes = new TextEncoder().encode(inputJson)
    if (inputBytes.byteLength > MAX_INPUT_MANIFEST_BYTES) {
      throw new Error(
        "Process inputs exceed Studio's 1 MB manifest limit. Connect large values through file-reference ports."
      )
    }
    const inputManifestPath = await context.services.writeTempFile(inputBytes.buffer, {
      prefix: 'process-inputs',
      extension: 'json'
    })
    const outputManifestPath = await context.services.writeTempFile(
      new TextEncoder().encode(
        `${JSON.stringify({ schema: PROCESS_OUTPUT_SCHEMA, outputs: {} }, null, 2)}\n`
      ).buffer,
      { prefix: 'process-outputs', extension: 'json' }
    )
    const runDirectory = dirnameOfAbsolutePath(outputManifestPath)
    const configuredArgs = Array.isArray(context.node.config.arguments)
      ? context.node.config.arguments.map((entry) => getText(entry))
      : []
    const args = renderArguments({
      args: configuredArgs,
      inputs: preparedInputs,
      inputManifestPath,
      outputManifestPath,
      runDirectory
    })
    const env = {
      ...processEnvironment(context.node.config.environment),
      STUDIO_INPUTS: inputManifestPath,
      STUDIO_OUTPUTS: outputManifestPath,
      STUDIO_RUN_DIR: runDirectory,
      STUDIO_RUN_ID: context.runId,
      STUDIO_NODE_ID: context.node.id
    }
    const reporter = createLineReporter(context)
    const timeoutMs = Number(context.node.config.timeoutMs)
    const maxOutputBytes = Number(context.node.config.maxOutputBytes)
    const result = await context.services.runCli({
      command: executable,
      args,
      cwd,
      env,
      input: context.node.config.manifestToStdin === true ? inputJson : undefined,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 300_000,
      maxOutputBytes: Number.isFinite(maxOutputBytes)
        ? Math.max(1024, Math.min(1024 * 1024, Math.floor(maxOutputBytes)))
        : 1024 * 1024,
      requireExactCommandGrant: true,
      signal: context.signal,
      onStdout: reporter.stdout,
      onStderr: reporter.stderr
    }).finally(() => reporter.flush())
    if (result.stdoutTruncated)
      context.log('Standard output reached the configured log limit and was truncated.')
    if (result.stderrTruncated)
      context.log('Standard error reached the configured log limit and was truncated.')
    if (result.cancelled || context.signal.aborted) {
      const error = new Error('Process cancelled.')
      error.name = 'AbortError'
      throw error
    }
    if (result.timedOut && context.node.config.failOnTimeout !== false)
      throw new Error(`Process timed out after ${Math.floor(timeoutMs || 300_000)} ms.`)
    if (!result.timedOut && result.exitCode !== 0 && context.node.config.failOnNonZero !== false) {
      const detail = result.stderr.trim().slice(-1200)
      throw new Error(`Process exited with code ${result.exitCode}.${detail ? `\n${detail}` : ''}`)
    }

    let declared: Record<string, StudioJsonValue>
    try {
      declared = outputObject(
        JSON.parse(
          new TextDecoder().decode(await context.services.readLocalFileBinary(outputManifestPath, MAX_OUTPUT_MANIFEST_BYTES))
        )
      )
    } catch (error) {
      throw new Error(
        `Could not read the process output manifest: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const outputs: Record<string, StudioJsonValue> = {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      timed_out: result.timedOut
    }
    const artifacts: StudioAssetRef[] = []
    const maxArtifactMb = Number(context.node.config.maxArtifactMb)
    let remainingArtifactBytes =
      (Number.isFinite(maxArtifactMb) ? Math.min(64, Math.max(1, Math.floor(maxArtifactMb))) : 64) * 1024 * 1024
    {
      for (const port of customOutputPorts) {
        const value = Object.prototype.hasOwnProperty.call(declared, port.id) ? declared[port.id] : undefined
        if (typeof value === 'undefined') {
          if (port.required) throw new Error(`Process output "${port.id}" is required.`)
          continue
        }
        assertOutputType(port.id, port.type, value)
        if (isStudioFileReferencePortDataType(port.type)) {
          if (remainingArtifactBytes < 1)
            throw new Error('Process outputs exceed the configured total artifact limit.')
          const asset = await persistFileOutput(
            context,
            cwd,
            value,
            port.type,
            remainingArtifactBytes
          )
          remainingArtifactBytes -= asset.sizeBytes
          artifacts.push(asset)
          outputs[port.id] = asset
        } else {
          outputs[port.id] = value
        }
      }
    }
    if (context.signal.aborted) {
      const error = new Error('Process cancelled.')
      error.name = 'AbortError'
      throw error
    }
    return { outputs, ...(artifacts.length > 0 ? { artifacts } : {}) }
  }
}
