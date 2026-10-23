import { CODEX_APPROVAL_MODES, codexApprovalParameters, resolveCodexApprovalMode } from '../CodexApprovalPolicy';
import { codexOptionsFromSettings } from '../CodexExecutionSettings';
import { DEFAULT_SETTINGS } from '../../../types';
import schema from './fixtures/codex-approval-schema.json';

it('defaults to Auto and retains every explicit mode', () => {
  expect(resolveCodexApprovalMode()).toBe('auto');
  for (const mode of CODEX_APPROVAL_MODES) expect(resolveCodexApprovalMode(mode)).toBe(mode);
  expect(() => resolveCodexApprovalMode('bypass')).toThrow('Invalid Codex approval mode');
});

it.each(CODEX_APPROVAL_MODES)('forwards the %s setting with the model options', approvalMode => {
  expect(codexOptionsFromSettings({ ...DEFAULT_SETTINGS, codexApprovalMode: approvalMode })).toMatchObject({ approvalMode });
});

it.each(CODEX_APPROVAL_MODES)('uses generated app-server field names and values for %s', mode => {
  const { thread, turn } = codexApprovalParameters(mode, '/vault');
  if (mode === 'settings') {
    expect(thread).toEqual({});
    expect(turn).toEqual({});
    return;
  }
  for (const fields of [schema.ThreadStartParams, schema.ThreadResumeParams]) {
    expect(Object.keys(thread).sort()).toEqual(Object.keys(fields).sort());
    expect(fields.approvalPolicy.anyOf[0].$ref).toBe('#/definitions/AskForApproval');
    expect(fields.approvalsReviewer.anyOf[0].$ref).toBe('#/definitions/ApprovalsReviewer');
    expect(fields.sandbox.anyOf[0].$ref).toBe('#/definitions/SandboxMode');
  }
  expect(Object.keys(turn).sort()).toEqual(Object.keys(schema.TurnStartParams).sort());
  expect(schema.definitions.AskForApproval.enum).toContain(thread.approvalPolicy);
  expect(schema.definitions.ApprovalsReviewer.enum).toContain(thread.approvalsReviewer);
  expect(schema.definitions.SandboxMode.enum).toContain(thread.sandbox);
  expect(turn.approvalPolicy).toBe(thread.approvalPolicy);
  expect(turn.approvalsReviewer).toBe(thread.approvalsReviewer);
  expect(schema.TurnStartParams.sandboxPolicy.anyOf[0].$ref).toBe('#/definitions/SandboxPolicy');
  const sandbox = turn.sandboxPolicy!;
  const definition = sandbox.type === 'readOnly' ? schema.definitions.SandboxPolicy.readOnly : schema.definitions.SandboxPolicy.workspaceWrite;
  expect(definition.properties.type.enum).toContain(sandbox.type);
  for (const key of definition.required) expect(sandbox).toHaveProperty(key);
  for (const key of Object.keys(sandbox)) expect(definition.properties).toHaveProperty(key);
  expect(typeof sandbox.networkAccess).toBe(definition.properties.networkAccess.type);
  if (sandbox.type === 'workspaceWrite') {
    expect(sandbox.writableRoots).toEqual(['/vault']);
    expect(schema.definitions.AbsolutePathBuf.type).toBe(typeof sandbox.writableRoots![0]);
    expect(thread.approvalPolicy).toBe('on-request');
  } else expect(thread.approvalPolicy).toBe('never');
  expect(thread.sandbox).not.toBe('danger-full-access');
});
