import { ClaudeChatSession } from '../ClaudeChatSession';
import { runLocalClaude } from '../LocalClaudeClient';
import { answerClaudePermission } from '../ClaudeRequestModal';
import { CodexThreadLocator } from '../../codex/CodexThreadLocator';
import { AgentChatSession } from '../../../chat/managed/ChatSession';
jest.mock('../../../chat/managed/ChatSession', () => ({ AgentChatSession: jest.fn(() => { throw new Error('Native chat must not construct a managed session.'); }) }));
jest.mock('../LocalClaudeClient', () => ({ runLocalClaude: jest.fn() }));
jest.mock('../ClaudeRequestModal', () => ({ answerClaudePermission: jest.fn(async () => true) }));
jest.mock('../../codex/CodexExecutionSettings', () => ({ codexVaultDirectory: () => '/vault' }));
jest.mock('../../codex/CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn() }));
const native = runLocalClaude as jest.Mock;
const SESSION = 'b33728f4-ea7d-4fec-bcd0-bf79649b7d28';
function setup() {
  let sessionId: string | undefined;
  const locator = { read: jest.fn(async () => sessionId), write: jest.fn(async (_id, id) => { sessionId = id; }) };
  (CodexThreadLocator as jest.Mock).mockImplementation(() => locator);
  const persistAssistant = jest.fn(async () => {});
  const session = new ClaudeChatSession({} as never, { persistAssistant }, () => [], () => ({ model: 'sonnet', permissionMode: 'default' }));
  native.mockImplementation(async (_input, signal, callbacks) => {
    await callbacks.session(SESSION);
    expect(await callbacks.permission({ toolName: 'Edit', description: 'note.md', input: {} }, signal)).toBe(true);
    callbacks.text('Updated'); return { text: 'Updated note.md', sessionId: SESSION };
  });
  return { session, locator, persistAssistant };
}
const input = (id = 'message_1') => ({ conversationId: 'conversation_1', turnId: id, message: { id, role: 'user' as const, parts: [{ type: 'text' as const, text: 'Fix the typo in note.md' }] } });
beforeEach(() => jest.clearAllMocks());

it('keeps Claude Code sessions in their own locator and runs in the vault with the chosen options', async () => {
  const { session, locator, persistAssistant } = setup(), listener = jest.fn(); session.subscribe(listener);
  await expect(session.start(input())).resolves.toMatchObject({ kind: 'completed' });
  expect(CodexThreadLocator).toHaveBeenCalledWith({}, 'claude');
  expect(native.mock.calls[0][0]).toEqual({ model: 'sonnet', permissionMode: 'default', prompt: 'Fix the typo in note.md', images: [], workingDirectory: '/vault', sessionId: undefined });
  expect(locator.write).toHaveBeenCalledWith('conversation_1', SESSION);
  expect(answerClaudePermission).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'waiting', statusLabel: 'Claude Code needs your input' }));
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated note.md', role: 'assistant' }));
  expect(session.getSnapshot()).toMatchObject({ status: 'completed', statusLabel: 'Completed with on-machine Claude Code' });
  expect(AgentChatSession).not.toHaveBeenCalled();
});
it('resumes the saved Claude Code session on a follow-up', async () => {
  const { session } = setup(); await session.start(input());
  await session.start(input('message_2'));
  expect(native.mock.calls[1][0]).toMatchObject({ sessionId: SESSION });
});
it('shows Claude Code errors as a retryable failure', async () => {
  const { session } = setup();
  native.mockRejectedValueOnce(new Error('Claude Code is not signed in. Open a terminal, run `claude`, then type /login.'));
  await expect(session.start(input())).resolves.toMatchObject({ kind: 'failed', error: { code: 'local_claude_failed', message: expect.stringContaining('/login'), retryable: true } });
});
