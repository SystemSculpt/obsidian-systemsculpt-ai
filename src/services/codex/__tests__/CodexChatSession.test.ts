import { CodexChatSession } from '../CodexChatSession';
import { runLocalCodex } from '../LocalCodexClient';
import { CodexThreadLocator } from '../CodexThreadLocator';
import { AgentChatSession } from '../../../chat/managed/ChatSession';
jest.mock('../../../chat/managed/ChatSession', () => ({ AgentChatSession: jest.fn(() => { throw new Error('Native chat must not construct a managed session.'); }) }));
jest.mock('../LocalCodexClient', () => ({ runLocalCodex: jest.fn() }));
jest.mock('../CodexExecutionSettings', () => ({ codexVaultDirectory: () => '/vault' }));
jest.mock('../CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn() }));
const native = runLocalCodex as jest.Mock;
function setup() {
  let threadId: string | undefined;
  const locator = { read: jest.fn(async () => threadId), write: jest.fn(async (_id, id) => { threadId = id; }) };
  (CodexThreadLocator as jest.Mock).mockImplementation(() => locator);
  const persistAssistant = jest.fn(async () => {});
  const session = new CodexChatSession({} as never, { persistAssistant });
  native.mockImplementation(async (input, _signal, callbacks) => { await callbacks.thread('native-thread'); callbacks.text('hello'); return { text: 'hello', threadId: 'native-thread', turnId: 'turn', status: 'completed' }; });
  return { session, locator, persistAssistant };
}
const input = (id = 'message_1') => ({ conversationId: 'conversation_1', turnId: id, message: { id, role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] } });
beforeEach(() => jest.clearAllMocks());
it('streams and persists a native reply without managed authentication or transport', async () => {
  const { session, persistAssistant, locator } = setup(), listener = jest.fn(); session.subscribe(listener);
  const beforeSend = jest.fn(async () => {});
  await expect(session.start({ ...input(), beforeSend })).resolves.toMatchObject({ kind: 'completed' });
  expect(beforeSend).toHaveBeenCalledTimes(1); expect(locator.write).toHaveBeenCalledWith('conversation_1', 'native-thread');
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello', role: 'assistant' }));
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ parts: [expect.objectContaining({ markdown: 'hello', state: 'streaming' })] }));
  expect(AgentChatSession).not.toHaveBeenCalled();
});
it('resumes the saved native thread on a follow-up and includes pinned text', async () => {
  const { session } = setup(); await session.start(input());
  await session.start({ ...input('message_2'), buildBody: async () => { await session.stageContext('message_2', { sources: [{ kind: 'text', path: 'note.md', content: 'important context' }], measurement: { largestTextBlockBytes: 17, totalTextBytes: 24, imageCount: 0, largestImageBytes: 0, totalImageBytes: 0, imageMimeTypes: [] } }); return undefined; } });
  expect(native.mock.calls[1][0]).toMatchObject({ threadId: 'native-thread', prompt: expect.stringContaining('important context') });
});
it('cancels and detaches the active native request', async () => {
  const { session } = setup();
  native.mockImplementation((_input, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))); }));
  const running = session.start(input()); for (let i = 0; i < 12; i++) await Promise.resolve();
  await session.detach(); await expect(running).resolves.toMatchObject({ kind: 'cancelled' });
});
