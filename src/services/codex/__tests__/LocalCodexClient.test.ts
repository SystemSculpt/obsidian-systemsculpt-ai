import { EventEmitter } from 'node:events';
import { posix, win32 } from 'node:path';
import { CodexChatTransport, runLocalCodex } from '../LocalCodexClient';
import { desktopHost } from '../../../platform/desktopOnly';
import { windowsNpmHost } from './fixtures/npmNodeShim';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { childProcess: jest.fn(), fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn() } }));

function host(options: { failLogin?: boolean; requiresOpenaiAuth?: boolean; requestApproval?: boolean; wait?: boolean; malformed?: boolean; nativePolicy?: unknown; nativeReviewer?: string; nativeSandbox?: unknown; nativeProfile?: string; savedTurn?: unknown } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }), stderr: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: jest.fn() }), kill: jest.fn(),
  });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  const messages: any[] = [];
  let turnNumber = 0, turnId = 'native-turn';
  const send = (value: unknown) => child.stdout.emit('data', JSON.stringify(value) + '\n');
  const finish = () => {
    send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', delta: 'hello' } });
    send({ method: 'item/completed', params: { threadId: 'native-thread', item: { type: 'agentMessage', text: 'hello' } } });
    send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: turnId, status: 'completed' } } });
  };
  child.stdin.write.mockImplementation((line: string) => {
    const msg = JSON.parse(line); messages.push(msg);
    queueMicrotask(() => {
      if (options.malformed) { child.stdout.emit('data', 'invalid-json\n'); return; }
      if (msg.method === 'initialize') send({ id: msg.id, result: {} });
      if (msg.method === 'account/read') send({ id: msg.id, result: { account: options.failLogin ? null : { type: 'chatgpt' }, requiresOpenaiAuth: options.requiresOpenaiAuth ?? true } });
      if (msg.method === 'thread/start' || msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { id: msg.params.ephemeral ? 'ephemeral-config' : 'native-thread' }, approvalPolicy: options.nativePolicy ?? 'never', approvalsReviewer: options.nativeReviewer ?? 'user', sandbox: options.nativeSandbox ?? { type: 'readOnly' }, ...(options.nativeProfile ? { activePermissionProfile: { id: options.nativeProfile } } : {}) } });
      if (msg.method === 'turn/interrupt') send({ id: msg.id, result: {} });
      if (msg.method === 'thread/read') send({ id: msg.id, result: { thread: { id: 'native-thread', turns: options.savedTurn ? [options.savedTurn] : [] } } });
      if (msg.method === 'turn/start') {
        turnId = ++turnNumber === 1 ? 'native-turn' : `native-turn-${turnNumber}`;
        send({ id: msg.id, result: { turn: { id: turnId } } });
        if (options.requestApproval) send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', command: 'echo hello' } });
        else if (!options.wait) finish();
      }
      if (msg.id === 99 && msg.result) finish();
    });
    return true;
  });
  (desktopHost.childProcess as jest.Mock).mockResolvedValue({ spawn: jest.fn(() => child) });
  (desktopHost.fs as jest.Mock).mockResolvedValue({ readdir: jest.fn(async () => []), stat: jest.fn(async () => ({ isDirectory: () => true, isFile: () => false })), readFile: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })) });
  (desktopHost.path as jest.Mock).mockResolvedValue(posix);
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => '/home/test', platform: () => 'darwin' });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/bin', HOME: '/home/test' });
  return { child, messages, send, finish };
}
const callbacks = () => ({ log: jest.fn(), thread: jest.fn(), text: jest.fn(), request: jest.fn(async () => ({ decision: 'decline' })) });
const input = { prompt: 'hello', workingDirectory: '/workspace' };
beforeEach(() => jest.clearAllMocks());
it('uses native login and astra/high, streams the answer and closes its transport', async () => {
  const { child, messages } = host(), cb = callbacks();
  await expect(runLocalCodex(input, new AbortController().signal, cb)).resolves.toMatchObject({ threadId: 'native-thread', text: 'hello', status: 'completed' });
  const childProcess = await desktopHost.childProcess();
  expect(childProcess.spawn).toHaveBeenCalledWith('codex', ['app-server'], expect.objectContaining({ cwd: '/home/test' }));
  expect(messages.find(m => m.method === 'thread/start').params.cwd).toBe('/workspace');
  expect(messages.find(m => m.method === 'account/read').params).toEqual({ refreshToken: false });
  expect(messages.find(m => m.method === 'thread/start').params).toMatchObject({ model: 'gpt-6-astra' });
  expect(messages.find(m => m.method === 'turn/start').params).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
  expect(cb.text).toHaveBeenCalledWith('hello'); expect(child.kill).toHaveBeenCalled();
});
it.each(['/home/test/.nvm/versions/node/v22.18.0/bin', '/home/test/.volta/bin'])('launches an app-server and its node interpreter from %s with a bare GUI PATH', async folder => {
  const { child } = host(), fs = await desktopHost.fs();
  const files = new Set([`${folder}/codex`, `${folder}/node`]);
  (fs.stat as jest.Mock).mockImplementation(async path => ({ isDirectory: () => !files.has(path), isFile: () => files.has(path), mode: 0o100755 }));
  (fs.readdir as jest.Mock).mockImplementation(async path => path === '/home/test/.nvm/versions/node' && folder.includes('/.nvm/')
    ? [{ name: 'v22.18.0', isDirectory: () => true }] : []);
  const spawn = (await desktopHost.childProcess()).spawn as jest.Mock;
  spawn.mockImplementationOnce((binary: string, _args: string[], options: { env: { PATH: string } }) => {
    const resolve = (name: string) => options.env.PATH.split(':').map(path => `${path}/${name}`).find(path => files.has(path));
    expect(resolve(binary)).toBe(`${folder}/codex`);
    expect(resolve('node')).toBe(`${folder}/node`);
    return child;
  });
  await expect(runLocalCodex(input, new AbortController().signal, callbacks())).resolves.toMatchObject({ text: 'hello', status: 'completed' });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('launches a Windows npm app-server with its native home and approval protocol intact', async () => {
  const { messages } = host({ requestApproval: true }), windows = windowsNpmHost(), cb = callbacks();
  const prompt = 'Read "notes" & echo injected > marker %PATH% !name!\nnext line';
  await expect(runLocalCodex({ ...input, prompt, workingDirectory: windows.cwd }, new AbortController().signal, cb)).resolves.toMatchObject({ status: 'completed' });
  expect((await desktopHost.childProcess()).spawn).toHaveBeenCalledWith(windows.node, [windows.scripts.codex, 'app-server'],
    expect.objectContaining({ shell: false, cwd: windows.home, env: expect.objectContaining({ CODEX_HOME: windows.environment.CODEX_HOME }) }));
  expect(messages.find(m => m.method === 'thread/start').params.cwd).toBe(windows.cwd);
  expect(messages.find(m => m.method === 'turn/start').params.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: prompt })]));
  expect(messages.find(m => m.method === 'account/read').params).toEqual({ refreshToken: false });
  expect(cb.request).toHaveBeenCalledTimes(1);
  expect(messages.find(m => m.id === 99).result).toEqual({ decision: 'decline' });
});
it('persists the native identity before admitting a resumed turn', async () => {
  const { messages } = host(); const cb = callbacks();
  cb.thread.mockImplementation(async () => { expect(messages.some(m => m.method === 'turn/start')).toBe(false); });
  await runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, cb);
  expect(messages.filter(m => m.method === 'thread/start').every(m => m.params.ephemeral === true)).toBe(true);
  expect(messages.find(m => m.method === 'thread/resume').params.threadId).toBe('native-thread');
});
it('forwards native approval requests and the exact decision without auto-approval', async () => {
  const { messages } = host({ requestApproval: true }), cb = callbacks();
  await runLocalCodex(input, new AbortController().signal, cb);
  expect(cb.request).toHaveBeenCalledWith('item/commandExecution/requestApproval', expect.objectContaining({ command: 'echo hello' }), expect.any(AbortSignal), 99);
  expect(messages.find(m => m.id === 99).result).toEqual({ decision: 'decline' });
});
it.each(['resolved', 'completed', 'cancelled', 'failed'])('withdraws outstanding native requests and never writes a stale response (%s)', async ending => {
  const { messages, send, finish, child } = host({ wait: true }), controller = new AbortController();
  let requestSignal: AbortSignal | undefined, respond!: (value: unknown) => void;
  const request = jest.fn((_method, _params, signal: AbortSignal) => { requestSignal = signal; return new Promise(resolve => { respond = resolve; }); });
  const running = runLocalCodex(input, controller.signal, { ...callbacks(), request });
  void running.catch(() => {});
  for (let i = 0; i < 60 && !messages.some(message => message.method === 'turn/start'); i++) await Promise.resolve();
  send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'native-turn', itemId: 'command', command: 'pwd' } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(requestSignal?.aborted).toBe(false);
  if (ending === 'resolved') send({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 'approval' } });
  else if (ending === 'completed') finish();
  else if (ending === 'cancelled') controller.abort();
  else child.emit('error', new Error('native failed'));
  expect(requestSignal?.aborted).toBe(true);
  respond({ decision: 'accept' });
  if (ending === 'resolved') finish();
  if (ending === 'cancelled' || ending === 'failed') await expect(running).rejects.toThrow(); else await running;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(messages.some(message => message.id === 'approval')).toBe(false);
});
it('retains exact file diffs for request review and publishes native item activity', async () => {
  const { messages, send, finish } = host({ wait: true }), activity = jest.fn(), request = jest.fn(async () => ({ decision: 'acceptForSession' }));
  const running = runLocalCodex(input, new AbortController().signal, { ...callbacks(), activity, request });
  for (let i = 0; i < 60 && !messages.some(message => message.method === 'turn/start'); i++) await Promise.resolve();
  const item = { id: 'file', type: 'fileChange', status: 'inProgress', changes: [{ path: '/project/a.md', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' }] };
  send({ method: 'item/started', params: { threadId: 'native-thread', item } });
  send({ id: 101, method: 'item/fileChange/requestApproval', params: { threadId: 'native-thread', turnId: 'native-turn', itemId: 'file', reason: 'Review exact changes' } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(request).toHaveBeenCalledWith('item/fileChange/requestApproval', expect.objectContaining({ change: item }), expect.any(AbortSignal), 101);
  expect(messages.find(message => message.id === 101)?.result).toEqual({ decision: 'acceptForSession' });
  expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'file', kind: 'file' }), item);
  finish(); await running;
});

describe('chat-owned native transport', () => {
  it('retains the thread lock and waits for child close before starting a replacement', async () => {
    const first = host(), transport = new CodexChatTransport();
    await transport.run(input, new AbortController().signal, callbacks());
    first.child.kill.mockImplementation(() => true); // Deliberately delay native stdio closure.
    const second = host();
    const replacing = transport.run({ ...input, threadId: 'native-thread', effort: 'medium' }, new AbortController().signal, callbacks());
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(first.child.kill).toHaveBeenCalled(); expect(second.messages).toHaveLength(0);
    await expect(runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks())).rejects.toThrow('already running');
    first.child.emit('close', 0);
    try { await expect(replacing).resolves.toMatchObject({ status: 'completed' }); }
    finally { await transport.close(); }
  });
  it('emits exact text tail offsets beyond the Studio rolling buffer', async () => {
    const { messages, send } = host({ wait: true }), transport = new CodexChatTransport(), updates: [string, number][] = [];
    const running = transport.run(input, new AbortController().signal, { ...callbacks(), text: (text, offset = 0) => updates.push([text, offset]) });
    for (let i = 0; i < 60 && !messages.some(message => message.method === 'turn/start'); i++) await Promise.resolve();
    const chunks = ['a'.repeat(255_990), 'b'.repeat(20), 'tail'];
    for (const delta of chunks) send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', turnId: 'native-turn', delta } });
    const full = chunks.join('');
    send({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'native-turn', item: { type: 'agentMessage', text: full } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', turnId: 'native-turn', delta: 'next' } });
    send({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'native-turn', item: { type: 'agentMessage', text: 'next' } } });
    send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } });
    try {
      await running;
      expect(updates).toEqual([[chunks[0], 0], [chunks[1], 255_990], ['tail', 256_010], [full, 0], ['\n\nnext', full.length], ['\n\nnext', full.length]]);
      expect(updates.reduce((text, [tail, offset]) => text.slice(0, offset) + tail, '')).toBe(`${full}\n\nnext`);
    } finally { await transport.close(); }
  });
  it('keeps one loaded thread for serial turns and never replays approval answers', async () => {
    const { messages, child } = host({ requestApproval: true }), notice = jest.fn(), transport = new CodexChatTransport(notice);
    const first = callbacks(); first.request.mockResolvedValue({ decision: 'acceptForSession' });
    try {
      await transport.run(input, new AbortController().signal, first);
      expect(child.kill).not.toHaveBeenCalled();
      await expect(runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks())).rejects.toThrow('already running');
      const second = callbacks();
      await expect(transport.run({ ...input, threadId: 'native-thread' }, new AbortController().signal, second)).resolves.toMatchObject({ turnId: 'native-turn-2' });
      expect((await desktopHost.childProcess()).spawn).toHaveBeenCalledTimes(1);
      expect(messages.filter(message => message.method === 'thread/start')).toHaveLength(1);
      expect(messages.some(message => message.method === 'thread/resume')).toBe(false);
      expect(second.request).toHaveBeenCalledTimes(1); // Native prompts, not a plugin policy cache, still decide.
      expect(messages.filter(message => message.id === 99).map(message => message.result)).toEqual([{ decision: 'acceptForSession' }, { decision: 'decline' }]);
      expect(notice).not.toHaveBeenCalled();
    } finally { await transport.close(); }
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it.each([{ model: 'gpt-5.4' }, { effort: 'medium' }, { workingDirectory: '/other' }])('restarts and explains reset for changed options (%j)', async change => {
    const first = host(), notice = jest.fn(), transport = new CodexChatTransport(notice);
    await transport.run(input, new AbortController().signal, callbacks());
    const second = host();
    try {
      await transport.run({ ...input, threadId: 'native-thread', ...change }, new AbortController().signal, callbacks());
      expect(first.child.kill).toHaveBeenCalledTimes(1); expect(second.messages.some(message => message.method === 'thread/resume')).toBe(true);
      expect(notice).toHaveBeenCalledWith(expect.stringContaining('Previous session approvals no longer apply'));
    } finally { await transport.close(); }
  });
  it('invalidates idle child exit, releases its lock and reconnects with a reset notice', async () => {
    const first = host(), notice = jest.fn(), transport = new CodexChatTransport(notice);
    await transport.run(input, new AbortController().signal, callbacks());
    first.child.emit('exit', 1);
    const second = host();
    try {
      await transport.run({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks());
      expect(second.messages.some(message => message.method === 'thread/resume')).toBe(true); expect(notice).toHaveBeenCalledTimes(1);
    } finally { await transport.close(); }
  });
  it('ignores old-turn activity and cancels a subsequent turn through its own signal', async () => {
    const { messages, send, finish, child } = host({ wait: true }), transport = new CodexChatTransport();
    const first = transport.run(input, new AbortController().signal, callbacks());
    for (let i = 0; i < 60 && !messages.some(message => message.method === 'turn/start'); i++) await Promise.resolve();
    finish(); await first;
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined, respond!: (value: { decision: string }) => void;
    const second = { ...callbacks(), request: jest.fn((_method, _params, signal: AbortSignal) => { requestSignal = signal; return new Promise(resolve => { respond = resolve; }); }) };
    const running = transport.run({ ...input, threadId: 'native-thread' }, controller.signal, second);
    for (let i = 0; i < 60 && messages.filter(message => message.method === 'turn/start').length < 2; i++) await Promise.resolve();
    send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', turnId: 'native-turn', delta: 'stale' } });
    send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } });
    expect(second.text).not.toHaveBeenCalled();
    send({ id: 'second-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'native-turn-2', itemId: 'command', command: 'pwd' } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(requestSignal?.aborted).toBe(false);
    await expect(transport.run(input, new AbortController().signal, callbacks())).rejects.toThrow('Wait for');
    controller.abort(); await expect(running).rejects.toThrow('canceled');
    expect(requestSignal?.aborted).toBe(true); respond({ decision: 'accept' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(messages.some(message => message.id === 'second-approval')).toBe(false);
    expect(child.kill).toHaveBeenCalled(); expect(transport.connection).toBeUndefined();
  });
});

it('fails before thread creation when the machine is signed out', async () => {
  const { messages, child } = host({ failLogin: true });
  await expect(runLocalCodex(input, new AbortController().signal, callbacks())).rejects.toThrow('codex login');
  expect(messages.filter(m => m.method === 'thread/start').every(m => m.params.ephemeral === true)).toBe(true); expect(child.kill).toHaveBeenCalled();
});
it('interrupts the native turn on cancellation and closes the process', async () => {
  const { child, messages } = host({ wait: true }), controller = new AbortController();
  const result = runLocalCodex(input, controller.signal, callbacks());
  for (let index = 0; index < 30 && !messages.some(m => m.method === 'turn/start'); index++) await Promise.resolve();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  controller.abort(); await expect(result).rejects.toThrow('canceled');
  expect(messages.some(m => m.method === 'turn/interrupt')).toBe(true); expect(child.kill).toHaveBeenCalled();
});
it('fails closed on malformed protocol input', async () => {
  host({ malformed: true });
  await expect(runLocalCodex(input, new AbortController().signal, callbacks())).rejects.toThrow('Invalid Codex protocol');
});
it('rejects a concurrent resume before changing the active native thread configuration', async () => {
  const first = host({ wait: true }), controller = new AbortController();
  const running = runLocalCodex({ ...input, threadId: 'native-thread' }, controller.signal, callbacks());
  void running.catch(() => {});
  for (let index = 0; index < 50 && !first.messages.some(message => message.method === 'turn/start'); index++) await Promise.resolve();
  expect(first.messages.some(message => message.method === 'turn/start')).toBe(true);
  try {
    const second = host({ wait: true });
    await expect(runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks())).rejects.toThrow('already running');
    expect(second.messages.some(message => ['thread/start', 'thread/resume'].includes(message.method))).toBe(false);
  } finally { controller.abort(); await expect(running).rejects.toThrow('canceled'); }
  host();
  await expect(runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks())).resolves.toMatchObject({ status: 'completed' });
});
it('releases a reserved thread when initialization fails before resume', async () => {
  host({ failLogin: true });
  await expect(runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks())).rejects.toThrow('codex login');
  host();
  await expect(runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks())).resolves.toMatchObject({ status: 'completed' });
});

