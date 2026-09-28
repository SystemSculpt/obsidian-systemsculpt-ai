import type { StudioJsonValue, StudioNodeInstance } from '../../../studio/types';

type Options = {
  node: StudioNodeInstance;
  onChange: (key: string, value: StudioJsonValue) => void;
};

/** Keep saved definitions readable without restoring their removed execution integration. */
export function renderStudioWorkflow(root: HTMLElement, { node }: Options): () => void {
  const body = root.createDiv({ cls: 'ss-studio-workflow' });
  body.createEl('p', { text: String(node.config.description || '') });
  body.createEl('p', {
    text: 'This saved workflow uses a removed execution integration. Use an on-machine Codex card to run new work.',
    attr: { role: 'status', 'data-testid': `studio.workflow.unavailable.${node.id}` },
  });
  return () => {};
}
