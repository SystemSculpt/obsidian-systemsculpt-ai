import type { StudioNodeDefinition } from '../types';

export const workflowNode: StudioNodeDefinition = {
  kind: 'studio.workflow', version: '1.0.0', requiredHostCapabilities: ['local-cli'], capabilityClass: 'local_io', cachePolicy: 'never',
  inputPorts: [{ id: 'context', type: 'json', required: false }], outputPorts: [{ id: 'json', type: 'json' }],
  configDefaults: { workspaceId: '', workflowId: '', description: '', input: {} },
  configSchema: { fields: [
    { key: 'workspaceId', label: 'Workspace', type: 'text', required: true },
    { key: 'workflowId', label: 'Workflow', type: 'text', required: true },
    { key: 'roleId', label: 'Role', type: 'text' },
    { key: 'description', label: 'Objective', type: 'textarea' },
    { key: 'input', label: 'Run input', type: 'json_object' },
    { key: 'revision', label: 'Definition revision', type: 'text' },
    { key: 'steps', label: 'Workflow steps', type: 'json_object' },
    { key: 'availability', label: 'Execution connection status', type: 'json_object' },
    { key: 'lastRunId', label: 'Last run', type: 'text' },
    { key: 'selectedTaskId', label: 'Selected instance', type: 'text' },
    { key: 'pendingRequest', label: 'Pending request', type: 'json_object' },
  ], allowUnknownKeys: false },
  async execute() {
    throw new Error('This saved workflow uses a removed execution integration. Use an on-machine Codex card to run new work.');
  },
};