it('forwards user-selected model, thinking and speed to the native thread and turn', async () => {
  const { messages } = host();
  await runLocalCodex({ ...input, model: 'selected-model', effort: 'xhigh', serviceTier: 'priority' }, new AbortController().signal, callbacks());
  expect(messages.find(m => m.method === 'thread/start').params).toMatchObject({ model: 'selected-model', serviceTier: 'priority', config: { model_reasoning_effort: 'xhigh' } });
  expect(messages.find(m => m.method === 'turn/start').params).toMatchObject({ model: 'selected-model', effort: 'xhigh', serviceTierForTurn: 'priority' });
});

describe.each([
  { approvalMode: 'auto', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false } },
  { approvalMode: 'ask', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false } },
  { approvalMode: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
])('Codex approval mode $approvalMode', ({ approvalMode, approvalPolicy, approvalsReviewer, sandbox, sandboxPolicy }) => {
  it.each([undefined, 'native-thread'])('applies the selected policy to the thread and turn (resume %s)', async threadId => {
    const { messages } = host({ nativeProfile: 'previous-policy' });
    await runLocalCodex({ ...input, approvalMode, threadId }, new AbortController().signal, callbacks());
    const threads = messages.filter(message => ['thread/start', 'thread/resume'].includes(message.method));
    expect(threads).toHaveLength(1);
    expect(threads[0].method).toBe(threadId ? 'thread/resume' : 'thread/start');
    expect(threads[0].params).toMatchObject({ cwd: '/workspace', approvalPolicy, approvalsReviewer, sandbox });
    expect(threads[0].params).not.toHaveProperty('permissions');
    expect(threads[0].params).not.toHaveProperty('ephemeral');
    expect(messages.find(message => message.method === 'turn/start').params).toMatchObject({ approvalPolicy, approvalsReviewer, sandboxPolicy });
  });
});

