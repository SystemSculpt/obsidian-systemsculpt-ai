import { parseDocument } from 'yaml';
import { parser } from '@lezer/javascript';
import type { StudioJsonValue } from './types';
import { isStudioDynamicPortId, isStudioPortDataType, STUDIO_PROCESS_FIXED_OUTPUT_PORTS } from './types';
import { isRecord } from './utils';

export const STUDIO_SCRIPT_MAX_BYTES = 256 * 1024;
export const STUDIO_SCRIPT_TEMPLATE = `/* studio
inputs:
  value: {type: json, required: false}
outputs:
  result: json
*/

export default async ({ inputs }) => {
  return { result: inputs.value ?? { message: "Hello from Studio" } };
};
`;
const META_KEYS = new Set(['executable', 'workingDirectory', 'inputs', 'outputs', 'environment', 'timeoutMs', 'maxOutputBytes', 'maxArtifactMb']);

function ports(value: unknown, direction: 'inputs' | 'outputs'): StudioJsonValue[] {
  if (!isRecord(value)) throw new Error(`Script ${direction} must map port names to types.`);
  if (Object.keys(value).length > 32) throw new Error('Scripts support at most 32 ports per direction.');
  const reserved = new Set<string>(direction === 'outputs' ? STUDIO_PROCESS_FIXED_OUTPUT_PORTS.map(p => p.id) : []);
  return Object.entries(value).map(([id, declaration]) => {
    const type = typeof declaration === 'string' ? declaration : isRecord(declaration) ? declaration.type : null;
    if (!isStudioDynamicPortId(id) || reserved.has(id) || !isStudioPortDataType(type)) throw new Error(`Invalid script port: ${id}.`);
    if (isRecord(declaration) && Object.keys(declaration).some(key => !['type', 'required'].includes(key))) throw new Error(`Unknown setting for script port ${id}.`);
    if (isRecord(declaration) && declaration.required !== undefined && typeof declaration.required !== 'boolean') throw new Error(`Port ${id}.required must be boolean.`);
    return { id, type, required: !isRecord(declaration) || declaration.required !== false };
  });
}

/** Parse only declarative metadata. JavaScript is never evaluated inside Obsidian. */
export function readStudioScript(source: unknown): { source: string; processConfig: Record<string, StudioJsonValue> } {
  if (typeof source !== 'string' || !source.trim()) throw new Error('A script needs JavaScript source.');
  if (new TextEncoder().encode(source).byteLength > STUDIO_SCRIPT_MAX_BYTES) throw new Error('Script source exceeds 256 KiB. Move large data into files.');
  let syntaxError = -1;
  parser.parse(source).iterate({ enter(node) { if (node.type.isError && syntaxError < 0) syntaxError = node.from; } });
  if (syntaxError >= 0) throw new Error(`Invalid JavaScript near line ${source.slice(0, syntaxError).split('\n').length}.`);
  const header = source.match(/^\s*\/\* studio\r?\n([\s\S]*?)\*\//u);
  let metadata: Record<string, unknown> = {};
  if (header) {
    if (header[1].length > 32768) throw new Error('Script metadata exceeds 32 KiB.');
    const document = parseDocument(header[1], { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error(`Invalid script metadata: ${document.errors[0]?.message ?? document.warnings[0]?.message}`);
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(value)) throw new Error('Script metadata must be a mapping.');
    metadata = value;
    for (const key of Object.keys(metadata)) if (!META_KEYS.has(key)) throw new Error(`Unknown script metadata: ${key}.`);
  } else if (/^\s*\/\* studio\b/u.test(source)) throw new Error('Close the script metadata comment with */.');
  const executable = metadata.executable ?? 'node', workingDirectory = metadata.workingDirectory ?? '.';
  if (typeof executable !== 'string' || !executable.trim() || typeof workingDirectory !== 'string' || !workingDirectory.trim()) throw new Error('Script executable and workingDirectory must be non-empty strings.');
  const processConfig: Record<string, StudioJsonValue> = {
    executable, workingDirectory, arguments: [], inputs: ports(metadata.inputs ?? {}, 'inputs'),
    outputs: ports(metadata.outputs ?? { result: 'json' }, 'outputs'),
    timeoutMs: 300000, maxOutputBytes: 1048576, maxArtifactMb: 64,
    failOnNonZero: true, failOnTimeout: true, manifestToStdin: false,
  };
  for (const [key, min, max] of [['timeoutMs', 100, 86400000], ['maxOutputBytes', 1024, 1048576], ['maxArtifactMb', 1, 64]] as const) {
    if (metadata[key] !== undefined) {
      const value = metadata[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
      processConfig[key] = value;
    }
  }
  if (metadata.environment !== undefined) {
    if (!isRecord(metadata.environment) || Object.entries(metadata.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.startsWith('STUDIO_') || typeof value !== 'string')) throw new Error('Script environment must contain string values and cannot override STUDIO_* variables.');
    processConfig.environment = metadata.environment as Record<string, string>;
  }
  return { source, processConfig };
}

export const STUDIO_SCRIPT_RUNNER = `import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const manifest = JSON.parse(await readFile(process.env.STUDIO_INPUTS, "utf8"));
const script = await import(pathToFileURL(process.argv[2]).href);
if (typeof script.default !== "function") throw new Error("Export a default async function from the script.");
const outputs = await script.default({ inputs: manifest.inputs, context: { runId: manifest.runId, nodeId: manifest.nodeId, directory: process.env.STUDIO_RUN_DIR } });
if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) throw new Error("Return an object containing the declared output ports.");
const serialized = JSON.stringify({ schema: "studio.process.outputs.v1", outputs });
if (Buffer.byteLength(serialized) > 1048576) throw new Error("Script results exceed 1 MiB. Return large data through file-reference ports.");
await writeFile(process.env.STUDIO_OUTPUTS, serialized);
`;
