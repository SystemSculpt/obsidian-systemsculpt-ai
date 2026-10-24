import type { StudioNodeInstance } from '../../../studio/types';

type Options = {
  node: StudioNodeInstance;
};

/** Keep saved definitions readable without restoring their removed execution integration. */
export function renderStudioWorkflow(root: HTMLElement, { node }: Options): () => void {
  const body = root.createDiv({ cls: 'ss-studio-workflow' });
  body.createEl('p', { text: String(node.config.description || '') });
  body.createEl('p', {
    text: 'Retired workflow note. This saved workflow uses a removed execution integration and never runs. Its configuration and connections are preserved for reference. Inspect its saved data with the source toggle. Use an on-machine Codex card to run new work.',
    attr: { role: 'status', 'data-testid': `studio.workflow.unavailable.${node.id}` },
  });
  return () => {};
}
