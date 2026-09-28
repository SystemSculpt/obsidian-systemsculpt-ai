import type { StudioNodeDefinition } from '../types';

export const codexNode: StudioNodeDefinition = {
  kind: 'studio.codex', version: '1.0.0', requiredHostCapabilities: ['local-cli'], capabilityClass: 'local_io', cachePolicy: 'never',
  inputPorts: [{ id: 'context', type: 'json', required: false }], outputPorts: [{ id: 'json', type: 'json' }],
  configDefaults: { prompt: 'Describe the task to carry out.', workingDirectory: '.', threadId: '', input: {} },
  configSchema: { fields: [
    { key: 'prompt', label: 'Task prompt', type: 'textarea', required: true },
    { key: 'workingDirectory', label: 'Working directory', type: 'directory_path', allowOutsideVault: true, required: true },
    { key: 'threadId', label: 'Resume Codex thread (optional)', type: 'text' },
    { key: 'model', label: 'Model override (optional)', type: 'text' },
    { key: 'effort', label: 'Thinking level override (optional)', type: 'text' },
    { key: 'serviceTier', label: 'Speed override: default or priority (optional)', type: 'text' },
    { key: 'input', label: 'Task input', type: 'json_object' },
  ], allowUnknownKeys: false },
  async execute(context) {
    if (!context.services.codex) throw new Error('Local Codex execution is unavailable.');
    const config = context.node.config;
    const prompt = `${String(config.prompt || '')}\n\nTask input:\n${JSON.stringify(config.input || {})}\n\nConnected context:\n${JSON.stringify(context.inputs.context ?? null)}`;
    const overrides = Object.fromEntries(['model', 'effort', 'serviceTier'].filter(key => typeof config[key] === 'string' && String(config[key]).trim()).map(key => [key, String(config[key])]));
    const result = await context.services.codex({ ...overrides, prompt, workingDirectory: String(config.workingDirectory || ''), threadId: String(config.threadId || '') }, context.signal, context.log);
    return { outputs: { json: result } };
  },
};
