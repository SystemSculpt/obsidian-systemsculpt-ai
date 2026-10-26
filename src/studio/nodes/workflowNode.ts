import type { StudioNodeDefinition } from '../types';

/**
 * Retired, visual-only note (like the legacy terminal). Keep its kind and ports
 * so saved v1/v2 definitions and connections still validate and round-trip.
 * StudioRunScope excludes it and its connections from all graph execution.
 */
export const workflowNode: StudioNodeDefinition = {
  kind: 'studio.workflow', version: '1.0.0', hiddenFromInsertMenu: true,
  requiredHostCapabilities: [], capabilityClass: 'local_cpu', cachePolicy: 'never',
  inputPorts: [{ id: 'context', type: 'json', required: false }], outputPorts: [{ id: 'json', type: 'json' }],
  configDefaults: {},
  configSchema: { fields: [], allowUnknownKeys: true },
  async execute() {
    return { outputs: {} };
  },
};
