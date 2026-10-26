import { hasHostCapability } from '../../platform/hostCapabilities';
import type SystemSculptPlugin from '../../main';
import { codexOptionsFromSettings, codexVaultDirectory, localAgentDetectionDirectory } from './CodexExecutionSettings';
import { LOCAL_AGENTS, isLocalAgentId } from './LocalAgents';
import { mountCodexModelControls } from './CodexModelControls';
import { mountClaudeExecutionControls } from '../claude/ClaudeExecutionControls';
import { detectLocalAgents, subscribeLocalAgentDetection, type LocalAgentDetection } from './LocalAgentDetection';

const CODEX_MODES = [['auto', 'Auto'], ['ask', 'Ask'], ['read-only', 'Read only'], ['settings', 'Codex settings']] as const;

/**
 * Settings defaults for new chats: provider, Codex and Claude Code choices.
 * Chat itself switches these from its run line (AgentRunLine).
 */
export function mountCodexExecutionControls(parent: HTMLElement, plugin: SystemSculptPlugin, context?: Record<string, never>): () => void {
  const desktop = hasHostCapability('local-cli', parent);
  const detect = desktop && context ? parent.createEl('button', { text: 'Detect again', attr: { type: 'button', 'data-testid': 'chat.execution.detect' } }) : undefined;
  const detectionStatus = context ? parent.createDiv({ cls: 'ss-agent-detection-status', attr: { role: 'status', 'aria-live': 'polite' } }) : undefined;
  const root = parent.createDiv({ cls: 'ss-codex-controls', attr: { role: 'group', 'aria-label': 'Text execution' } });
  parent.prepend(...[detectionStatus, root].filter((element): element is HTMLDivElement => !!element));
  if (detectionStatus) detectionStatus.hidden = true;
  const provider = context ? root.createEl('label', { cls: 'ss-codex-control', text: 'Provider' }).createEl('select', { attr: { 'aria-label': 'Provider', 'data-testid': 'codex.execution.provider' } }) : undefined;
  const backend = () => desktop ? plugin.settings.textExecutionBackend ?? (context ? 'systemsculpt' : 'codex') : 'systemsculpt';
  let disposed = false, changing = false;
  const permissions = root.createEl('small', { cls: 'ss-codex-permissions' });
  const picker = mountCodexModelControls(root, { variant: 'chat', value: () => codexOptionsFromSettings(plugin.settings),
    enabled: () => desktop && backend() === 'codex', workingDirectory: () => codexVaultDirectory(plugin.app),
    onPermissions: description => permissions.setText(`Codex settings · ${description}`),
    onChange: async patch => {
      await plugin.getSettingsManager().updateSettings({
        ...(patch.model === undefined ? {} : { codexModel: patch.model }),
        ...(patch.effort === undefined ? {} : { codexThinkingLevel: patch.effort }),
        ...(patch.serviceTier === undefined ? {} : { codexServiceTier: patch.serviceTier }),
      });
    },
  });
  const mode = root.createEl('label', { cls: 'ss-codex-control', text: 'Permissions' }).createEl('select', { attr: { 'aria-label': 'Codex permissions', 'data-testid': 'codex.execution.permissions' } });
  for (const [value, text] of CODEX_MODES) mode.createEl('option', { value, text });
  mode.title = 'Auto reviews requests in the vault workspace. Ask lets you review; Codex settings inherits your own configuration.';
  root.append(permissions);
  const claude = mountClaudeExecutionControls(root, plugin, () => desktop && backend() === 'claude');
  const render = () => {
    if (disposed) return;
    const selected = backend();
    permissions.hidden = selected !== 'codex' || !desktop || plugin.settings.codexApprovalMode !== 'settings';
    mode.parentElement!.hidden = selected !== 'codex' || !desktop;
    mode.value = plugin.settings.codexApprovalMode ?? 'auto';
    root.classList.toggle('is-codex', selected === 'codex' && desktop);
    root.classList.toggle('is-claude', selected === 'claude' && desktop);
    if (provider) {
      provider.empty();
      provider.createEl('option', { value: 'systemsculpt', text: 'SystemSculpt' });
      for (const [id, name] of Object.entries(LOCAL_AGENTS)) provider.createEl('option', { value: id, text: desktop ? name : `${name} · desktop only` }).disabled = !desktop;
      provider.value = selected; provider.disabled = changing;
    }
    picker.refresh(); claude.refresh();
  };
  const showDetection = (result: LocalAgentDetection) => {
    if (disposed || !detectionStatus || detectionStatus.hidden) return;
    const label = isLocalAgentId(result.preferred) ? LOCAL_AGENTS[result.preferred] : 'SystemSculpt';
    detectionStatus.setText(`Detected: ${label}. ${plugin.settings.textExecutionBackendExplicit ? 'Your choice is unchanged.' : 'Used for your next new chat.'}`);
  };
  const stopDetection = detect ? subscribeLocalAgentDetection(localAgentDetectionDirectory(plugin.app), showDetection) : undefined;
  detect?.addEventListener('click', () => {
    detect.disabled = true;
    if (detectionStatus) { detectionStatus.setText('Finding Claude Code or Codex…'); detectionStatus.hidden = false; }
    void detectLocalAgents({ force: true, workingDirectory: localAgentDetectionDirectory(plugin.app) }).then(showDetection).catch(() => {
      if (!disposed && detectionStatus) detectionStatus.setText('Could not detect local agents. Please try again.');
    }).finally(() => { detect.disabled = false; });
  });
  mode.addEventListener('change', () => {
    const value = mode.value;
    if (value === 'auto' || value === 'ask' || value === 'read-only' || value === 'settings') {
      void plugin.getSettingsManager().updateSettings({ codexApprovalMode: value }).catch(cause => picker.showError(String(cause)));
    }
  });
  provider?.addEventListener('change', () => {
    const next = provider.value; if (changing || (next !== 'systemsculpt' && !isLocalAgentId(next)) || (next !== 'systemsculpt' && !desktop)) return;
    changing = true; provider.disabled = true;
    void plugin.getSettingsManager().updateSettings({ textExecutionBackend: next, textExecutionBackendExplicit: true })
      .catch(cause => picker.showError(cause instanceof Error ? cause.message : 'Could not switch provider.')).finally(() => { changing = false; render(); });
  });
  const updated = plugin.app.workspace.on('systemsculpt:settings-updated', (_oldSettings, _newSettings, changedKeys) => {
    if (changedKeys.some(key => [
      'textExecutionBackend', 'codexModel', 'codexThinkingLevel', 'codexServiceTier',
      'codexApprovalMode', 'claudeModel', 'claudePermissionMode',
    ].includes(key))) render();
  });
  render();
  return () => { if (disposed) return; disposed = true; stopDetection?.(); picker.dispose(); claude.dispose(); plugin.app.workspace.offref(updated); root.remove(); detectionStatus?.remove(); detect?.remove(); };
}
