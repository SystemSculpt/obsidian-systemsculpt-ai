import type { StudioNodeDefinition } from '../types';
import { readStudioScript, STUDIO_SCRIPT_RUNNER, STUDIO_SCRIPT_TEMPLATE } from '../StudioScript';
import { processNode } from './processNode';

export const scriptNode: StudioNodeDefinition = {
  kind: 'studio.script', version: '1.0.0', requiredHostCapabilities: ['local-cli'], capabilityClass: 'local_io', cachePolicy: 'never',
  inputPorts: [], outputPorts: [],
  configDefaults: { source: STUDIO_SCRIPT_TEMPLATE },
  configSchema: { fields: [{ key: 'source', label: 'JavaScript module', type: 'textarea', required: true }], allowUnknownKeys: false },
  async execute(context) {
    const { source, processConfig } = readStudioScript(context.node.config.source);
    const files: string[] = [];
    try {
      for (const [prefix, text] of [['studio-script', source], ['studio-script-runner', STUDIO_SCRIPT_RUNNER]]) {
        files.push(await context.services.writeTempFile(new TextEncoder().encode(text).buffer, { prefix, extension: 'mjs' }));
      }
      return await processNode.execute({ ...context, node: { ...context.node, kind: 'studio.process', config: { ...processConfig, arguments: [files[1], files[0]] } } });
    } finally {
      await Promise.all(files.map(file => context.services.deleteLocalFile(file).catch(() => {})));
    }
  },
};