it('rejects an unsupported approval mode before starting a native process', async () => {
  host();
  await expect(runLocalCodex({ ...input, approvalMode: 'bypass' }, new AbortController().signal, callbacks())).rejects.toThrow('Invalid Codex approval mode');
  expect((await desktopHost.childProcess()).spawn).not.toHaveBeenCalled();
});

it.each([undefined, 'settings'])('lets a new native thread inherit config without overrides for Studio or settings (%s)', async approvalMode => {
  const { messages } = host();
  await runLocalCodex({ ...input, approvalMode }, new AbortController().signal, callbacks());
  for (const message of messages.filter(message => ['thread/start', 'turn/start'].includes(message.method))) {
    for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy', 'permissions']) expect(message.params).not.toHaveProperty(key);
  }
});
it.each([
  { nativePolicy: 'never', nativeReviewer: 'user', nativeSandbox: { type: 'dangerFullAccess' } },
  { nativePolicy: { granular: { sandbox_approval: false, rules: true } }, nativeReviewer: 'guardian_subagent', nativeSandbox: { type: 'workspaceWrite', writableRoots: ['/vault'], networkAccess: false } },
  { nativePolicy: 'untrusted', nativeReviewer: 'user', nativeSandbox: { type: 'readOnly' }, nativeProfile: 'locked-workspace' },
])('refreshes resumed permissions verbatim from native config, including granular policy and reviewer (%j)', async policy => {
  const { messages } = host(policy);
  await runLocalCodex({ ...input, approvalMode: 'settings', threadId: 'native-thread' }, new AbortController().signal, callbacks());
  const probe = messages.find(m => m.method === 'thread/start');
  expect(probe.params.ephemeral).toBe(true);
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions']) expect(probe.params).not.toHaveProperty(key);
  const resume = messages.find(m => m.method === 'thread/resume');
  expect(resume.params).toMatchObject({ approvalPolicy: policy.nativePolicy, approvalsReviewer: policy.nativeReviewer });
  const turn = messages.find(m => m.method === 'turn/start');
  expect(messages.filter(m => m.method === 'turn/start')).toHaveLength(1);
  expect(turn.params.threadId).toBe('native-thread');
  if ('nativeProfile' in policy) { expect(resume.params.permissions).toBe(policy.nativeProfile); expect(turn.params).not.toHaveProperty('sandboxPolicy'); }
  else expect(turn.params.sandboxPolicy).toEqual(policy.nativeSandbox);
});

