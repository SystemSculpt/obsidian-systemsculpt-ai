import { EventEmitter } from 'node:events';
import { runLocalCodex } from '../LocalCodexClient';
import { desktopHost } from '../../../platform/desktopOnly';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { childProcess: jest.fn(), fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn() } }));

function host(options: { failLogin?: boolean; requestApproval?: boolean; wait?: boolean; malformed?: boolean; nativePolicy?: unknown; nativeReviewer?: string; nativeSandbox?: unknown; nativeProfile?: string; savedTurn?: unknown } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }), stderr: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: jest.fn() }), kill: jest.fn(),
  });
  const messages: any[] = [];
  const send = (value: unknown) => child.stdout.emit('data', JSON.stringify(value) + '\n');
  const finish = () => {
    send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', delta: 'hello' } });
    send({ method: 'item/completed', params: { threadId: 'native-thread', item: { type: 'agentMessage', text: 'hello' } } });
    send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } });
  };
  child.stdin.write.mockImplementation((line: string) => {
    const msg = JSON.parse(line); messages.push(msg);
    queueMicrotask(() => {
      if (options.malformed) { child.stdout.emit('data', 'invalid-json\n'); return; }
      if (msg.method === 'initialize') send({ id: msg.id, result: {} });
      if (msg.method === 'account/read') send({ id: msg.id, result: { account: options.failLogin ? null : { type: 'chatgpt' } } });
      if (msg.method === 'thread/start' || msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { id: msg.params.ephemeral ? 'ephemeral-config' : 'native-thread' }, approvalPolicy: options.nativePolicy ?? 'never', approvalsReviewer: options.nativeReviewer ?? 'user', sandbox: options.nativeSandbox ?? { type: 'readOnly' }, ...(options.nativeProfile ? { activePermissionProfile: { id: options.nativeProfile } } : {}) } });
      if (msg.method === 'turn/interrupt') send({ id: msg.id, result: {} });
      if (msg.method === 'thread/read') send({ id: msg.id, result: { thread: { id: 'native-thread', turns: options.savedTurn ? [options.savedTurn] : [] } } });
      if (msg.method === 'turn/start') {
        send({ id: msg.id, result: { turn: { id: 'native-turn' } } });
        if (options.requestApproval) send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', command: 'echo hello' } });
        else if (!options.wait) finish();
      }
      if (msg.id === 99 && msg.result) finish();
    });
    return true;
  });
  (desktopHost.childProcess as jest.Mock).mockResolvedValue({ spawn: jest.fn(() => child) });
  (desktopHost.fs as jest.Mock).mockResolvedValue({ stat: jest.fn(async () => ({ isDirectory: () => true })) });
  (desktopHost.path as jest.Mock).mockResolvedValue({ isAbsolute: (path: string) => path.startsWith('/'), delimiter: ':', join: (...parts: string[]) => parts.join('/') });
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => '/home/test' });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/bin', HOME: '/home/test' });
  return { child, messages };
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
  expect(cb.request).toHaveBeenCalledWith('item/commandExecution/requestApproval', expect.objectContaining({ command: 'echo hello' }), expect.any(AbortSignal));
  expect(messages.find(m => m.id === 99).result).toEqual({ decision: 'decline' });
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

it('forwards user-selected model, thinking and speed to the native thread and turn', async () => {
  const { messages } = host();
  await runLocalCodex({ ...input, model: 'selected-model', effort: 'xhigh', serviceTier: 'priority' }, new AbortController().signal, callbacks());
  expect(messages.find(m => m.method === 'thread/start').params).toMatchObject({ model: 'selected-model', serviceTier: 'priority', config: { model_reasoning_effort: 'xhigh' } });
  expect(messages.find(m => m.method === 'turn/start').params).toMatchObject({ model: 'selected-model', effort: 'xhigh', serviceTierForTurn: 'priority' });
});

it('lets a new native thread inherit config without permission overrides', async () => {
  const { messages } = host();
  await runLocalCodex(input, new AbortController().signal, callbacks());
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
  await runLocalCodex({ ...input, threadId: 'native-thread' }, new AbortController().signal, callbacks());
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
