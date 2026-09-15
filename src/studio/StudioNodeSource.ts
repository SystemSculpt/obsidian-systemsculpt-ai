import { parseDocument, stringify } from 'yaml';
import type { StudioJsonValue, StudioNodeDefinition, StudioNodeInstance, StudioProjectV1 } from './types';
import { isRecord } from './utils';
import { readCollectionField } from './StudioCollection';
import { validateNodeConfig } from './StudioNodeConfigValidation';
import { readStudioScript, STUDIO_SCRIPT_TEMPLATE } from './StudioScript';

export type StudioSourceLanguage = 'javascript' | 'json' | 'yaml' | 'markdown';
export type StudioNodeSource = { language: StudioSourceLanguage; text: string; externalData: boolean };
export const STUDIO_NODE_SOURCE_MAX_BYTES = 1024 * 1024;
const internal = (key: string) => key.startsWith('__studio_');
export function studioNodeSourceConfig(node: StudioNodeInstance): Record<string, StudioJsonValue> {
  const managed = node.kind === 'studio.collection' && readCollectionField(node.config.value, 'source.schema') === 'studio.source.v1';
  return Object.fromEntries(Object.entries(node.config).filter(([key]) => !internal(key) && !(managed && key === 'value')));
}
export function readStudioNodeSource(node: StudioNodeInstance): StudioNodeSource {
  if (node.kind === 'studio.script') return { language: 'javascript', text: typeof node.config.source === 'string' ? node.config.source : STUDIO_SCRIPT_TEMPLATE, externalData: false };
  if (node.kind === 'studio.json') return { language: 'json', text: JSON.stringify(node.config.value ?? {}, null, 2), externalData: false };
  if (node.kind === 'studio.text') return { language: 'markdown', text: String(node.config.value ?? ''), externalData: false };
  const externalData = node.kind === 'studio.collection' && readCollectionField(node.config.value, 'source.schema') === 'studio.source.v1';
  return { language: 'yaml', text: stringify(studioNodeSourceConfig(node), { lineWidth: 0, aliasDuplicateObjects: false }), externalData };
}

function assertJson(value: unknown, depth = 0): asserts value is StudioJsonValue {
  if (depth > 50) throw new Error('Source nesting exceeds 50 levels.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) assertJson(child, depth + 1); return; }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsupported source key: ${key}.`);
      assertJson(child, depth + 1);
    }
    return;
  }
  throw new Error('Source must contain JSON-compatible values.');
}

/** Compiles editable source into the existing typed config; it never executes it. */
export function parseStudioNodeSource(node: StudioNodeInstance, text: string, definition?: StudioNodeDefinition | null): Record<string, StudioJsonValue> {
  if (new TextEncoder().encode(text).byteLength > STUDIO_NODE_SOURCE_MAX_BYTES) throw new Error('Node source exceeds 1 MiB. Keep large data in files.');
  const current = readStudioNodeSource(node);
  let config: Record<string, StudioJsonValue>;
  if (current.language === 'javascript') {
    readStudioScript(text);
    config = { ...node.config, source: text };
  } else if (current.language === 'json') {
    const value: unknown = JSON.parse(text); assertJson(value);
    config = { ...node.config, value };
  } else if (current.language === 'markdown') config = { ...node.config, value: text };
  else {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error(document.errors[0]?.message ?? document.warnings[0]?.message);
    const value: unknown = document.toJS({ maxAliasCount: 0 }); assertJson(value);
    if (!isRecord(value)) throw new Error('A node definition must be a YAML mapping.');
    if (Object.keys(value).some(internal)) throw new Error('Presentation metadata is managed by Studio.');
    if (current.externalData && 'value' in value) throw new Error('The connector owns this collection snapshot. Edit its source or presentation fields.');
    config = { ...Object.fromEntries(Object.entries(node.config).filter(([key]) => internal(key))), ...value };
    if (current.externalData) config.value = node.config.value;
  }
  if (definition) {
    const validation = validateNodeConfig(definition, config);
    if (!validation.isValid) throw new Error(validation.errors.map(e => `${e.fieldKey}: ${e.message}`).join('\n'));
  }
  return config;
}

/** A single conflict-checked config mutation shared by manual and agent edits. */
export function applyStudioNodeSource(project: StudioProjectV1, nodeId: string, source: string, expectedSource: string,
  resolveDefinition: (node: StudioNodeInstance) => StudioNodeDefinition | null): boolean {
  const target = project.graph.nodes.find(node => node.id === nodeId);
  if (!target) throw new Error('The node no longer exists. Your draft is retained.');
  if (readStudioNodeSource(target).text !== expectedSource) throw new Error('Source changed outside this editor. Reload before applying your draft.');
  const config = parseStudioNodeSource(target, source, resolveDefinition(target));
  if (JSON.stringify(target.config) === JSON.stringify(config)) return false;
  target.config = config;
  return true;
}
