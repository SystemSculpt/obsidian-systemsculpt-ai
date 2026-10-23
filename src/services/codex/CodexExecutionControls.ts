import { getHostOperatingSystem, hasHostCapability } from '../../platform/hostCapabilities';
import type SystemSculptPlugin from '../../main';
import { codexOptionsFromSettings, codexVaultDirectory, localAgentDetectionDirectory } from './CodexExecutionSettings';
import { LOCAL_AGENTS, isLocalAgentId, type TextExecutionBackend } from './LocalAgents';
import { mountCodexModelControls } from './CodexModelControls';
import { mountClaudeExecutionControls } from '../claude/ClaudeExecutionControls';
import { detectLocalAgents } from './LocalAgentDetection';

const CODEX_MODES = [['auto', 'Auto'], ['ask', 'Ask'], ['read-only', 'Read only'], ['settings', 'Codex settings']] as const;
const CLAUDE_MODES: Record<string, string> = { auto: 'Auto', manual: 'Ask before edits', default: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan only', settings: 'Claude Code settings' };

/** Global next-turn settings; existing chats retain their selected backend. */
export function mountCodexExecutionControls(parent: HTMLElement, plugin: SystemSculptPlugin, context?: { backend?: TextExecutionBackend; onProviderChange?: () => Promise<void>; claudeAutoUnavailable?: () => boolean }): () => void {
  const desktop = hasHostCapability('local-cli', parent), inChat = context?.backend !== undefined;
  const summary = inChat ? parent.createDiv({ cls: 'ss-agent-execution-summary', attr: { 'data-testid': 'chat.execution.summary' } }) : undefined;
  const running = summary?.createSpan();
  const change = summary?.createEl('button', { text: 'Change', attr: { type: 'button', 'data-testid': 'chat.execution.change', 'aria-expanded': 'false' } });
  const detect = desktop && context ? (summary ?? parent).createEl('button', { text: 'Detect again', attr: { type: 'button', 'data-testid': 'chat.execution.detect' } }) : undefined;
  const detectionStatus = context ? parent.createDiv({ cls: 'ss-agent-detection-status', attr: { role: 'status', 'aria-live': 'polite' } }) : undefined;
  const root = parent.createDiv({ cls: 'ss-codex-controls', attr: { role: 'group', 'aria-label': 'Text execution' } });
  parent.prepend(...[summary, detectionStatus, root].filter((element): element is HTMLDivElement => !!element));
  root.hidden = inChat;
  if (detectionStatus) detectionStatus.hidden = true;
  const provider = context ? root.createEl('label', { cls: 'ss-codex-control', text: 'Provider' }).createEl('select', { attr: { 'aria-label': 'Provider', 'data-testid': 'codex.execution.provider' } }) : undefined;
  const backend = () => desktop ? context?.backend ?? plugin.settings.textExecutionBackend ?? (context ? 'systemsculpt' : 'codex') : 'systemsculpt';
  let disposed = false, changing = false;
  const permissions = root.createEl('small', { cls: 'ss-codex-permissions' });
  const picker = mountCodexModelControls(root, { variant: 'chat', value: () => codexOptionsFromSettings(plugin.settings),
    enabled: () => desktop && backend() === 'codex', workingDirectory: () => codexVaultDirectory(plugin.app),
    onPermissions: description => permissions.setText(`Codex settings · ${description}`),
    onChange: patch => plugin.getSettingsManager().updateSettings({
      ...(patch.model === undefined ? {} : { codexModel: patch.model }),
      ...(patch.effort === undefined ? {} : { codexThinkingLevel: patch.effort }),
      ...(patch.serviceTier === undefined ? {} : { codexServiceTier: patch.serviceTier }),
    }),
  });
  const mode = root.createEl('label', { cls: 'ss-codex-control', text: 'Permissions' }).createEl('select', { attr: { 'aria-label': 'Codex permissions', 'data-testid': 'codex.execution.permissions' } });
  for (const [value, text] of CODEX_MODES) mode.createEl('option', { value, text });
  mode.title = 'Auto reviews requests in the vault workspace. Ask lets you review; Codex settings inherits your own configuration.';
  root.append(permissions);
  const claude = mountClaudeExecutionControls(root, plugin, () => desktop && backend() === 'claude');
  const render = () => {
    if (disposed) return;
    const selected = backend(), native = isLocalAgentId(selected);
    parent.classList.toggle('ss-native-codex-composer', native);
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
    if (running) {
      const host = getHostOperatingSystem() === 'macOS' ? 'this Mac' : 'this computer';
      const label = native ? `${LOCAL_AGENTS[selected]} on ${host}` : 'SystemSculpt';
      const permission = selected === 'claude' ? (context?.claudeAutoUnavailable?.() && (plugin.settings.claudePermissionMode ?? 'auto') === 'auto' ? 'Accept edits · Auto unavailable' : CLAUDE_MODES[plugin.settings.claudePermissionMode ?? 'auto'] ?? 'Ask before edits')
        : selected === 'codex' ? CODEX_MODES.find(([value]) => value === mode.value)?.[1] ?? 'Ask'
          : ({ auto: 'Auto', ask: 'Ask', 'full-access': 'Full access' }[parent.querySelector<HTMLSelectElement>('[data-testid="chat.composer.approval-mode"]')?.value ?? 'auto'] ?? 'Ask');
      running.setText(`${label} · ${permission} ·`);
      summary?.setAttribute('aria-label', `Chat runs on ${label}, ${permission} mode. Change.`);
    }
    picker.refresh(); claude.refresh();
  };
  change?.addEventListener('click', () => {
    root.hidden = !root.hidden; change.setAttribute('aria-expanded', String(!root.hidden));
    if (!root.hidden) provider?.focus();
  });
  detect?.addEventListener('click', () => {
    detect.disabled = true;
    if (detectionStatus) { detectionStatus.setText('Finding Claude Code or Codex…'); detectionStatus.hidden = false; }
    void detectLocalAgents({ force: true, workingDirectory: localAgentDetectionDirectory(plugin.app) }).then(result => {
      if (disposed || !detectionStatus) return;
      const label = isLocalAgentId(result.preferred) ? LOCAL_AGENTS[result.preferred] : 'SystemSculpt';
      detectionStatus.setText(`Detected: ${label}. ${plugin.settings.textExecutionBackendExplicit ? 'Your choice is unchanged.' : 'Used for your next new chat.'}`);
      detectionStatus.hidden = false;
    }).catch(() => {
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
    void plugin.getSettingsManager().updateSettings({ textExecutionBackend: next, textExecutionBackendExplicit: true }).then(() => context?.onProviderChange?.())
      .catch(cause => picker.showError(cause instanceof Error ? cause.message : 'Could not switch provider.')).finally(() => { changing = false; render(); });
  });
  parent.addEventListener('systemsculpt:approval-mode', render);
  const updated = plugin.app.workspace.on('systemsculpt:settings-updated', render); render();
  return () => { if (disposed) return; disposed = true; picker.dispose(); claude.dispose(); plugin.app.workspace.offref(updated); parent.removeEventListener('systemsculpt:approval-mode', render); parent.classList.remove('ss-native-codex-composer'); root.remove(); summary?.remove(); detectionStatus?.remove(); if (!summary) detect?.remove(); };
}
