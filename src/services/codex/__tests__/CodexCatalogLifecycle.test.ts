/** @jest-environment jsdom */
import { EventEmitter } from 'node:events';
import { desktopHost } from '../../../platform/desktopOnly';
import { mountCodexExecutionControls } from '../CodexExecutionControls';
import { renderStudioCommandExecution } from '../../../views/studio/canvas/StudioCommandExecutionControls';
import { readCodexCatalog } from '../CodexModelCatalog';
import { runLocalCodex, CodexChatTransport } from '../LocalCodexClient';
import { connectCodex, disposeCodexSession, startCodexSession } from '../CodexAppServer';
import { resolveCodexLaunchOptions } from '../CodexLaunch';

jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { childProcess: jest.fn(), fs: jest.fn(), path: jest.fn(), os: async () => ({ platform: () => 'darwin' }) } }));
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: () => true }));
jest.mock('../CodexLaunch', () => ({ resolveCodexLaunchOptions: jest.fn(async () => ({ binary: 'codex', home: '/home/test', environment: {} })) }));
jest.mock('../CodexExecutionSettings', () => ({ ...jest.requireActual('../CodexExecutionSettings'), codexVaultDirectory: () => '/vault' }));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let now = Date.now();
beforeEach(() => { jest.clearAllMocks(); startCodexSession(); jest.mocked(resolveCodexLaunchOptions).mockResolvedValue({ binary: 'codex', home: '/home/test', codexHome: '/home/test/.codex', environment: { CODEX_HOME: '/home/test/.codex' } }); now += 120_000; jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }); jest.setSystemTime(now); });
afterEach(async () => { await disposeCodexSession(); jest.useRealTimers(); jest.restoreAllMocks(); document.body.replaceChildren(); });

function host(options: { wait?: boolean; holdInitialize?: boolean; holdTurnStart?: boolean; onTurnReply?: (threadId: string) => void; holdInterrupt?: boolean; failInterrupt?: boolean; stubborn?: boolean } = {}) {
  const requests: string[] = [], kills: jest.Mock[] = [], messages: any[] = [], children: EventEmitter[] = [];
  const turnReplies = new Map<string, () => void>(), interruptReplies: (() => void)[] = [];
  const outputs: ((value: unknown) => void)[] = [];
  let initialize: (() => void) | undefined;
  let threadNumber = 0;
  const spawn = jest.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
      stdin: Object.assign(new EventEmitter(), { write: jest.fn() }), kill: jest.fn(),
    });
    kills.push(child.kill); children.push(child);
    child.kill.mockImplementation((signal?: string) => { if (!options.stubborn || signal === 'SIGKILL') child.emit('close', 0); return true; });
    const send = (value: unknown) => child.stdout.emit('data', `${JSON.stringify(value)}\n`);
    outputs.push(send);
    child.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line); requests.push(message.method); messages.push(message);
      if (message.id === undefined || !message.method) return true;
      const result = message.method === 'account/read' ? { account: { type: 'chatgpt' } }
        : message.method === 'config/read' ? { config: { approval_policy: 'untrusted', sandbox_mode: 'read-only' } }
        : message.method === 'thread/resume' ? { thread: { id: message.params.threadId } }
        : message.method === 'thread/start' ? { thread: { id: `thread-${++threadNumber}` } }
        : message.method === 'turn/start' ? { turn: { id: `turn-${message.params.threadId}` } }
        : message.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] } : {};
      queueMicrotask(() => {
        if (message.method === 'initialize' && options.holdInitialize) { initialize = () => send({ id: message.id, result }); return; }
        if (message.method === 'turn/interrupt') {
          if (options.failInterrupt) { send({ id: message.id, error: { message: 'Interruption failed' } }); return; }
          if (options.holdInterrupt) { interruptReplies.push(() => send({ id: message.id, result })); return; }
        }
        if (message.method === 'turn/start') {
          const reply = () => { send({ id: message.id, result }); queueMicrotask(() => options.onTurnReply?.(message.params.threadId)); };
          if (options.holdTurnStart) { turnReplies.set(message.params.threadId, reply); return; }
          reply();
        } else send({ id: message.id, result });
        if (message.method === 'turn/start' && !options.wait) {
          send({ method: 'item/completed', params: { threadId: message.params.threadId, item: { type: 'agentMessage', text: message.params.threadId } } });
          send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: `turn-${message.params.threadId}`, status: 'completed' } } });
        }
      });
      return true;
    });
    return child;
  });
  jest.mocked(desktopHost.childProcess).mockResolvedValue({ spawn } as never);
  jest.mocked(desktopHost.fs).mockResolvedValue({ stat: async () => ({ isDirectory: () => true }) } as never);
  jest.mocked(desktopHost.path).mockResolvedValue({ isAbsolute: () => true } as never);
  return { spawn, requests, kills, messages, children, initialize: () => initialize?.(), replyTurn: (threadId: string) => turnReplies.get(threadId)?.(), replyInterrupt: () => interruptReplies.splice(0).forEach(reply => reply()), send: (value: unknown) => outputs[0](value),
    finish: (threadId: string) => outputs[0]({ method: 'turn/completed', params: { threadId, turn: { id: `turn-${threadId}`, status: 'completed' } } }) };
}
function settings(backend: string) {
  const root = document.body.createDiv();
  const plugin = { settings: { textExecutionBackend: backend }, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings: jest.fn() }) };
  return mountCodexExecutionControls(root, plugin as never, {});
}
function card() {
  const root = document.body.createDiv();
  const dispose = renderStudioCommandExecution(root, { value: undefined, app: {} as never, onChange: jest.fn() });
  const focus = () => root.querySelector('select')!.focus();
  return { root, dispose, focus };
}

