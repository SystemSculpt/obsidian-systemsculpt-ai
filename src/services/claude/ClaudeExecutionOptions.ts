export const CLAUDE_PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'settings'] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];
export type ClaudeExecutionOptions = { model?: string; permissionMode?: string };

export const CLAUDE_PERMISSION_LABELS: Readonly<Record<ClaudePermissionMode, string>> = {
  auto: 'Auto', manual: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan only', settings: 'Claude Code settings',
};
export const CLAUDE_MODELS: readonly (readonly [string, string, string?])[] = [
  ['', 'Default', "Claude Code's choice"], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'],
];

export function isClaudePermissionMode(value: string): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

export function resolveClaudeOptions(options: ClaudeExecutionOptions): Required<ClaudeExecutionOptions> & { permissionMode: ClaudePermissionMode } {
  const model = options.model?.trim() || '';
  const selected = options.permissionMode?.trim() || 'auto';
  // "default" was the old CLI spelling of Ask; persisted defaults migrate to Auto.
  const permissionMode = selected === 'default' ? 'manual' : selected;
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/.test(model)) throw new Error('Invalid Claude Code model.');
  if (!isClaudePermissionMode(permissionMode)) throw new Error('Invalid Claude Code permission mode.');
  return { model, permissionMode };
}

export function claudeOptionsFromSettings(settings: { claudeModel?: string; claudePermissionMode?: string }): ReturnType<typeof resolveClaudeOptions> {
  return resolveClaudeOptions({ model: settings.claudeModel, permissionMode: settings.claudePermissionMode });
}
