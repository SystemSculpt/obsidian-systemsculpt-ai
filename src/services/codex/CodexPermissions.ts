import { isRecord } from '../../studio/utils';

/** Presentation only. Never translate this summary back into execution policy. */
export function describeCodexPermissions(config: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    never: 'Never ask', 'on-request': 'Ask when needed', untrusted: 'Ask for untrusted actions',
    'on-failure': 'Ask on failure', 'danger-full-access': 'Full access',
    'workspace-write': 'Workspace write', 'read-only': 'Read only',
  };
  const approval = typeof config.approval_policy === 'string'
    ? labels[config.approval_policy] || 'Custom approvals'
    : isRecord(config.approval_policy) ? 'Custom approvals' : 'Codex approval default';
  const sandbox = typeof config.sandbox_mode === 'string'
    ? labels[config.sandbox_mode] || 'Custom sandbox'
    : typeof config.permissions === 'string' ? 'Permission profile' : 'Codex sandbox default';
  return `${approval} · ${sandbox}`;
}