it('shares one app-server across picker mounts and concurrent native runs', async () => {
  const native = host(), first = settings('codex');
  await flush(); first();
  const callbacks = () => ({ log: jest.fn(), thread: jest.fn(), request: jest.fn(async () => ({ decision: 'decline' })) });
  const result = await Promise.all(['/vault', '/other-vault'].map(workingDirectory => runLocalCodex({ workingDirectory, prompt: 'hello' }, new AbortController().signal, callbacks())));
  const remount = settings('codex'); await flush(); remount();
  expect(result.map(run => run.text).sort()).toEqual(['thread-1', 'thread-2']);
  expect(native.spawn).toHaveBeenCalledTimes(1);
  expect(native.requests.filter(method => method === 'initialize')).toHaveLength(1);
});

it('keeps one process across catalog expiry while busy, then shuts down when idle', async () => {
  const native = host();
  const first = settings('codex'), second = settings('codex'), studio = card(); studio.focus();
  await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1);
  expect(native.requests).toEqual(['initialize', 'initialized', 'account/read', 'config/read', 'model/list']);
  expect(native.kills[0]).not.toHaveBeenCalled();
  first(); second(); studio.dispose();
  jest.spyOn(Date, 'now').mockReturnValue(now + 59_999);
  const remount = settings('codex'), remountedCard = card(); remountedCard.focus(); await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1);
  remount(); remountedCard.dispose();
  jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  await readCodexCatalog('/vault', new AbortController().signal);
  expect(native.spawn).toHaveBeenCalledTimes(1);
  expect(native.requests.filter(method => method === 'config/read')).toHaveLength(2);
  expect(native.requests.filter(method => method === 'model/list')).toHaveLength(2);
  await flush();
  jest.advanceTimersByTime(59_999); await flush();
  expect(native.kills[0]).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); await flush();
  expect(native.kills[0]).toHaveBeenCalledTimes(1);
  await readCodexCatalog('/vault', new AbortController().signal, true);
  expect(native.spawn).toHaveBeenCalledTimes(2);
});

it('routes concurrent approvals and cancellation only to their owning thread, never idling a waiting run', async () => {
  const native = host({ wait: true }), firstAbort = new AbortController();
  let firstSignal: AbortSignal | undefined, respond!: (value: unknown) => void;
  const firstCallbacks = { log: jest.fn(), thread: jest.fn(), request: jest.fn((_method, _params, signal: AbortSignal) => {
    firstSignal = signal; return new Promise(resolve => { respond = resolve; });
  }) };
  const secondCallbacks = { log: jest.fn(), thread: jest.fn(), request: jest.fn(async () => ({ decision: 'decline' })) };
  const first = runLocalCodex({ workingDirectory: '/vault', prompt: 'first' }, firstAbort.signal, firstCallbacks);
  void first.catch(() => {});
  const second = runLocalCodex({ workingDirectory: '/other-vault', prompt: 'second' }, new AbortController().signal, secondCallbacks);
  await flush(); await flush();
  expect(native.requests.filter(method => method === 'turn/start')).toHaveLength(2);
  native.send({ id: 'first-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-thread-1', command: 'pwd' } });
  native.send({ id: 'second-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-2', turnId: 'turn-thread-2', command: 'pwd' } });
  await flush();
  expect(firstCallbacks.request).toHaveBeenCalledTimes(1); expect(secondCallbacks.request).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(120_000); await flush();
  expect(native.kills[0]).not.toHaveBeenCalled();
  firstAbort.abort(); await expect(first).rejects.toThrow('canceled');
  expect(firstSignal?.aborted).toBe(true);
  respond({ decision: 'accept' }); await flush();
  expect(native.messages.some(message => message.id === 'first-approval')).toBe(false);
  expect(native.messages.find(message => message.id === 'second-approval').result).toEqual({ decision: 'decline' });
  expect(native.messages.filter(message => message.method === 'turn/interrupt').map(message => message.params.threadId)).toEqual(['thread-1']);
  jest.advanceTimersByTime(120_000); await flush();
  expect(native.kills[0]).not.toHaveBeenCalled();
  native.finish('thread-2'); await expect(second).resolves.toMatchObject({ threadId: 'thread-2', status: 'completed' });
  expect(native.spawn).toHaveBeenCalledTimes(1);
});

