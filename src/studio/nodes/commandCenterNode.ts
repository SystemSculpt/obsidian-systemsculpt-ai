import type { StudioNodeDefinition } from '../types';
import { isRecord } from '../utils';
export type StudioCommandAction = { id: string; label: string; section: string; kind: 'run' | 'focus'; target: string; description: string };
export function readStudioCommandActions(value: unknown): StudioCommandAction[] {
  value = isRecord(value) ? value.items : value;
  if (!Array.isArray(value) || value.length > 40) throw new Error('A command center supports up to 40 actions.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100 || !['run','focus'].includes(String(item.kind))
      || typeof item.target !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.target)) throw new Error('Each command needs a unique ID, label, existing target node and run or focus action.');
    seen.add(item.id);
    return { id: item.id, label: item.label, kind: item.kind as 'run' | 'focus', target: item.target, section: String(item.section || 'Actions').slice(0, 80), description: String(item.description || '').slice(0, 300) };
  });
}
export const commandCenterNode: StudioNodeDefinition = {
  kind: 'studio.command_center', version: '1.0.0', requiredHostCapabilities: [], capabilityClass: 'local_cpu', cachePolicy: 'never', inputPorts: [], outputPorts: [],
  configDefaults: { description: '', execution: { model: 'gpt-6-astra', effort: 'high' }, actions: { items: [] } },
  configSchema: { fields: [{ key: 'description', label: 'Description', type: 'text' }, { key: 'execution', label: 'Agent execution', type: 'json_object' }, { key: 'actions', label: 'Actions', type: 'json_object' }], allowUnknownKeys: false },
  async execute() { throw new Error('Use the command center buttons to perform an explicit action.'); },
};
