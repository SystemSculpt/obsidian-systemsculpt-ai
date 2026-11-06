import { isRecord } from '../../utils/jsonRecord';

export type CodexClientRequestKind = 'commandExecution' | 'fileChange' | 'permissions' | 'question';

/** Recognizes only the native client requests the plugin can present for review. */
export function codexClientRequestKind(method: string): CodexClientRequestKind | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval': return 'commandExecution';
    case 'item/fileChange/requestApproval': return 'fileChange';
    case 'item/permissions/requestApproval': return 'permissions';
    case 'item/tool/requestUserInput': return 'question';
    default: return undefined;
  }
}

export type CodexClientDecision = {
  action: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  answers?: Record<string, readonly string[]>;
  /** Studio's native permission form omits null entries; Chat preserves the exact payload. */
  omitNullPermissions?: boolean;
};

/** Encodes an explicit caller decision; never decides whether a request is authorized. */
export function codexClientResponse(kind: CodexClientRequestKind, params: Record<string, unknown>, decision: CodexClientDecision): unknown {
  const approved = decision.action === 'accept' || decision.action === 'acceptForSession';
  if (kind === 'question') {
    return { answers: Object.fromEntries(Object.entries(approved ? decision.answers ?? {} : {}).map(([id, answers]) => [id, { answers }])) };
  }
  if (kind === 'permissions') {
    const permissions = approved && isRecord(params.permissions) ? params.permissions : {};
    return {
      permissions: decision.omitNullPermissions ? Object.fromEntries(Object.entries(permissions).filter(([, value]) => value !== null)) : permissions,
      scope: decision.action === 'acceptForSession' ? 'session' : 'turn',
    };
  }
  return { decision: decision.action };
}
