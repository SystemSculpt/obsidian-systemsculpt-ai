import type { StudioNodeDefinition, StudioPortDefinition } from '../types';
export function runCollectionPorts(sources: unknown): StudioPortDefinition[] {
  return Array.isArray(sources) ? [...new Set(sources.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)))].slice(0, 100).map(id => ({ id, type: 'json', required: false })) : [];
}
export const runCollectionNode: StudioNodeDefinition = {
  kind: 'studio.run_collection', version: '1.0.0', requiredHostCapabilities: [], capabilityClass: 'local_cpu', cachePolicy: 'never', inputPorts: [], outputPorts: [],
  configDefaults: { sources: [], groupBy: 'status', showCompleted: true },
  configSchema: { fields: [
    { key: 'sources', label: 'Connected role IDs', type: 'string_list' },
    { key: 'groupBy', label: 'Group by', type: 'select', options: [{ value: 'status', label: 'Status' }, { value: 'role', label: 'Role' }] },
    { key: 'showCompleted', label: 'Show completed runs', type: 'boolean' },
  ], allowUnknownKeys: false },
  async execute() { throw new Error('A run collection observes its connected roles; it does not execute them.'); },
};
