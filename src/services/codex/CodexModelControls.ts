import { readCodexCatalog, type CodexModel } from './CodexModelCatalog';
import type { CodexExecutionOptions } from './CodexExecutionSettings';

type Options = {
  variant: 'chat' | 'command';
  value: () => Required<CodexExecutionOptions>;
  onChange?: (patch: CodexExecutionOptions) => void | Promise<void>;
  enabled: () => boolean;
  workingDirectory: () => string;
  onPermissions?: (description: string) => void;
};

/** One native picker owns catalog loading, compatible choices, errors, and teardown. */
export function mountCodexModelControls(root: HTMLElement, options: Options): { refresh: () => void; showError: (message: string) => void; dispose: () => void } {
  const command = options.variant === 'command', prefix = command ? 'studio.command' : 'codex.execution';
  const field = (label: string, key: string) => {
    const element = root.createEl('label', { cls: command ? 'ss-studio-command-execution-field' : 'ss-codex-control', text: label });
    return element.createEl('select', { attr: { 'aria-label': label, 'data-testid': `${prefix}.${key}` } });
  };
  const model = field('Model', 'model'), effort = field(command ? 'Reasoning' : 'Thinking', command ? 'reasoning' : 'thinking');
  const speed = command ? undefined : field('Speed', 'speed');
  if (command) root.createSpan({ cls: 'ss-studio-command-standard', text: 'Standard', attr: { title: 'All agents launched here use Standard service.' } });
  const status = root.createEl('small', { cls: command ? 'ss-studio-command-execution-status' : 'ss-codex-controls-status', attr: { role: 'status', 'aria-live': 'polite' } });
  const retry = root.createEl('button', { cls: 'ss-codex-retry', text: command ? 'Retry' : 'Reconnect Codex', attr: { type: 'button', 'data-testid': command ? 'studio.command.models-retry' : 'codex.execution.reconnect' } });
  const controller = new AbortController(); let models: CodexModel[] = [], disposed = false, loading = false, loaded = false, error = '', actionError = '', pendingChanges = 0;
  const option = (select: HTMLSelectElement, value: string, label: string, disabled = false) => { select.createEl('option', { value, text: label }).disabled = disabled; };
  const render = () => {
    if (disposed || pendingChanges) return;
    const enabled = options.enabled(), selected = options.value(), current = models.find(item => item.model === selected.model);
    model.empty(); effort.empty(); speed?.empty();
    for (const entry of models) option(model, entry.model, entry.name);
    if (!current) option(model, selected.model, selected.model);
    model.value = selected.model;
    const supported = current?.efforts || [];
    for (const value of new Set([...supported, selected.effort])) option(effort, value, value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1), !!current && !supported.includes(value));
    effort.value = selected.effort;
    if (speed) {
      option(speed, 'default', 'Normal'); option(speed, current?.fastTier || 'priority', current && !current.fastTier ? 'Fast (unavailable)' : 'Fast', !!current && !current.fastTier);
      speed.value = selected.serviceTier; speed.title = selected.serviceTier === 'default' ? '' : 'Fast mode uses more of your Codex allowance.';
    }
    for (const select of [model, effort, speed].filter((value): value is HTMLSelectElement => !!value)) {
      select.disabled = !enabled || !options.onChange || !models.length;
      select.parentElement!.hidden = !command && !enabled;
    }
    if (command) effort.disabled ||= !supported.length;
    const message = actionError || (!enabled ? (command ? 'Agent execution settings are available on desktop.' : '') : error || (loading ? 'Connecting…' : loaded && !current ? 'Saved model is unavailable in the current Codex catalog.' : loaded && !supported.includes(selected.effort) ? 'Choose a supported reasoning level for this model.' : ''));
    status.setText(message); status.hidden = !message; retry.hidden = !enabled || !error || loading;
    if (retry.hidden) retry.remove(); else status.after(retry);
  };
  const showError = (message: string) => { actionError = message; render(); };
  const load = async () => {
    if (disposed || loading || !options.enabled()) return;
    loading = true; error = ''; actionError = ''; render();
    try {
      const catalog = await readCodexCatalog(options.workingDirectory(), controller.signal); if (disposed) return;
      models = catalog.models; loaded = true; options.onPermissions?.(catalog.permissions);
      if (!models.length) error = 'No Codex models are available for this login.';
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not read Codex models.'; }
    finally { loading = false; render(); }
  };
  const change = (patch: CodexExecutionOptions) => {
    if (disposed || !options.enabled() || !options.onChange) return;
    pendingChanges++; actionError = '';
    const settled = () => { pendingChanges--; render(); };
    try {
      const saving = options.onChange(patch);
      if (saving) void saving.catch(cause => showError(cause instanceof Error ? cause.message : 'Could not save Codex options.')).finally(settled);
      else settled();
    } catch (cause) { showError(cause instanceof Error ? cause.message : 'Could not save Codex options.'); settled(); }
  };
  model.addEventListener('change', () => {
    const next = models.find(item => item.model === model.value); if (!next) return;
    change({ model: next.model, effort: next.efforts.includes(effort.value) ? effort.value : next.defaultEffort, serviceTier: speed && speed.value !== 'default' && next.fastTier ? next.fastTier : 'default' });
  });
  effort.addEventListener('change', () => change({ effort: effort.value }));
  speed?.addEventListener('change', () => change({ serviceTier: speed.value }));
  retry.addEventListener('click', () => { void load(); });
  const refresh = () => { render(); if (!loaded && !error) void load(); };
  refresh();
  return { refresh, showError, dispose: () => { disposed = true; controller.abort(); } };
}
