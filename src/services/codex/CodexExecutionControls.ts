import { hasHostCapability } from '../../platform/hostCapabilities';
import type SystemSculptPlugin from '../../main';
import { codexOptionsFromSettings, codexVaultDirectory } from './CodexExecutionSettings';
import { readCodexCatalog, type CodexModel } from './CodexModelCatalog';

/** Shared native-model controls; settings are read again at the beginning of each turn. */
export function mountCodexExecutionControls(parent: HTMLElement, plugin: SystemSculptPlugin, context?: { backend?: 'systemsculpt' | 'codex'; onProviderChange?: () => Promise<void> }): () => void {
  const root = parent.createDiv({ cls: 'ss-codex-controls' }); parent.prepend(root);
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Text execution');
  const createSelect = (title: string, key: string) => {
    const label = root.createEl('label', { cls: 'ss-codex-control', text: title });
    return label.createEl('select', { attr: { 'aria-label': title, 'data-testid': `codex.execution.${key}` } });
  };
  const provider = context ? createSelect('Provider', 'provider') : undefined;
  const desktop = hasHostCapability('local-cli', parent);
  const model = createSelect('Model', 'model'), thinking = createSelect('Thinking', 'thinking'), speed = createSelect('Speed', 'speed');
  const status = root.createEl('small', { cls: 'ss-codex-controls-status', attr: { role: 'status', 'aria-live': 'polite' } });
  const showStatus = (message: string) => { status.setText(message); status.hidden = !message; };
  const retry = root.createEl('button', { cls: 'ss-codex-retry', text: 'Reconnect Codex', attr: { type: 'button', 'data-testid': 'codex.execution.reconnect' } }); retry.hidden = true;
  const permissions = root.createEl('small', { cls: 'ss-codex-permissions', text: 'Permissions · Codex config' });
  permissions.title = 'Inherited from Codex configuration for this workspace. Change permissions in Codex. Configuration changes apply to the next turn.';
  const controller = new AbortController(); let models: CodexModel[] = [], disposed = false, loading = false, changing = false, catalogError = '';
  const backend = () => context?.backend ?? plugin.settings.textExecutionBackend ?? (context ? 'systemsculpt' : 'codex');
  const option = (select: HTMLSelectElement, value: string, label: string, disabled = false) => {
    const node = select.createEl('option', { value, text: label }); node.disabled = disabled;
  };
  const render = () => {
    if (disposed) return;
    const native = backend() === 'codex';
    parent.classList.toggle('ss-native-codex-composer', native);
    permissions.hidden = !native || !desktop;
    if (provider) {
      provider.empty(); option(provider, 'systemsculpt', 'SystemSculpt API');
      option(provider, 'codex', desktop ? 'On-machine Codex' : 'On-machine Codex · desktop only', !desktop);
      provider.value = backend(); provider.disabled = changing;
    }
    root.classList.toggle('is-codex', native && desktop);
    retry.hidden = !native || !desktop || !catalogError || loading;
    for (const select of [model, thinking, speed]) select.parentElement!.hidden = !native || !desktop;
    if (!native || !desktop) {
      showStatus('');
      return;
    }
    const selected = codexOptionsFromSettings(plugin.settings), current = models.find(item => item.model === selected.model);
    model.empty(); thinking.empty(); speed.empty();
    for (const item of models) option(model, item.model, item.name);
    if (!current) option(model, selected.model, selected.model);
    model.value = selected.model;
    const efforts = current?.efforts.length ? current.efforts : [selected.effort];
    for (const effort of efforts) option(thinking, effort, effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1));
    if (!efforts.includes(selected.effort)) option(thinking, selected.effort, `${selected.effort} (unavailable)`, true);
    thinking.value = selected.effort;
    option(speed, 'default', 'Normal'); option(speed, current?.fastTier || 'priority', current && !current.fastTier ? 'Fast (unavailable)' : 'Fast', Boolean(current && !current.fastTier));
    speed.value = selected.serviceTier;
    model.disabled = thinking.disabled = speed.disabled = models.length === 0;
    speed.title = selected.serviceTier === 'default' ? '' : 'Fast mode uses more of your Codex allowance.';
    showStatus(catalogError || (loading ? 'Connecting…' : ''));
    if (!models.length && !loading && !catalogError) void loadModels();
  };
  const save = async (values: Parameters<ReturnType<SystemSculptPlugin['getSettingsManager']>['updateSettings']>[0]) => {
    try { await plugin.getSettingsManager().updateSettings(values); render(); }
    catch (error) { if (!disposed) { render(); showStatus(error instanceof Error ? error.message : 'Could not save Codex options.'); } }
  };
  model.addEventListener('change', () => {
    const selected = models.find(item => item.model === model.value); if (!selected) return;
    const current = codexOptionsFromSettings(plugin.settings);
    void save({ codexModel: selected.model, codexThinkingLevel: selected.efforts.includes(current.effort) ? current.effort : selected.defaultEffort,
      codexServiceTier: current.serviceTier !== 'default' && selected.fastTier ? selected.fastTier : 'default' });
  });
  thinking.addEventListener('change', () => { void save({ codexThinkingLevel: thinking.value }); });
  speed.addEventListener('change', () => { void save({ codexServiceTier: speed.value }); });
  provider?.addEventListener('change', () => {
    const next = provider.value; if (changing || (next !== 'systemsculpt' && next !== 'codex') || (next === 'codex' && !desktop)) return;
    changing = true; provider.disabled = true;
    void plugin.getSettingsManager().updateSettings({ textExecutionBackend: next }).then(async () => {
      if (context?.onProviderChange) await context.onProviderChange();
    }).catch(error => { catalogError = error instanceof Error ? error.message : 'Could not switch provider.'; }).finally(() => { changing = false; render(); if (catalogError) showStatus(catalogError); });
  });
  const loadModels = async () => {
    if (disposed || loading) return;
    loading = true; catalogError = ''; render();
    try {
      const catalog = await readCodexCatalog(codexVaultDirectory(plugin.app), controller.signal);
      models = catalog.models; permissions.setText(`Permissions · ${catalog.permissions}`);
      if (!models.length) catalogError = 'No Codex models are available for this login.';
    }
    catch (error) { catalogError = error instanceof Error ? error.message : 'Could not read Codex models.'; }
    finally { loading = false; render(); }
  };
  retry.addEventListener('click', () => { void loadModels(); });
  const updated = plugin.app.workspace.on('systemsculpt:settings-updated', render);
  render();
  return () => { if (disposed) return; disposed = true; controller.abort(); plugin.app.workspace.offref(updated); parent.classList.remove('ss-native-codex-composer'); root.remove(); };
}
