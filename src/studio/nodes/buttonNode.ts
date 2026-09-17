import type { StudioNodeDefinition } from '../types';
export const buttonNode: StudioNodeDefinition = {
  kind: 'studio.button', version: '1.0.0', requiredHostCapabilities: [], capabilityClass: 'local_cpu', cachePolicy: 'never', inputPorts: [], outputPorts: [],
  configDefaults: { label: 'Run', action: 'run', target: '', description: '' },
  configSchema: { fields: [
    { key: 'label', label: 'Button label', type: 'text' },
    { key: 'action', label: 'Action', type: 'select', options: [{ value: 'run', label: 'Run node' }, { value: 'focus', label: 'Go to node' }] },
    { key: 'target', label: 'Target node ID', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
  ], allowUnknownKeys: false },
  async execute() { throw new Error('Press the button to perform its explicit action.'); },
};
