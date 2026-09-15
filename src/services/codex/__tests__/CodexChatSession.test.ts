import { CodexChatSession } from '../CodexChatSession';
import { runLocalCodex } from '../LocalCodexClient';
import { CodexThreadLocator } from '../CodexThreadLocator';
jest.mock('../LocalCodexClient', () => ({ runLocalCodex: jest.fn() }));
jest.mock('../CodexExecutionSettings', () => ({ codexVaultDirectory: () => '/vault' }));
jest.mock('../CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn() }));
const native = runLocalCodex as jest.Mock;
function setup() {
  let threadId: string | undefined;
  const locator = { read: jest.fn(async () => threadId), write: jest.fn(async (_id, id) => { threadId = id; }) };
  (CodexThreadLocator as jest.Mock).mockImplementation(() => locator);
  const persistAssistant = jest.fn(async () => {}), request = jest.fn(() => { throw new Error('Managed HTTP must not run'); });
  const session = new CodexChatSession({} as never, { persistAssistant, requestClient: { request }, mutationJournal: {}, licenseKey: () => '' } as never);
  native.mockImplementation(async (input, _signal, callbacks) => { await callbacks.thread('native-thread'); callbacks.text('hello'); return { text: 'hello', threadId: 'native-thread', turnId: 'turn', status: 'completed' }; });
  return { session, locator, persistAssistant, request };
}
const input = (id = 'message_1') => ({ conversationId: 'conversation_1', turnId: id, message: { id, role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] } });
beforeEach(() => jest.clearAllMocks());
it('streams and persists a native reply without managed authentication or transport', async () => {
  const { session, persistAssistant, request, locator } = setup(), listener = jest.fn(); session.subscribe(listener);
  const beforeSend = jest.fn(async () => {});
  await expect(session.start({ ...input(), beforeSend })).resolves.toMatchObject({ kind: 'completed' });
  expect(beforeSend).toHaveBeenCalledTimes(1); expect(locator.write).toHaveBeenCalledWith('conversation_1', 'native-thread');
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello', role: 'assistant' }));
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ parts: [expect.objectContaining({ markdown: 'hello', state: 'streaming' })] }));
  expect(request).not.toHaveBeenCalled();
});
it('resumes the saved native thread on a follow-up and includes pinned text', async () => {
  const { session } = setup(); await session.start(input());
  await session.start({ ...input('message_2'), buildBody: async () => { await session.stageContext('message_2', [{ kind: 'text', path: 'note.md', content: 'important context' }]); return undefined; } });
  expect(native.mock.calls[1][0]).toMatchObject({ threadId: 'native-thread', prompt: expect.stringContaining('important context') });
});
it('cancels and detaches the active native request', async () => {
  const { session } = setup();
  native.mockImplementation((_input, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))); }));
  const running = session.start(input()); for (let i = 0; i < 12; i++) await Promise.resolve();
  await session.detach(); await expect(running).resolves.toMatchObject({ kind: 'cancelled' });
});
