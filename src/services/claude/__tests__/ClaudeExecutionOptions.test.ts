import { CLAUDE_PERMISSION_MODES, CLAUDE_PERMISSION_LABELS, isClaudePermissionMode, resolveClaudeOptions, claudeOptionsFromSettings } from '../ClaudeExecutionOptions';

describe('Claude execution option contract', () => {
  it('shares all supported modes with normalization and presentation', () => {
    for (const permissionMode of CLAUDE_PERMISSION_MODES) {
      expect(isClaudePermissionMode(permissionMode)).toBe(true);
      expect(CLAUDE_PERMISSION_LABELS[permissionMode]).toBeTruthy();
      expect(resolveClaudeOptions({ permissionMode }).permissionMode).toBe(permissionMode);
    }
    expect(resolveClaudeOptions({})).toEqual({ model: '', permissionMode: 'auto' });
    expect(resolveClaudeOptions({ permissionMode: ' default ' }).permissionMode).toBe('manual');
    expect(claudeOptionsFromSettings({ claudeModel: ' sonnet ', claudePermissionMode: 'settings' }))
      .toEqual({ model: 'sonnet', permissionMode: 'settings' });
  });

  it.each(['bypassPermissions', 'dontAsk', 'unknown'])('never accepts %s', permissionMode => {
    expect(isClaudePermissionMode(permissionMode)).toBe(false);
    expect(() => resolveClaudeOptions({ permissionMode })).toThrow('Invalid Claude Code permission mode.');
  });
});