it('keeps a shared handshake alive when a picker unmounts while a run is connecting', async () => {
  const native = host({ holdInitialize: true }), picker = settings('codex'); await flush();
  const run = runLocalCodex({ workingDirectory: '/vault', prompt: 'hello' }, new AbortController().signal, { log: jest.fn(), thread: jest.fn(), request: jest.fn() });
  await flush(); picker();
  native.initialize();
  await expect(run).resolves.toMatchObject({ status: 'completed' });
  expect(native.spawn).toHaveBeenCalledTimes(1); expect(native.kills[0]).not.toHaveBeenCalled();
});

it('invalidates retained idle chats and shows a reconnect notice on their next turn', async () => {
  const native = host(), notice = jest.fn(), transport = new CodexChatTransport(notice);
  const input = { workingDirectory: '/vault', prompt: 'hello', approvalMode: 'auto' };
  const callbacks = { log: jest.fn(), thread: jest.fn(), request: jest.fn() };
  const first = await transport.run(input, new AbortController().signal, callbacks);
  jest.advanceTimersByTime(60_000); await flush();
  expect(native.kills[0]).toHaveBeenCalledTimes(1); expect(transport.connection).toBeUndefined();
  await transport.run({ ...input, threadId: first.threadId }, new AbortController().signal, callbacks);
  expect(native.spawn).toHaveBeenCalledTimes(2);
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('Native session approvals may still apply'));
  await transport.close();
});

it.each(['before', 'after'])('interrupts an admitted turn canceled %s its start response without stopping its peer', async timing => {
  const controller = new AbortController();
  const native = host({ wait: true, holdTurnStart: timing === 'before', onTurnReply: threadId => { if (timing === 'after' && threadId === 'thread-1') controller.abort(); } });
  const callbacks = () => ({ log: jest.fn(), thread: jest.fn(), request: jest.fn() });
  const first = runLocalCodex({ workingDirectory: '/vault', prompt: 'first' }, controller.signal, callbacks()); void first.catch(() => {});
  const second = runLocalCodex({ workingDirectory: '/vault', prompt: 'second' }, new AbortController().signal, callbacks());
  await flush(); await flush();
  if (timing === 'before') { controller.abort(); native.replyTurn('thread-1'); native.replyTurn('thread-2'); }
  await expect(first).rejects.toThrow('canceled');
  expect(native.messages.filter(message => message.method === 'turn/interrupt').map(message => message.params)).toEqual([{ threadId: 'thread-1', turnId: 'turn-thread-1' }]);
  expect(native.kills[0]).not.toHaveBeenCalled();
  native.finish('thread-2'); await expect(second).resolves.toMatchObject({ threadId: 'thread-2' });
});

it('fails the shared process closed if native interruption cannot be confirmed', async () => {
  const native = host({ wait: true, failInterrupt: true }), controller = new AbortController();
  const callbacks = () => ({ log: jest.fn(), thread: jest.fn(), request: jest.fn() });
  const first = runLocalCodex({ workingDirectory: '/vault', prompt: 'first' }, controller.signal, callbacks()); void first.catch(() => {});
  const second = runLocalCodex({ workingDirectory: '/vault', prompt: 'second' }, new AbortController().signal, callbacks()); void second.catch(() => {});
  await flush(); await flush(); controller.abort();
  await expect(first).rejects.toThrow('canceled'); await expect(second).rejects.toThrow('closed');
  expect(native.kills[0]).toHaveBeenCalledTimes(1);
});

it('unload waits for an already-detaching turn to finish native interruption', async () => {
  const native = host({ wait: true, holdInterrupt: true }), controller = new AbortController();
  const run = runLocalCodex({ workingDirectory: '/vault', prompt: 'first' }, controller.signal, { log: jest.fn(), thread: jest.fn(), request: jest.fn() }); void run.catch(() => {});
  await flush(); await flush(); controller.abort(); await flush();
  const disposing = disposeCodexSession(); await flush();
  expect(native.kills[0]).not.toHaveBeenCalled();
  native.replyInterrupt(); await disposing; await expect(run).rejects.toThrow('canceled');
  expect(native.kills[0]).toHaveBeenCalledTimes(1);
});

