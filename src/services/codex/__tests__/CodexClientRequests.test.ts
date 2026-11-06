import { codexClientRequestKind, codexClientResponse } from '../CodexClientRequests';

describe('Codex client request codec', () => {
  it.each([
    ['item/commandExecution/requestApproval', 'commandExecution'],
    ['item/fileChange/requestApproval', 'fileChange'],
    ['item/permissions/requestApproval', 'permissions'],
    ['item/tool/requestUserInput', 'question'],
    ['item/unknown/requestApproval', undefined],
  ])('classifies only supported requests: %s', (method, expected) => {
    expect(codexClientRequestKind(method!)).toBe(expected);
  });

  it.each(['commandExecution', 'fileChange'] as const)('preserves explicit %s decisions', kind => {
    for (const action of ['accept', 'acceptForSession', 'decline', 'cancel'] as const) {
      expect(codexClientResponse(kind, {}, { action })).toEqual({ decision: action });
    }
  });

  it('preserves Chat permissions and its explicit native session scope', () => {
    const permissions = { fileSystem: { write: ['/vault'] }, network: null };
    expect(codexClientResponse('permissions', { permissions }, { action: 'acceptForSession' }))
      .toEqual({ permissions, scope: 'session' });
    expect(codexClientResponse('permissions', { permissions }, { action: 'decline' }))
      .toEqual({ permissions: {}, scope: 'turn' });
  });

  it('keeps Studio grants turn-scoped and omits null entries only when requested', () => {
    const permissions = { fileSystem: { write: ['/vault'] }, network: null };
    expect(codexClientResponse('permissions', { permissions }, { action: 'accept', omitNullPermissions: true }))
      .toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: 'turn' });
    expect(codexClientResponse('permissions', { permissions }, { action: 'cancel', omitNullPermissions: true }))
      .toEqual({ permissions: {}, scope: 'turn' });
    expect(codexClientResponse('permissions', { permissions: [] }, { action: 'accept' }))
      .toEqual({ permissions: {}, scope: 'turn' });
  });

  it('encodes exact question arrays and clears declined or cancelled answers', () => {
    const answers = { language: ['TypeScript', 'JavaScript'], other: [''] };
    expect(codexClientResponse('question', {}, { action: 'accept', answers }))
      .toEqual({ answers: { language: { answers: answers.language }, other: { answers: [''] } } });
    expect(codexClientResponse('question', {}, { action: 'decline', answers })).toEqual({ answers: {} });
    expect(codexClientResponse('question', {}, { action: 'cancel', answers })).toEqual({ answers: {} });
  });
});
