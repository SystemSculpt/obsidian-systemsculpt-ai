import { hasHostCapability } from '../../platform/hostCapabilities';
import type SystemSculptPlugin from '../../main';
import { codexOptionsFromSettings, codexVaultDirectory } from './CodexExecutionSettings';
import { mountCodexModelControls } from './CodexModelControls';

/** Global next-turn settings; existing chats retain their selected backend. */
export function mountCodexExecutionControls(parent: HTMLElement, plugin: SystemSculptPlugin, context?: { backend?: 'systemsculpt' | 'codex'; onProviderChange?: () => Promise<void> }): () => void {
  const root = parent.createDiv({ cls: 'ss-codex-controls', attr: { role: 'group', 'aria-label': 'Text execution' } }); parent.prepend(root);
  const provider = context ? root.createEl('label', { cls: 'ss-codex-control', text: 'Provider' }).createEl('select', { attr: { 'aria-label': 'Provider', 'data-testid': 'codex.execution.provider' } }) : undefined;
  const desktop = hasHostCapability('local-cli', parent);
  const backend = () => context?.backend ?? plugin.settings.textExecutionBackend ?? (context ? 'systemsculpt' : 'codex');
  let disposed = false, changing = false;
  const permissions = root.createEl('small', { cls: 'ss-codex-permissions', text: 'Permissions · Codex config' });
  permissions.title = 'Inherited from Codex configuration for this workspace. Change permissions in Codex. Configuration changes apply to the next turn.';
  const picker = mountCodexModelControls(root, { variant: 'chat', value: () => codexOptionsFromSettings(plugin.settings),
    enabled: () => desktop && backend() === 'codex', workingDirectory: () => codexVaultDirectory(plugin.app),
    onPermissions: description => permissions.setText(`Permissions · ${description}`),
    onChange: patch => plugin.getSettingsManager().updateSettings({
      ...(patch.model === undefined ? {} : { codexModel: patch.model }),
      ...(patch.effort === undefined ? {} : { codexThinkingLevel: patch.effort }),
      ...(patch.serviceTier === undefined ? {} : { codexServiceTier: patch.serviceTier }),
    }),
  });
  root.append(permissions);
  const render = () => {
    if (disposed) return;
    const native = backend() === 'codex'; parent.classList.toggle('ss-native-codex-composer', native);
    permissions.hidden = !native || !desktop; root.classList.toggle('is-codex', native && desktop);
    if (provider) {
      provider.empty(); provider.createEl('option', { value: 'systemsculpt', text: 'SystemSculpt API' });
      provider.createEl('option', { value: 'codex', text: desktop ? 'On-machine Codex' : 'On-machine Codex · desktop only' }).disabled = !desktop;
      provider.value = backend(); provider.disabled = changing;
    }
    picker.refresh();
  };
  provider?.addEventListener('change', () => {
    const next = provider.value; if (changing || (next !== 'systemsculpt' && next !== 'codex') || (next === 'codex' && !desktop)) return;
    changing = true; provider.disabled = true;
    void plugin.getSettingsManager().updateSettings({ textExecutionBackend: next }).then(() => context?.onProviderChange?.())
      .catch(cause => picker.showError(cause instanceof Error ? cause.message : 'Could not switch provider.')).finally(() => { changing = false; render(); });
  });
  const updated = plugin.app.workspace.on('systemsculpt:settings-updated', render); render();
  return () => { if (disposed) return; disposed = true; picker.dispose(); plugin.app.workspace.offref(updated); parent.classList.remove('ss-native-codex-composer'); root.remove(); };
}
