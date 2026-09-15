import type { App } from 'obsidian';
import { readCodexCatalog, type CodexModel } from '../../../services/codex/CodexModelCatalog';
import { codexVaultDirectory } from '../../../services/codex/CodexExecutionSettings';
import { readStudioCommandExecution, type StudioCommandExecution } from '../../../studio/StudioCommandExecution';
import { hasHostCapability } from '../../../platform/hostCapabilities';
import { createStudioAction } from '../StudioAction';

export function renderStudioCommandExecution(root: HTMLElement, options: { value: unknown; app?: App; onChange?: (value: StudioCommandExecution) => void }): () => void {
  const row = root.createDiv({ cls: 'ss-studio-command-execution' });
  let selection = readStudioCommandExecution(options.value), models: CodexModel[] = [], disposed = false;
  const controller = new AbortController();
  const field = (name: string): HTMLSelectElement => {
    const label = row.createEl('label', { cls: 'ss-studio-command-execution-field' }); label.createSpan({ text: name });
    return label.createEl('select', { attr: { 'aria-label': name, 'data-testid': `studio.command.${name.toLowerCase()}` } });
  };
  const model = field('Model'), effort = field('Reasoning');
  row.createSpan({ cls: 'ss-studio-command-standard', text: 'Standard', attr: { title: 'All agents launched here use Standard service.' } });
  const status = row.createDiv({ cls: 'ss-studio-command-execution-status', attr: { role: 'status' } });
  const desktop = hasHostCapability('local-cli', root);
  const render = (): void => {
    model.empty(); effort.empty();
    for (const entry of models) model.createEl('option', { text: entry.name, value: entry.model });
    if (!models.some(entry => entry.model === selection.model)) model.createEl('option', { text: selection.model, value: selection.model });
    model.value = selection.model;
    const supported = models.find(entry => entry.model === selection.model)?.efforts || [];
    for (const value of new Set([...supported, selection.effort])) effort.createEl('option', { text: value.charAt(0).toUpperCase() + value.slice(1), value });
    effort.value = selection.effort;
    model.disabled = !desktop || !options.onChange || !models.length;
    effort.disabled = !desktop || !options.onChange || !supported.length;
  };
  model.addEventListener('change', () => {
    const entry = models.find(entry => entry.model === model.value); if (!entry) return;
    selection = { model: entry.model, effort: entry.efforts.includes(selection.effort) ? selection.effort : entry.defaultEffort };
    render(); status.setText(''); options.onChange?.({ ...selection });
  });
  effort.addEventListener('change', () => { selection = { ...selection, effort: effort.value }; status.setText(''); options.onChange?.({ ...selection }); });
  const load = async (): Promise<void> => {
    if (!options.app || !desktop) return;
    status.setText('Loading available models…');
    try {
      const catalog = await readCodexCatalog(codexVaultDirectory(options.app), controller.signal); if (disposed) return;
      models = catalog.models; render();
      const selected = models.find(entry => entry.model === selection.model);
      status.setText(!selected ? 'Saved model is unavailable in the current Codex catalog.' : !selected.efforts.includes(selection.effort) ? 'Choose a supported reasoning level for this model.' : '');
    } catch (error) {
      if (disposed) return;
      status.setText(error instanceof Error ? error.message : 'Unable to load models.');
      createStudioAction(status, { label: 'Retry', icon: 'refresh-cw', testId: 'studio.command.models-retry', onSelect: () => { void load(); } });
    }
  };
  render(); if (!desktop) status.setText('Agent execution settings are available on desktop.');
  void load(); return () => { disposed = true; controller.abort(); };
}
