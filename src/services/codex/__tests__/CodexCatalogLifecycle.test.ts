/** @jest-environment jsdom */
import { EventEmitter } from 'node:events';
import { desktopHost } from '../../../platform/desktopOnly';
import { mountCodexExecutionControls } from '../CodexExecutionControls';
import { renderStudioCommandExecution } from '../../../views/studio/canvas/StudioCommandExecutionControls';
import { readCodexCatalog } from '../CodexModelCatalog';

jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { childProcess: jest.fn(), fs: jest.fn(), path: jest.fn(), os: async () => ({ platform: () => 'darwin' }) } }));
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: () => true }));
jest.mock('../CodexLaunch', () => ({ resolveCodexLaunchOptions: async () => ({ binary: 'codex', home: '/home/test', environment: {} }) }));
jest.mock('../CodexExecutionSettings', () => ({ ...jest.requireActual('../CodexExecutionSettings'), codexVaultDirectory: () => '/vault' }));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let now = Date.now();
beforeEach(() => { jest.clearAllMocks(); now += 120_000; jest.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { jest.restoreAllMocks(); document.body.replaceChildren(); });

function host() {
  const requests: string[] = [], kills: jest.Mock[] = [];
  const spawn = jest.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
      stdin: Object.assign(new EventEmitter(), { write: jest.fn() }), kill: jest.fn(),
    });
    kills.push(child.kill);
    child.kill.mockImplementation(() => { child.emit('close', 0); return true; });
    child.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line); requests.push(message.method);
      if (message.id === undefined) return true;
      const result = message.method === 'account/read' ? { account: { type: 'chatgpt' } }
        : message.method === 'config/read' ? { config: { approval_policy: 'untrusted', sandbox_mode: 'read-only' } }
        : message.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] } : {};
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`));
      return true;
    });
    return child;
  });
  jest.mocked(desktopHost.childProcess).mockResolvedValue({ spawn } as never);
  jest.mocked(desktopHost.fs).mockResolvedValue({ stat: async () => ({ isDirectory: () => true }) } as never);
  jest.mocked(desktopHost.path).mockResolvedValue({ isAbsolute: () => true } as never);
  return { spawn, requests, kills };
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

it('spawns once across simultaneous and later mounts, then once after the existing cache window expires', async () => {
  const native = host();
  const first = settings('codex'), second = settings('codex'), studio = card(); studio.focus();
  await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1);
  expect(native.requests).toEqual(['initialize', 'initialized', 'account/read', 'config/read', 'model/list']);
  expect(native.kills[0]).toHaveBeenCalledTimes(1);
  first(); second(); studio.dispose();
  jest.spyOn(Date, 'now').mockReturnValue(now + 59_999);
  const remount = settings('codex'), remountedCard = card(); remountedCard.focus(); await flush();
  expect(native.spawn).toHaveBeenCalledTimes(1);
  remount(); remountedCard.dispose();
  jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  await readCodexCatalog('/vault', new AbortController().signal);
  expect(native.spawn).toHaveBeenCalledTimes(2);
  expect(native.requests.filter(method => method === 'config/read')).toHaveLength(2);
  expect(native.requests.filter(method => method === 'model/list')).toHaveLength(2);
  expect(native.kills[1]).toHaveBeenCalledTimes(1);
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