it('detaches a canceled connecting caller without waiting for a shared handshake', async () => {
  const native = host({ holdInitialize: true }), picker = settings('codex'); await flush();
  const controller = new AbortController();
  const run = runLocalCodex({ workingDirectory: '/vault', prompt: 'hello' }, controller.signal, { log: jest.fn(), thread: jest.fn(), request: jest.fn() });
  await flush(); controller.abort(); await expect(run).rejects.toThrow('canceled');
  expect(native.kills[0]).not.toHaveBeenCalled();
  native.initialize(); await flush(); picker();
});

it('does not admit a connection that finishes validation after plugin unload', async () => {
  const native = host(); let validate!: (value: unknown) => void;
  jest.mocked(desktopHost.fs).mockResolvedValue({ stat: () => new Promise(resolve => { validate = resolve; }) } as never);
  const connection = connectCodex('/vault', new AbortController().signal, { error: jest.fn(), notification: jest.fn(), request: jest.fn() });
  await flush(); await disposeCodexSession();
  validate({ isDirectory: () => true }); await expect(connection).rejects.toThrow('canceled');
  expect(native.spawn).not.toHaveBeenCalled();
});

it('drains old native work before applying changed launch settings to a new connection', async () => {
  const native = host(), callbacks = { error: jest.fn(), notification: jest.fn(), request: jest.fn() };
  const first = await connectCodex('/vault', new AbortController().signal, callbacks);
  jest.mocked(resolveCodexLaunchOptions).mockResolvedValue({ binary: 'other-codex', home: '/home/test', codexHome: '/other-home', environment: { CODEX_HOME: '/other-home' } });
  const next = connectCodex('/vault', new AbortController().signal, callbacks); await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1); expect(native.kills[0]).not.toHaveBeenCalled();
  first.idle!(); const second = await next;
  expect(native.spawn).toHaveBeenCalledTimes(2);
  expect(native.spawn).toHaveBeenLastCalledWith('other-codex', ['app-server'], expect.objectContaining({ env: { CODEX_HOME: '/other-home' } }));
  first.close(); second.close(); await second.closed;
});

it('reconnect explicitly replaces an idle app-server without overlapping processes', async () => {
  const native = host();
  await readCodexCatalog('/vault', new AbortController().signal);
  await readCodexCatalog('/vault', new AbortController().signal, true);
  expect(native.spawn).toHaveBeenCalledTimes(2); expect(native.kills[0]).toHaveBeenCalledTimes(1);
});

it('isolates a throwing activity observer from another native run', async () => {
  const native = host({ wait: true }), callbacks = () => ({ log: jest.fn(), thread: jest.fn(), request: jest.fn() });
  const first = runLocalCodex({ workingDirectory: '/vault', prompt: 'first' }, new AbortController().signal, { ...callbacks(), text: () => { throw new Error('Observer failed'); } }); void first.catch(() => {});
  const second = runLocalCodex({ workingDirectory: '/vault', prompt: 'second' }, new AbortController().signal, callbacks());
  await flush(); await flush();
  native.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-thread-1', delta: 'hello' } });
  await expect(first).rejects.toThrow('Observer failed'); expect(native.kills[0]).not.toHaveBeenCalled();
  native.finish('thread-2'); await expect(second).resolves.toMatchObject({ status: 'completed' });
});

it('escalates termination when the owned app-server ignores its first signal', async () => {
  const native = host({ stubborn: true }); await readCodexCatalog('/vault', new AbortController().signal);
  const disposing = disposeCodexSession(); await flush();
  expect(native.kills[0]).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000); await disposing;
  expect(native.kills[0]).toHaveBeenLastCalledWith('SIGKILL');
});

it.each(['systemsculpt', 'claude'])('spawns nothing for %s users opening settings and remounting Command Center cards', async backend => {
  const native = host(), dispose = settings(backend);
  for (let i = 0; i < 3; i++) { const studio = card(); await flush(); studio.dispose(); }
  expect(native.spawn).not.toHaveBeenCalled();
  expect(desktopHost.childProcess).not.toHaveBeenCalled();
  dispose();
});

it('loads a Command Center catalog only on interaction and removes activation listeners on dispose', async () => {
  const native = host(), studio = card(); await flush();
  expect(native.spawn).not.toHaveBeenCalled();
  expect(studio.root.querySelector('select')!.disabled).toBe(false);
  studio.focus(); await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1);
  expect(studio.root.querySelector('select')).toBe(document.activeElement);
  studio.dispose();
  jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  const abandoned = card(); abandoned.dispose(); abandoned.focus(); await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1);
});
