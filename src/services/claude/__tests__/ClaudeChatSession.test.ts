import { ClaudeChatSession } from '../ClaudeChatSession';
import { ClaudeChatTransport, runLocalClaude } from '../LocalClaudeClient';
import { answerClaudePermission } from '../ClaudeRequestModal';
import { CodexThreadLocator } from '../../codex/CodexThreadLocator';
import { AgentChatSession } from '../../../chat/managed/ChatSession';
import type { AgentToolPart } from '../../../chat/ChatConversation';
jest.mock('../../../chat/managed/ChatSession', () => ({ AgentChatSession: jest.fn(() => { throw new Error('Native chat must not construct a managed session.'); }) }));
jest.mock('../LocalClaudeClient', () => {
  const runLocalClaude = jest.fn();
  return { runLocalClaude, claudeSessionPermissionUpdates: jest.requireActual('../LocalClaudeClient').claudeSessionPermissionUpdates, ClaudeChatTransport: jest.fn(() => ({ run: runLocalClaude, close: jest.fn() })) };
});
jest.mock('../ClaudeRequestModal', () => ({ answerClaudePermission: jest.fn() }));
jest.mock('../../codex/CodexExecutionSettings', () => ({ codexVaultDirectory: () => '/vault' }));
jest.mock('../../codex/CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn() }));
const native = runLocalClaude as jest.Mock;
const SESSION = 'b33728f4-ea7d-4fec-bcd0-bf79649b7d28';
const edit = { toolName: 'Edit', description: 'note.md', requestId: 'req1', toolUseId: 'tool1', input: { file_path: '/vault/note.md', old_string: 'a', new_string: 'b' } };
function setup(autoApprove = true) {
  let sessionId: string | undefined;
  const locator = { read: jest.fn(async () => sessionId), write: jest.fn(async (_id, id) => { sessionId = id; }) };
  (CodexThreadLocator as jest.Mock).mockImplementation(() => locator);
  const persistAssistant = jest.fn(async () => {});
  const session = new ClaudeChatSession({} as never, { persistAssistant }, () => [], () => ({ model: 'sonnet', permissionMode: 'default' }));
  if (autoApprove) session.subscribe(snapshot => {
    const pending = snapshot.parts.find((part): part is AgentToolPart => part.kind === 'tool' && part.state === 'approval-required' && !!part.approvalId);
    if (pending) session.respondToApproval(pending.approvalId!, true);
  });
  native.mockImplementation(async (_input, signal, callbacks) => {
    await callbacks.session(SESSION);
    callbacks.tool({ id: 'tool1', name: 'Edit', input: edit.input, state: 'running' });
    expect(await callbacks.permission(edit, signal)).toEqual({ approved: true });
    callbacks.tool({ id: 'tool1', state: 'succeeded', output: 'updated' });
    callbacks.text('Updated'); return { text: 'Updated note.md', sessionId: SESSION };
  });
  return { session, locator, persistAssistant };
}
const input = (id = 'message_1') => ({ conversationId: 'conversation_1', turnId: id, message: { id, role: 'user' as const, parts: [{ type: 'text' as const, text: 'Fix the typo in note.md' }] } });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tools = (session: ClaudeChatSession) => session.getSnapshot().parts.filter((part): part is AgentToolPart => part.kind === 'tool');
beforeEach(() => jest.clearAllMocks());

it('keeps native session identity, publishes one matched tool and persists it without a modal', async () => {
  const { session, locator, persistAssistant } = setup(), listener = jest.fn(); session.subscribe(listener);
  await expect(session.start(input())).resolves.toMatchObject({ kind: 'completed' });
  expect(CodexThreadLocator).toHaveBeenCalledWith({}, 'claude');
  expect(native.mock.calls[0][0]).toEqual({ model: 'sonnet', permissionMode: 'default', prompt: 'Fix the typo in note.md', images: [], workingDirectory: '/vault', sessionId: undefined });
  expect(locator.write).toHaveBeenCalledWith('conversation_1', SESSION);
  expect(answerClaudePermission).not.toHaveBeenCalled();
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated note.md', role: 'assistant', messageParts: expect.arrayContaining([
    expect.objectContaining({ type: 'tool_call', data: expect.objectContaining({ native: expect.objectContaining({ agent: 'claude' }), approvalDecision: 'approved', state: 'completed' }) }),
  ]) }));
  expect(tools(session)).toEqual([expect.objectContaining({ callId: 'tool1', name: 'Edit', input: edit.input, state: 'succeeded', approvalDecision: 'approved', native: expect.objectContaining({ requestId: 'req1' }) })]);
  expect(session.getSnapshot()).toMatchObject({ status: 'completed', statusLabel: 'Completed with on-machine Claude Code' });
  expect(AgentChatSession).not.toHaveBeenCalled();
});
it('resumes the saved Claude Code session on a follow-up', async () => {
  const { session } = setup(); await session.start(input());
  await session.start(input('message_2'));
  expect(native.mock.calls[1][0]).toMatchObject({ sessionId: SESSION });
});
it.each(['detach', 'disconnect', 'conversation'])('closes the chat-owned native transport on %s', async ending => {
  const { session } = setup(); await session.start(input());
  const transport = (ClaudeChatTransport as jest.Mock).mock.results.at(-1)!.value;
  expect(transport.close).not.toHaveBeenCalled();
  if (ending === 'conversation') await session.hydrate('another-conversation');
  else if (ending === 'detach') await session.detach();
  else session.disconnect();
  expect(transport.close).toHaveBeenCalledTimes(1);
});
it('shows Claude Code errors as a retryable failure', async () => {
  const { session } = setup();
  native.mockRejectedValueOnce(new Error('Claude Code is not signed in. Open a terminal, run `claude`, then type /login.'));
  await expect(session.start(input())).resolves.toMatchObject({ kind: 'failed', error: { code: 'local_claude_failed', message: expect.stringContaining('/login'), retryable: true } });
});
it.each([true, false])('answers the same inline permission with session options (approved %s)', async approved => {
  const { session, persistAssistant } = setup(false);
  const response = jest.fn();
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' }];
  native.mockImplementation(async (_input, signal, callbacks) => {
    callbacks.tool({ id: 'tool1', name: 'Edit', input: edit.input, state: 'running' });
    response(await callbacks.permission({ ...edit, permissionSuggestions: suggestions }, signal));
    callbacks.text('After decision');
    callbacks.tool({ id: 'tool1', state: approved ? 'succeeded' : 'failed', output: 'result' });
    return { text: 'After decision' };
  });
  const running = session.start(input()); await flush();
  const pending = tools(session)[0];
  expect(pending).toMatchObject({ state: 'approval-required', native: { permissionSuggestions: suggestions, workingDirectory: '/vault' } });
  expect(session.respondToApproval(pending.approvalId!, true, 'policy')).toBe(false);
  expect(session.respondToApproval(pending.approvalId!, approved, 'manual', { rememberForSession: true })).toBe(true);
  expect(session.respondToApproval(pending.approvalId!, true)).toBe(false);
  await running;
  expect(response).toHaveBeenCalledWith({ approved, rememberForSession: true });
  expect(tools(session)).toHaveLength(1);
  expect(tools(session)[0]).toMatchObject({ state: approved ? 'succeeded' : 'failed', approvalDecision: approved ? 'approved' : 'denied', approvalScope: approved ? 'session' : undefined });
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ messageParts: expect.arrayContaining([
    expect.objectContaining({ type: 'tool_call', data: expect.objectContaining({ approvalScope: approved ? 'session' : undefined }) }),
  ]) }));
});
it('withdraws native cancellation and rejects stale responses while text streams', async () => {
  const { session } = setup(false), request = new AbortController();
  native.mockImplementation(async (_input, _signal, callbacks) => {
    try { await callbacks.permission(edit, request.signal); } catch { /* Native cancellation consumes no answer. */ }
    callbacks.text('Other work'); return { text: 'Other work' };
  });
  const running = session.start(input()); await flush();
  const pending = tools(session)[0]; request.abort();
  expect(session.respondToApproval(pending.approvalId!, true)).toBe(false);
  await running;
  expect(tools(session)[0]).toMatchObject({ state: 'cancelled', approvalDecision: 'withdrawn' });
});
it.each([undefined, [{ type: 'setMode', mode: 'bypassPermissions' }], [{ type: 'setMode', mode: 'dontAsk' }]])('does not claim a session grant when native suggestions cannot grant one (%j)', async permissionSuggestions => {
  const { session, persistAssistant } = setup(false), response = jest.fn();
  native.mockImplementation(async (_input, signal, callbacks) => {
    response(await callbacks.permission({ ...edit, permissionSuggestions }, signal));
    callbacks.tool({ id: 'tool1', state: 'succeeded' }); return { text: '' };
  });
  const running = session.start(input()); await flush();
  expect(session.respondToApproval(tools(session)[0].approvalId!, true, 'manual', { rememberForSession: true })).toBe(true);
  await running;
  expect(response).toHaveBeenCalledWith({ approved: true, rememberForSession: true });
  expect(tools(session)[0]).toMatchObject({ state: 'succeeded', approvalDecision: 'approved', approvalScope: undefined });
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ messageParts: expect.arrayContaining([
    expect.objectContaining({ type: 'tool_call', data: expect.objectContaining({ approvalScope: undefined }) }),
  ]) }));
});
it('accepts an authoritative tool result after native permission cancellation', async () => {
  const { session } = setup(false), request = new AbortController();
  native.mockImplementation(async (_input, _signal, callbacks) => {
    try { await callbacks.permission(edit, request.signal); } catch { /* withdrawn, not an execution result */ }
    callbacks.tool({ id: 'tool1', state: 'succeeded', output: 'native result' }); return { text: '' };
  });
  const running = session.start(input()); await flush();
  const approvalId = tools(session)[0].approvalId!; request.abort(); await running;
  expect(tools(session)[0]).toMatchObject({ state: 'succeeded', approvalDecision: 'withdrawn' });
  expect(session.respondToApproval(approvalId, true)).toBe(false);
});
it('does not reject large raw review inputs', async () => {
  const { session } = setup(false), largeInput = { file_path: '/vault/large.md', content: 'x'.repeat(130_000) };
  native.mockImplementation(async (_input, signal, callbacks) => {
    await callbacks.permission({ ...edit, input: largeInput }, signal); return { text: 'done' };
  });
  const running = session.start(input()); await flush();
  const pending = tools(session)[0]; expect(pending.input).toEqual(largeInput);
  session.respondToApproval(pending.approvalId!, true); await running;
});
