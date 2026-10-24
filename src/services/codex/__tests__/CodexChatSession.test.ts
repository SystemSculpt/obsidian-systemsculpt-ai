import { CodexChatSession } from '../CodexChatSession';
import { CodexChatTransport, runLocalCodex } from '../LocalCodexClient';
import { CodexThreadLocator } from '../CodexThreadLocator';
import { AgentChatSession } from '../../../chat/managed/ChatSession';
import type { AgentToolPart } from '../../../chat/ChatConversation';
import { codexActivity } from '../CodexActivity';
import { answerCodexRequest } from '../CodexRequestModal';
jest.mock('../CodexRequestModal', () => ({ answerCodexRequest: jest.fn() }));
jest.mock('../../../chat/managed/ChatSession', () => ({ AgentChatSession: jest.fn(() => { throw new Error('Native chat must not construct a managed session.'); }) }));
jest.mock('../LocalCodexClient', () => {
  const runLocalCodex = jest.fn();
  return { runLocalCodex, CodexChatTransport: jest.fn(() => ({ run: runLocalCodex, close: jest.fn() })) };
});
jest.mock('../CodexExecutionSettings', () => ({ localAgentChatDirectory: async () => '/vault' }));
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
  expect(native.mock.calls[0][0]).toMatchObject({ approvalMode: 'auto' });
});
it('publishes the turn\'s elapsed time for the status row and freezes it at the end', async () => {
  const { session, persistAssistant } = setup(), listener = jest.fn(); session.subscribe(listener);
  let now = 1_000;
  const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  native.mockImplementationOnce(async (_input, _signal, callbacks) => { now += 2_500; callbacks.text('hi'); now += 1_000; return { text: 'hi', threadId: 't', turnId: 'turn', status: 'completed' }; });
  try {
    await session.start(input());
    const elapsed = listener.mock.calls.map(([snapshot]) => snapshot.elapsedMs).filter((value) => value !== undefined);
    expect(elapsed[0]).toBe(0);
    expect(elapsed).toContain(2_500);
    expect(session.getSnapshot()).toMatchObject({ status: 'completed', elapsedMs: 3_500 });
    expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ responseDurationMs: 3_500 }));
    now += 60_000;
    await session.detach();
    expect(session.getSnapshot().elapsedMs).toBe(3_500);
  } finally { clock.mockRestore(); }
});
it('preserves an explicitly configured native approval mode instead of the Chat default', async () => {
  setup();
  const session = new CodexChatSession({} as never, { persistAssistant: async () => {} }, () => [], () => ({ approvalMode: 'ask' }));
  await session.start(input());
  expect(native.mock.calls[0][0]).toMatchObject({ approvalMode: 'ask' });
});
it('resumes the saved native thread on a follow-up and includes pinned text', async () => {
  const { session } = setup(); await session.start(input());
  await session.start({ ...input('message_2'), buildBody: async () => { await session.stageContext('message_2', { sources: [{ kind: 'text', path: 'note.md', content: 'important context' }], measurement: { largestTextBlockBytes: 17, totalTextBytes: 24, imageCount: 0, largestImageBytes: 0, totalImageBytes: 0, imageMimeTypes: [] } }); return undefined; } });
  expect(native.mock.calls[1][0]).toMatchObject({ threadId: 'native-thread', prompt: expect.stringContaining('important context') });
});
it.each(['detach', 'disconnect', 'conversation'])('closes the chat-owned native transport on %s', async ending => {
  const { session } = setup(); await session.start(input());
  const transport = (CodexChatTransport as jest.Mock).mock.results.at(-1)!.value;
  expect(transport.close).not.toHaveBeenCalled();
  if (ending === 'conversation') await session.hydrate('another-conversation');
  else if (ending === 'detach') await session.detach();
  else session.disconnect();
  expect(transport.close).toHaveBeenCalledTimes(1);
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tools = (session: CodexChatSession) => session.getSnapshot().parts.filter((part): part is AgentToolPart => part.kind === 'tool');

it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])('maps all inline command/file decisions exactly (%s)', async method => {
  for (const [approved, rememberForSession, expected] of [[true, false, 'accept'], [false, false, 'decline'], [true, true, 'acceptForSession']] as const) {
    const { session, persistAssistant } = setup();
    const params = { itemId: 'native-item', command: 'printf hello', cwd: '/project', reason: 'Please review', kind: 'writeStdin', networkApprovalContext: { host: 'example.test', protocol: 'https' },
      ...(method.includes('fileChange') ? { change: { type: 'fileChange', changes: [{ path: '/project/a.md', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }] } } : {}) };
    const response = jest.fn();
    native.mockImplementation(async (_input, signal, callbacks) => { response(await callbacks.request(method, params, signal, 91)); callbacks.text('done'); return { text: 'done' }; });
    const running = session.start(input()); await flush();
    const pending = tools(session)[0];
    expect(pending).toMatchObject({ state: 'approval-required', input: expect.objectContaining(params), native: { requestId: 91, requestMethod: method, workingDirectory: '/project', vaultRoot: '/vault' } });
    if (method.includes('fileChange')) expect(pending.input).toHaveProperty('changes', params.change!.changes);
    expect(session.respondToApproval(pending.approvalId!, approved, 'manual', { rememberForSession })).toBe(true);
    await running;
    expect(response).toHaveBeenCalledWith({ decision: expected });
    expect(answerCodexRequest).not.toHaveBeenCalled();
    expect(persistAssistant).toHaveBeenCalled();
    expect(tools(session)[0].approvalDecision).toBe(approved ? 'approved' : 'denied');
    expect(tools(session)[0].approvalScope).toBe(approved && rememberForSession ? 'session' : undefined);
    expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ messageParts: expect.arrayContaining([
      expect.objectContaining({ type: 'tool_call', data: expect.objectContaining({ approvalScope: approved && rememberForSession ? 'session' : undefined }) }),
    ]) }));
  }
});
it.each(['fileChange', 'commandExecution'])('keeps a declined %s denied when native completion reports failure without hiding other failures', async type => {
  const { session, persistAssistant } = setup();
  native.mockImplementation(async (_input, signal, callbacks) => {
    await callbacks.request(`item/${type}/requestApproval`, { itemId: 'edit', ...(type === 'fileChange'
      ? { changes: [{ path: '/vault/Notes/Launch plan.md', kind: { type: 'update' } }] }
      : { command: 'printf hello' }) }, signal);
    for (const id of ['edit', 'other']) {
      const item = { id, type, status: 'failed', error: 'Native action did not complete' };
      callbacks.activity(codexActivity('item/completed', { item }), item);
    }
    return { text: 'done' };
  });
  const running = session.start(input()); await flush();
  session.respondToApproval(tools(session)[0].approvalId!, false); await running;
  expect(tools(session).map(({ callId, state }) => ({ callId, state })))
    .toEqual([{ callId: 'edit', state: 'denied' }, { callId: 'other', state: 'failed' }]);
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ messageParts: expect.arrayContaining([
    expect.objectContaining({ type: 'tool_call', data: expect.objectContaining({ id: 'edit', approvalDecision: 'denied', result: expect.objectContaining({ success: false, error: { code: 'NATIVE_TOOL_DENIED', message: 'Native tool denied.' } }) }) }),
  ]) }));
});
it.each([true, false])('returns exact requested permissions with turn/session scope (remember %s)', async rememberForSession => {
  for (const approved of [true, false]) {
    const { session } = setup(), response = jest.fn();
    const permissions = { network: { enabled: true }, fileSystem: { entries: [{ path: { type: 'path', path: '/project' }, access: 'write' }], globScanMaxDepth: null }, extra: null };
    native.mockImplementation(async (_input, signal, callbacks) => { response(await callbacks.request('item/permissions/requestApproval', { itemId: 'permissions', permissions }, signal)); return { text: '' }; });
    const running = session.start(input()); await flush();
    const pending = tools(session)[0];
    session.respondToApproval(pending.approvalId!, approved, 'manual', { rememberForSession }); await running;
    expect(response).toHaveBeenCalledWith({ permissions: approved ? permissions : {}, scope: approved && rememberForSession ? 'session' : 'turn' });
  }
});
it('returns requestUserInput answers with the native question-id wrapper', async () => {
  const { session } = setup(), response = jest.fn();
  const questions = [{ id: 'choice', header: 'Choose', question: 'Which?', isSecret: false, isOther: true, options: [{ label: 'A', description: 'First' }] }];
  native.mockImplementation(async (_input, signal, callbacks) => { response(await callbacks.request('item/tool/requestUserInput', { itemId: 'question', questions, isBlocking: true }, signal)); return { text: '' }; });
  const running = session.start(input()); await flush();
  const pending = tools(session)[0]; expect(pending.input).toMatchObject({ questions });
  session.respondToApproval(pending.approvalId!, true, 'manual', { answers: { choice: ['A', 'Other'] } }); await running;
  expect(response).toHaveBeenCalledWith({ answers: { choice: { answers: ['A', 'Other'] } } });
});
it('keeps exact native activity and request on the same part through later text and completion', async () => {
  const { session, persistAssistant } = setup(), response = jest.fn();
  const item = { type: 'commandExecution', id: 'command', command: 'pwd', cwd: '/project', status: 'inProgress' };
  native.mockImplementation(async (_input, signal, callbacks) => {
    callbacks.text('Before');
    callbacks.activity(codexActivity('item/started', { item }), item);
    response(await callbacks.request('item/commandExecution/requestApproval', { itemId: 'command', reason: 'Reason', command: 'pwd', cwd: '/project' }, signal));
    const complete = { ...item, status: 'completed', aggregatedOutput: '/project', exitCode: 0 };
    callbacks.activity(codexActivity('item/completed', { item: complete }), complete);
    callbacks.activity(codexActivity('item/started', { item }), item); // late starts cannot reopen the completed item
    callbacks.text('Before\nAfter'); return { text: 'Before\nAfter' };
  });
  const running = session.start(input()); await flush();
  expect(tools(session)).toHaveLength(1);
  expect(tools(session)[0].native).toMatchObject({ workingDirectory: '/project', vaultRoot: '/vault' });
  session.respondToApproval(tools(session)[0].approvalId!, true); await running;
  expect(tools(session)[0].native).toMatchObject({ workingDirectory: '/project', vaultRoot: '/vault' });
  expect(tools(session)).toEqual([expect.objectContaining({ callId: 'command', name: 'commandExecution', state: 'succeeded', approvalDecision: 'approved', input: expect.objectContaining({ reason: 'Reason', command: 'pwd' }), output: { data: '/project', summary: '/project' } })]);
  expect(session.getSnapshot().parts.map(part => part.kind)).toEqual(['text', 'tool', 'text']);
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ messageParts: expect.arrayContaining([expect.objectContaining({ type: 'tool_call' })]) }));
});
it.each([[false, 'completed'], [false, 'failed'], [true, 'completed'], [true, 'failed']] as const)('lets native terminal status supersede approval withdrawal (resolved first %s, %s)', async (resolvedFirst, status) => {
  const { session, persistAssistant } = setup(), request = new AbortController();
  let callbacks: any, complete!: (value: { text: string }) => void;
  native.mockImplementation((_input, _signal, events) => {
    callbacks = events;
    void events.request('item/commandExecution/requestApproval', { itemId: 'command', command: 'pwd' }, request.signal).catch(() => {});
    return new Promise(resolve => { complete = resolve; });
  });
  const running = session.start(input()); await flush();
  const approvalId = tools(session)[0].approvalId!;
  if (resolvedFirst) { request.abort(); expect(tools(session)[0]).toMatchObject({ state: 'cancelled', approvalDecision: 'withdrawn' }); }
  const item = { id: 'command', type: 'commandExecution', status, command: 'pwd', aggregatedOutput: 'native result' };
  callbacks.activity(codexActivity('item/completed', { item }), item);
  expect(tools(session)[0]).toMatchObject({ state: status === 'completed' ? 'succeeded' : 'failed', approvalDecision: 'withdrawn', output: { data: 'native result' } });
  expect(session.respondToApproval(approvalId, true)).toBe(false);
  const late = { ...item, status: 'inProgress' };
  callbacks.activity(codexActivity('item/started', { item: late }), late);
  complete({ text: '' }); await running;
  expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ messageParts: expect.arrayContaining([
    expect.objectContaining({ type: 'tool_call', data: expect.objectContaining({ state: status === 'completed' ? 'completed' : 'failed', approvalDecision: 'withdrawn', result: expect.objectContaining({ success: status === 'completed' }) }) }),
  ]) }));
});
it('projects offset snapshots beyond the native rolling boundary without repeating windows', async () => {
  const { session, persistAssistant } = setup();
  let full = '0123456789'.repeat(25_600);
  native.mockImplementation(async (_input, _signal, callbacks) => {
    callbacks.text(full, 0);
    const item = { id: 'between', type: 'commandExecution', status: 'completed', command: 'pwd' };
    callbacks.activity(codexActivity('item/completed', { item }), item);
    for (let i = 0; i < 8; i++) { full += `tail-${i}`; callbacks.text(full.slice(-256_000), full.length - 256_000); }
    return { text: full.slice(-256_000) };
  });
  await session.start(input());
  const parts = session.getSnapshot().parts;
  expect(parts.map(part => part.kind)).toEqual(['text', 'tool', 'text']);
  expect(parts.flatMap(part => part.kind === 'text' ? [part.markdown] : []).join('')).toBe(full);
  const saved = persistAssistant.mock.calls[0][0] as any;
  expect(saved.messageParts.filter((part: any) => part.type === 'content').map((part: any) => part.data).join('')).toBe(full);
});
it('replaces a corrected streamed text tail rather than appending another copy', async () => {
  const { session } = setup();
  native.mockImplementation(async (_input, _signal, callbacks) => {
    callbacks.text('Before');
    const item = { id: 'between', type: 'commandExecution', status: 'completed', command: 'pwd' };
    callbacks.activity(codexActivity('item/completed', { item }), item);
    callbacks.text('\nwrong', 6); callbacks.text('\ncorrect', 6);
    return { text: 'Before\ncorrect' };
  });
  await session.start(input());
  expect(session.getSnapshot().parts.map(part => part.kind)).toEqual(['text', 'tool', 'text']);
  expect(session.getSnapshot().parts.flatMap(part => part.kind === 'text' ? [part.markdown] : []).join('')).toBe('Before\ncorrect');
});
it.each(['completed', 'failed', 'cancel', 'disconnect', 'detach'])('withdraws pending requests on terminal %s and rejects stale answers', async ending => {
  const { session } = setup(); let fail!: (error: Error) => void, complete!: (value: { text: string }) => void;
  native.mockImplementation((_input, signal, callbacks) => {
    void callbacks.request('item/commandExecution/requestApproval', { itemId: 'one', command: 'pwd' }, signal).catch(() => {});
    void callbacks.request('item/tool/requestUserInput', { itemId: 'two', questions: [] }, signal).catch(() => {});
    return new Promise((resolve, reject) => { fail = reject; complete = resolve; signal.addEventListener('abort', () => reject(new Error('stopped'))); });
  });
  const running = session.start(input()); await flush();
  const ids = tools(session).map(part => part.approvalId!);
  if (ending === 'failed') fail(new Error('native failed'));
  else if (ending === 'completed') complete({ text: '' });
  else if (ending === 'cancel') await session.cancel();
  else if (ending === 'detach') await session.detach();
  else session.disconnect();
  await running;
  expect(tools(session)).toHaveLength(2);
  for (const tool of tools(session)) expect(tool).toMatchObject({ state: 'cancelled', approvalDecision: 'withdrawn' });
  for (const id of ids) expect(session.respondToApproval(id, true)).toBe(false);
});

it('cancels and detaches the active native request', async () => {
  const { session } = setup();
  native.mockImplementation((_input, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))); }));
  const running = session.start(input()); for (let i = 0; i < 12; i++) await Promise.resolve();
  await session.detach(); await expect(running).resolves.toMatchObject({ kind: 'cancelled' });
});