it('recovers a completed native turn after a lost projection write without starting another turn', async () => {
  const { messages } = host({ savedTurn: { id: 'saved-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Already verified.' }] } });
  await expect(runLocalCodex({ ...input, threadId: 'native-thread', recoverCompletedTurn: true }, new AbortController().signal, callbacks())).resolves.toMatchObject({ text: 'Already verified.', turnId: 'saved-turn' });
  expect(messages.some(message => message.method === 'turn/start')).toBe(false);
});
it('resumes interrupted native history once and refuses to duplicate a still-active native turn', async () => {
  const { messages } = host({ savedTurn: { id: 'saved-turn', status: 'interrupted' } });
  await runLocalCodex({ ...input, threadId: 'native-thread', recoverCompletedTurn: true }, new AbortController().signal, callbacks());
  expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(1);
  const active = host({ savedTurn: { id: 'saved-turn', status: 'inProgress' } });
  await expect(runLocalCodex({ ...input, threadId: 'native-thread', recoverCompletedTurn: true }, new AbortController().signal, callbacks())).rejects.toThrow('still active');
  expect(active.messages.some(message => message.method === 'turn/start')).toBe(false);
});

it('accepts a provider that does not require an OpenAI account', async () => {
  host({ failLogin: true, requiresOpenaiAuth: false });
  await expect(runLocalCodex(input, new AbortController().signal, callbacks())).resolves.toMatchObject({ status: 'completed' });
});
it('uses CODEX_HOME for the same native login and history detected by the plugin', async () => {
  host();
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/bin', CODEX_HOME: '/agent/shadow', HOME: '/home/test' });
  await runLocalCodex(input, new AbortController().signal, callbacks());
  expect((await desktopHost.childProcess()).spawn).toHaveBeenCalledWith('codex', ['app-server'], expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/agent/shadow' }) }));
});
it('launches an explicitly configured wrapper and home without a shell', async () => {
  host({ failLogin: true, requiresOpenaiAuth: false });
  const fs = await desktopHost.fs();
  (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify({ binary: '~/.local/bin/codex-via-lb', home: '~/.codex-t3/codex-lb' }));
  await runLocalCodex(input, new AbortController().signal, callbacks());
  expect((await desktopHost.childProcess()).spawn).toHaveBeenCalledWith('/home/test/.local/bin/codex-via-lb', ['app-server'], expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/home/test/.codex-t3/codex-lb' }) }));
});
it('fails before starting Codex when launch preferences are malformed', async () => {
  host();
  ((await desktopHost.fs()).readFile as jest.Mock).mockResolvedValue('{bad');
  await expect(runLocalCodex(input, new AbortController().signal, callbacks())).rejects.toThrow('Cannot read Codex launch settings');
  expect((await desktopHost.childProcess()).spawn).not.toHaveBeenCalled();
});

it.each([undefined, '/custom/codex-home'])('explains how to recover a missing Codex home (%s)', async homePath => {
  host();
  const fs = await desktopHost.fs();
  if (homePath) (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify({ home: homePath }));
  (fs.stat as jest.Mock).mockImplementation(async path => {
    if (path !== input.workingDirectory) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  });
  await expect(runLocalCodex(input, new AbortController().signal, callbacks())).rejects.toThrow('Run codex login');
  expect((await desktopHost.childProcess()).spawn).not.toHaveBeenCalled();
});

it.each([false, true])('resolves native Windows homes and preserves PATH entries (custom: %s)', async custom => {
  host();
  const home = String.raw`C:\Users\tester`, nativePath = String.raw`C:\Windows\System32;C:\tools`;
  (desktopHost.path as jest.Mock).mockResolvedValue(win32);
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => home, platform: () => 'win32' });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: nativePath, CODEX_HOME: String.raw`C:\agent\shadow` });
  const fs = await desktopHost.fs();
  if (custom) (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify({ binary: '~/tools/codex.exe', home: '~/custom-codex' }));
  await runLocalCodex({ ...input, workingDirectory: String.raw`C:\vault` }, new AbortController().signal, callbacks());
  expect(fs.readFile).toHaveBeenCalledWith(win32.join(home, '.config', 'systemsculpt', 'codex.json'), 'utf8');
  const spawn = (await desktopHost.childProcess()).spawn as jest.Mock;
  expect(spawn).toHaveBeenCalledWith(custom ? win32.join(home, 'tools/codex.exe') : 'codex', ['app-server'], expect.objectContaining({
    cwd: home, env: expect.objectContaining({ CODEX_HOME: custom ? win32.join(home, 'custom-codex') : String.raw`C:\agent\shadow` }),
  }));
  const entries = spawn.mock.calls[0][2].env.PATH.split(';');
  expect(entries.slice(0, 2)).toEqual(nativePath.split(';'));
  expect(entries).toContain(win32.join(home, '.local/bin'));
});
