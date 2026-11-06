export const CODEX_APPROVAL_MODES = ['auto', 'ask', 'read-only', 'settings'] as const;
export type CodexApprovalMode = typeof CODEX_APPROVAL_MODES[number];

export const CODEX_APPROVAL_LABELS: Readonly<Record<CodexApprovalMode, string>> = {
  auto: 'Auto', ask: 'Ask', 'read-only': 'Read only', settings: 'Codex settings',
};

export function isCodexApprovalMode(value: string): value is CodexApprovalMode {
  return (CODEX_APPROVAL_MODES as readonly string[]).includes(value);
}

export function resolveCodexApprovalMode(value?: string): CodexApprovalMode {
  const mode = value?.trim() || 'auto';
  if (!isCodexApprovalMode(mode)) throw new Error('Invalid Codex approval mode.');
  return mode;
}

/** The installed app-server's native policies, not permission bypass. Settings leaves them untouched. */
export function codexApprovalParameters(mode: CodexApprovalMode, workingDirectory: string) {
  if (mode === 'settings') return { thread: {}, turn: {} };
  const readOnly = mode === 'read-only';
  const approvals = { approvalPolicy: readOnly ? 'never' : 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
  return {
    thread: { ...approvals, sandbox: readOnly ? 'read-only' : 'workspace-write' },
    turn: { ...approvals, sandboxPolicy: readOnly
      ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [workingDirectory], networkAccess: false } },
  };
}
