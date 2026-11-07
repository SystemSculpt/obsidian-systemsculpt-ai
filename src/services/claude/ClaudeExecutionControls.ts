import type SystemSculptPlugin from '../../main';
import { claudeOptionsFromSettings, CLAUDE_MODELS, CLAUDE_PERMISSION_MODES, CLAUDE_PERMISSION_LABELS, isClaudePermissionMode, type ClaudePermissionMode } from './ClaudeExecutionOptions';


/** Next-turn Claude Code choices. Login, tools and permission rules stay in Claude Code. */
export function mountClaudeExecutionControls(root: HTMLElement, plugin: SystemSculptPlugin, enabled: () => boolean): { refresh: () => void; dispose: () => void } {
  const field = (label: string, key: string) => {
    const element = root.createEl('label', { cls: 'ss-codex-control', text: label });
    return element.createEl('select', { attr: { 'aria-label': label, 'data-testid': `claude.execution.${key}` } });
  };
  const model = field('Model', 'model'), permissions = field('Permissions', 'permissions');
  permissions.title = 'When the agent asks before using tools in this vault. The last choice keeps your own configuration.';
  const status = root.createEl('small', { cls: 'ss-codex-controls-status', attr: { role: 'status', 'aria-live': 'polite' } });
  let disposed = false;
  const fill = (select: HTMLSelectElement, choices: readonly [string, string][], value: string) => {
    select.empty();
    for (const [option, label] of choices) select.createEl('option', { value: option, text: label });
    if (!choices.some(([option]) => option === value)) select.createEl('option', { value, text: value });
    select.value = value;
  };
  const refresh = () => {
    if (disposed) return;
    const visible = enabled();
    let selected;
    try { selected = claudeOptionsFromSettings(plugin.settings); status.setText(''); }
    catch (cause) { selected = { model: '', permissionMode: 'auto' }; status.setText(cause instanceof Error ? cause.message : 'Invalid Claude Code options.'); }
    fill(model, CLAUDE_MODELS.map(([value, label]) => [value, value ? label : 'Claude Code default']), selected.model); fill(permissions, CLAUDE_PERMISSION_MODES.map(value => [value, CLAUDE_PERMISSION_LABELS[value]]), selected.permissionMode);
    for (const select of [model, permissions]) select.parentElement!.hidden = !visible;
    status.hidden = !visible || !status.textContent;
  };
  const save = (patch: { claudeModel?: string; claudePermissionMode?: ClaudePermissionMode }) => {
    if (!enabled()) return;
    void plugin.getSettingsManager().updateSettings(patch).catch(cause => { status.setText(cause instanceof Error ? cause.message : 'Could not save Claude Code options.'); status.hidden = false; });
  };
  model.addEventListener('change', () => save({ claudeModel: model.value }));
  permissions.addEventListener('change', () => {
    const value = permissions.value;
    if (isClaudePermissionMode(value)) save({ claudePermissionMode: value });
  });
  refresh();
  return { refresh, dispose: () => { disposed = true; } };
}
