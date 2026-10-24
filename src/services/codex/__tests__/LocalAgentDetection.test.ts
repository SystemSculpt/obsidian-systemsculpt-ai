import { posix } from 'node:path';
import { desktopHost } from '../../../platform/desktopOnly';
import { hasHostCapability } from '../../../platform/hostCapabilities';
import { detectLocalAgents, invalidateLocalAgentDetection, subscribeLocalAgentDetection } from '../LocalAgentDetection';
import { resolveDefaultChatBackend } from '../DefaultChatBackend';
import { DEFAULT_SETTINGS } from '../../../types';
import { migrateSettingsToCurrentSchema } from '../../../core/settings/migrations/SettingsMigrator';
import { windowsNpmHost } from './fixtures/npmNodeShim';

jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn(), childProcess: jest.fn() } }));
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));

const now = Date.UTC(2026, 9, 23, 12);
const day = 24 * 60 * 60 * 1000;
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
type Agent = 'claude' | 'codex';
type MachineOptions = {
  installed?: Agent[];
  signedIn?: Agent[];
  environment?: Record<string, string>;
  configs?: Partial<Record<Agent, Record<string, string>>>;
  status?: Partial<Record<Agent, { error?: Error; stdout?: string; stderr?: string }>>;
  hang?: Agent;
};

function machine(options: MachineOptions = {}) {
  const stats = new Map<string, { isFile: () => boolean; isDirectory: () => boolean; mode: number; mtimeMs: number }>();
  const directories = new Map<string, Map<string, 'file' | 'directory' | 'symlink'>>();
  const directory = (path: string) => {
    if (directories.has(path)) return;
    directories.set(path, new Map());
    stats.set(path, { isFile: () => false, isDirectory: () => true, mode: 0o40755, mtimeMs: now - 100 * day });
    if (path !== '/') { directory(posix.dirname(path)); directories.get(posix.dirname(path))!.set(posix.basename(path), 'directory'); }
  };
  const file = (path: string, mtimeMs = now, symlink = false) => {
    directory(posix.dirname(path));
    directories.get(posix.dirname(path))!.set(posix.basename(path), symlink ? 'symlink' : 'file');
    stats.set(path, { isFile: () => true, isDirectory: () => false, mode: 0o100755, mtimeMs });
  };
  directory('/home/test'); directory('/home/test/.codex');
  for (const agent of options.installed ?? ['claude', 'codex']) file(`/bin/${agent}`);
  const fs = {
    stat: jest.fn(async (path: string) => { if (!stats.has(path)) throw missing; return stats.get(path); }),
    readdir: jest.fn(async (path: string) => {
      if (!directories.has(path)) throw missing;
      return [...directories.get(path)!].map(([name, type]) => ({ name, isFile: () => type === 'file', isDirectory: () => type === 'directory' }));
    }),
    readFile: jest.fn(async (path: string) => {
      // This is the only file content the plugin is allowed to read.
      const agent = /^\/home\/test\/\.config\/systemsculpt\/(claude|codex)\.json$/.exec(path)?.[1] as Agent | undefined;
      if (!agent) throw new Error(`Unexpected content read: ${path}`);
      if (!options.configs?.[agent]) throw missing;
      return JSON.stringify(options.configs[agent]);
    }),
  };
  const execFile = jest.fn((binary: string, _args: string[], _config: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const agent = posix.basename(binary).includes('claude') ? 'claude' : 'codex';
    if (agent === options.hang) return;
    const loggedIn = (options.signedIn ?? ['claude', 'codex']).includes(agent);
    const status = options.status?.[agent];
    queueMicrotask(() => callback(status?.error ?? null,
      status?.stdout ?? (agent === 'claude' ? JSON.stringify({ loggedIn, email: 'private@example.test' }) : ''),
      status?.stderr ?? (agent === 'codex' ? (loggedIn ? 'Logged in using ChatGPT' : 'Not logged in') : '')));
  });
  jest.mocked(desktopHost.fs).mockResolvedValue(fs as never);
  jest.mocked(desktopHost.path).mockResolvedValue(posix);
  jest.mocked(desktopHost.os).mockResolvedValue({ homedir: () => '/home/test', platform: () => 'darwin' } as never);
  jest.mocked(desktopHost.environment).mockReturnValue({ PATH: '/bin', ...options.environment });
  jest.mocked(desktopHost.childProcess).mockResolvedValue({ execFile } as never);
  return { fs, execFile, directory, file };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(hasHostCapability).mockReturnValue(true);
  invalidateLocalAgentDetection();
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it.each([
  { installed: [] as Agent[], signedIn: [] as Agent[], preferred: 'systemsculpt' },
  { installed: ['claude'] as Agent[], signedIn: ['claude'] as Agent[], preferred: 'claude' },
  { installed: ['codex'] as Agent[], signedIn: ['codex'] as Agent[], preferred: 'codex' },
  { installed: ['claude', 'codex'] as Agent[], signedIn: ['claude', 'codex'] as Agent[], preferred: 'claude' },
  { installed: ['claude', 'codex'] as Agent[], signedIn: [] as Agent[], preferred: 'systemsculpt' },
  { installed: ['claude', 'codex'] as Agent[], signedIn: ['codex'] as Agent[], preferred: 'codex' },
])('chooses a usable agent or hosted without any usage data (%j)', async options => {
  machine(options);
  const result = await detectLocalAgents();
  expect(result.preferred).toBe(options.preferred);
  for (const agent of ['claude', 'codex'] as const) expect(result.agents[agent]).toMatchObject({
    installed: options.installed.includes(agent), signedIn: options.signedIn.includes(agent), recentSessionCount: 0, lastUsed: null,
  });
  expect(JSON.stringify(result)).not.toContain('private@example.test');
});

it('ranks 30-day session counts before recency and inspects nested file mtimes, not parent mtimes', async () => {
  const host = machine();
  host.file('/home/test/.claude/projects/vault/a.jsonl', now - 2 * day);
  host.file('/home/test/.claude/projects/vault/b.jsonl', now - 3 * day);
  host.file('/home/test/.claude/projects/old-vault/old.jsonl', now - 40 * day);
  host.file('/home/test/.codex/sessions/2026/10/23/recent.jsonl', now - day);
  const result = await detectLocalAgents();
  expect(result.preferred).toBe('claude');
  expect(result.agents.claude).toMatchObject({ recentSessionCount: 2, lastUsed: now - 2 * day });
  expect(result.agents.codex).toMatchObject({ recentSessionCount: 1, lastUsed: now - day });
  host.file('/home/test/.codex/sessions/2026/10/23/second.jsonl', now);
  expect((await detectLocalAgents({ force: true })).preferred).toBe('codex');
  host.file('/home/test/.claude/projects/vault/b.jsonl', now);
  expect((await detectLocalAgents({ force: true })).preferred).toBe('claude');
});

it('ignores usage from signed-out or uninstalled agents', async () => {
  const host = machine({ signedIn: ['codex'] });
  host.file('/home/test/.claude/projects/vault/a.jsonl');
  expect((await detectLocalAgents()).preferred).toBe('codex');
  const absent = machine({ installed: ['codex'] });
  absent.file('/home/test/.claude/projects/vault/a.jsonl');
  expect((await detectLocalAgents({ force: true })).preferred).toBe('codex');
  expect(absent.execFile).toHaveBeenCalledTimes(1);
});

it('reads only launch config contents, lists primary sessions, and never follows symlink or subagent entries', async () => {
  const host = machine();
  host.file('/home/test/.claude/projects/vault/main.jsonl');
  host.file('/home/test/.claude/projects/vault/link.jsonl', now, true);
  host.file('/home/test/.claude/projects/vault/main/subagents/agent.jsonl');
  host.file('/home/test/.codex/sessions/2026/10/23/main.jsonl');
  host.file('/home/test/.codex/auth.json');
  const result = await detectLocalAgents();
  expect(result.agents.claude.recentSessionCount).toBe(1);
  expect(result.agents.codex.recentSessionCount).toBe(1);
  expect(host.fs.readFile.mock.calls.every(([path]) => /^\/home\/test\/\.config\/systemsculpt\/(claude|codex)\.json$/.test(path))).toBe(true);
  expect(host.fs.stat).not.toHaveBeenCalledWith('/home/test/.claude/projects/vault/link.jsonl');
  expect(host.fs.readdir).not.toHaveBeenCalledWith('/home/test/.claude/projects/vault/main/subagents', expect.anything());
});

it('uses the configured launch binary and the same effective native homes for auth and metadata', async () => {
  const host = machine({ environment: { CLAUDE_CONFIG_DIR: '/custom/claude', CODEX_HOME: '/custom/codex', CLAUDECODE: '1' }, configs: { claude: { binary: '~/tools/claude' } } });
  host.file('/home/test/tools/claude');
  host.file('/custom/claude/projects/vault/main.jsonl');
  host.file('/custom/codex/sessions/2026/10/23/main.jsonl');
  const result = await detectLocalAgents();
  expect(result.agents.claude.recentSessionCount).toBe(1);
  expect(result.agents.codex.recentSessionCount).toBe(1);
  expect(host.execFile).toHaveBeenCalledWith('/home/test/tools/claude', ['auth', 'status', '--json'], expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/custom/claude' }), timeout: 3000 }), expect.any(Function));
  expect(host.execFile).toHaveBeenCalledWith('/bin/codex', ['login', 'status'], expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/custom/codex' }), timeout: 3000 }), expect.any(Function));
  expect(host.execFile.mock.calls.every(([, , config]) => !('CLAUDECODE' in (config as { env: object }).env))).toBe(true);
});

it('gives an explicit machine-local Codex home precedence over CODEX_HOME', async () => {
  const host = machine({ environment: { CODEX_HOME: '/inherited/codex' }, configs: { codex: { home: '~/chosen-codex' } } });
  host.file('/home/test/chosen-codex/sessions/2026/10/23/main.jsonl');
  expect((await detectLocalAgents()).agents.codex.recentSessionCount).toBe(1);
  expect(host.execFile).toHaveBeenCalledWith('/bin/codex', ['login', 'status'], expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/home/test/chosen-codex' }) }), expect.any(Function));
});

it('resolves relative Claude binaries and status in the task directory without reusing another vault cache', async () => {
  const host = machine({ configs: { claude: { binary: './tools/claude' } }, signedIn: ['claude'] });
  host.file('/vault-a/tools/claude');
  host.file('/bin/tools/claude'); // PATH must not satisfy an explicitly relative path.
  const first = detectLocalAgents({ workingDirectory: '/vault-a' });
  expect(detectLocalAgents({ workingDirectory: '/vault-a' })).toBe(first);
  expect((await first).preferred).toBe('claude');
  expect((await detectLocalAgents({ workingDirectory: '/vault-b' })).preferred).toBe('systemsculpt');
  expect((await detectLocalAgents()).agents.claude.installed).toBe(false);
  expect(host.execFile).toHaveBeenCalledWith('/vault-a/tools/claude', ['auth', 'status', '--json'], expect.objectContaining({ cwd: '/vault-a' }), expect.any(Function));
});

it('resolves a relative Codex binary from transport home rather than the vault', async () => {
  const host = machine({ configs: { codex: { binary: './tools/codex' } } });
  host.file('/home/test/tools/codex');
  expect((await detectLocalAgents({ workingDirectory: '/vault' })).agents.codex.signedIn).toBe(true);
  expect(host.execFile).toHaveBeenCalledWith('/home/test/tools/codex', ['login', 'status'], expect.objectContaining({ cwd: '/home/test' }), expect.any(Function));
});

it('visits dated Codex directories newest-first and stops before listing older history', async () => {
  const host = machine();
  // Deliberately create directories out of chronological order.
  host.file('/home/test/.codex/sessions/2020/01/01/oldest.jsonl', now - 100 * day);
  host.file('/home/test/.codex/sessions/2026/08/01/old.jsonl', now - 80 * day);
  host.file('/home/test/.codex/sessions/2026/09/01/older.jsonl', now - 50 * day);
  host.file('/home/test/.codex/sessions/2026/09/20/newest-old.jsonl', now - 33 * day);
  host.file('/home/test/.codex/sessions/2026/10/23/recent.jsonl', now);
  const result = await detectLocalAgents();
  expect(result.agents.codex).toMatchObject({ recentSessionCount: 1, lastUsed: now });
  const paths = host.fs.readdir.mock.calls.map(([path]) => path);
  expect(paths.indexOf('/home/test/.codex/sessions/2026/10/23')).toBeLessThan(paths.indexOf('/home/test/.codex/sessions/2026/09/20'));
  expect(paths).not.toContain('/home/test/.codex/sessions/2026/09/01');
  expect(paths).not.toContain('/home/test/.codex/sessions/2026/08');
  expect(paths).not.toContain('/home/test/.codex/sessions/2020');
});

it('retains installed status when the native home is missing and does not run its auth command', async () => {
  const host = machine({ environment: { CODEX_HOME: '/missing/codex' } });
  expect((await detectLocalAgents()).agents.codex).toMatchObject({ installed: true, signedIn: false });
  expect(host.execFile).toHaveBeenCalledTimes(1);
});

it.each([
  { claude: { stdout: 'not JSON' }, codex: { stderr: 'Not logged in' } },
  { claude: { error: new Error('failed'), stdout: '{"loggedIn":true}' }, codex: { error: new Error('failed'), stderr: 'Logged in using ChatGPT' } },
])('requires successful exit and a positive native auth status (%j)', async status => {
  machine({ status });
  expect((await detectLocalAgents()).preferred).toBe('systemsculpt');
});

it('caches results and concurrent probes until invalidated or explicitly detected again', async () => {
  const host = machine();
  const first = detectLocalAgents();
  expect(detectLocalAgents()).toBe(first);
  await first; await detectLocalAgents();
  expect(host.execFile).toHaveBeenCalledTimes(2);
  await detectLocalAgents({ force: true });
  expect(host.execFile).toHaveBeenCalledTimes(4);
  invalidateLocalAgentDetection(); await detectLocalAgents();
  expect(host.execFile).toHaveBeenCalledTimes(6);
});

it.each(['claude', 'codex'] as const)('keeps hung %s status unknown without hiding the other usable agent', async agent => {
  jest.useFakeTimers();
  const host = machine({ hang: agent });
  const result = detectLocalAgents();
  await jest.advanceTimersByTimeAsync(3000);
  expect((await result).preferred).toBe(agent === 'claude' ? 'codex' : 'claude');
  expect((await result).agents[agent]).toMatchObject({ installed: true, signedIn: null });
  // The initial result remains available while only the unknown agent is retried.
  expect(detectLocalAgents()).toBe(result);
  expect(host.execFile).toHaveBeenCalledTimes(3);
  await jest.advanceTimersByTimeAsync(3000);
  expect((await detectLocalAgents()).agents[agent].signedIn).toBeNull();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(host.execFile).toHaveBeenCalledTimes(3);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([
  ['claude', '/home/test/.claude/projects/vault/main.jsonl'],
  ['codex', '/home/test/.codex/sessions/2026/10/23/main.jsonl'],
] as const)('uses recent sessions for hung %s status, but not old or missing sessions', async (agent, session) => {
  jest.useFakeTimers();
  const host = machine({ installed: [agent], hang: agent });
  for (const age of [null, 40 * day, day]) {
    if (age !== null) host.file(session, now - age);
    const result = detectLocalAgents({ force: true });
    await jest.advanceTimersByTimeAsync(3000);
    expect((await result).agents[agent].signedIn).toBeNull();
    expect((await result).preferred).toBe(age === day ? agent : 'systemsculpt');
    await jest.advanceTimersByTimeAsync(3000);
    expect((await detectLocalAgents()).preferred).toBe(age === day ? agent : 'systemsculpt');
    expect(jest.getTimerCount()).toBe(0);
  }
  expect(host.execFile).toHaveBeenCalledTimes(6);
});

it.each(['claude', 'codex'] as const)('updates cached %s status after one background retry succeeds', async agent => {
  jest.useFakeTimers();
  const host = machine({ installed: [agent] });
  host.execFile.mockImplementationOnce(() => undefined);
  const result = detectLocalAgents();
  await jest.advanceTimersByTimeAsync(3000);
  expect((await result).agents[agent].signedIn).toBeNull();
  await jest.advanceTimersByTimeAsync(0);
  expect((await detectLocalAgents()).agents[agent].signedIn).toBe(true);
  expect((await detectLocalAgents()).preferred).toBe(agent);
  expect(host.execFile).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

it('replaces recent-session inference with an explicit signed-out result from the retry', async () => {
  jest.useFakeTimers();
  const host = machine({ installed: ['claude'], signedIn: [] });
  host.file('/home/test/.claude/projects/vault/main.jsonl');
  host.execFile.mockImplementationOnce(() => undefined);
  const result = detectLocalAgents();
  await jest.advanceTimersByTimeAsync(3000);
  expect((await result).preferred).toBe('claude');
  await jest.advanceTimersByTimeAsync(0);
  expect((await detectLocalAgents()).agents.claude.signedIn).toBe(false);
  expect((await detectLocalAgents()).preferred).toBe('systemsculpt');
  expect(host.execFile).toHaveBeenCalledTimes(2);
});

it('does not let an invalidated background retry overwrite Detect again', async () => {
  jest.useFakeTimers();
  const host = machine({ installed: ['claude'], hang: 'claude' });
  const first = detectLocalAgents();
  await jest.advanceTimersByTimeAsync(3000);
  expect((await first).agents.claude.signedIn).toBeNull();
  const retryCallback = host.execFile.mock.calls[1][3];
  host.execFile.mockImplementation((_binary, _args, _config, callback) => { callback(null, '{"loggedIn":true}', ''); });
  const refreshed = detectLocalAgents({ force: true });
  expect((await refreshed).preferred).toBe('claude');
  retryCallback(null, '{"loggedIn":false}', '');
  await jest.advanceTimersByTimeAsync(3000);
  expect(detectLocalAgents()).toBe(refreshed);
  expect((await detectLocalAgents()).preferred).toBe('claude');
  expect(jest.getTimerCount()).toBe(0);
});

it.each([DEFAULT_SETTINGS, migrateSettingsToCurrentSchema({ schemaVersion: 14, textExecutionBackend: 'systemsculpt' }, DEFAULT_SETTINGS).settings])('defaults a fresh or migrated desktop chat to an installed recently used agent despite slow auth', async settings => {
  jest.useFakeTimers();
  const host = machine({ installed: ['claude'], hang: 'claude' });
  host.file('/home/test/.claude/projects/vault/main.jsonl');
  const balance = jest.fn();
  const backend = resolveDefaultChatBackend(settings, balance);
  await jest.advanceTimersByTimeAsync(3000);
  expect(await backend).toBe('claude');
  expect(balance).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(3000);
});

it('notifies only current directory subscribers after retry and respects unsubscribe', async () => {
  jest.useFakeTimers();
  const host = machine({ installed: ['claude'], hang: 'claude' });
  const current = jest.fn(), other = jest.fn(), removed = jest.fn();
  const stopCurrent = subscribeLocalAgentDetection('/vault', current);
  const stopOther = subscribeLocalAgentDetection('/other', other);
  const stopRemoved = subscribeLocalAgentDetection('/vault', removed);
  try {
    const initial = detectLocalAgents({ workingDirectory: '/vault' });
    await jest.advanceTimersByTimeAsync(3000);
    expect((await initial).agents.claude.signedIn).toBeNull();
    expect(current).not.toHaveBeenCalled();
    stopRemoved();
    host.execFile.mock.calls[1][3](null, '{"loggedIn":true}', '');
    await jest.advanceTimersByTimeAsync(0);
    expect(current).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledWith(await detectLocalAgents({ workingDirectory: '/vault' }));
    expect(other).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally { stopCurrent(); stopOther(); stopRemoved(); }
});

it('counts launch lookup time in each original 3-second window and aborts both hung status processes', async () => {
  jest.useFakeTimers();
  jest.spyOn(Date, 'now').mockRestore();
  jest.setSystemTime(now);
  const host = machine({ installed: ['claude'], hang: 'claude' });
  const read = host.fs.readFile.getMockImplementation()!;
  host.fs.readFile.mockImplementation(async path => {
    await new Promise(resolve => window.setTimeout(resolve, 1000));
    return read(path);
  });
  let finished = false;
  const initial = detectLocalAgents().then(result => { finished = true; return result; });
  await jest.advanceTimersByTimeAsync(2999);
  expect(finished).toBe(false);
  expect(host.execFile).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect((await initial).agents.claude.signedIn).toBeNull();
  expect((host.execFile.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(3000);
  expect(host.execFile).toHaveBeenCalledTimes(2);
  expect((host.execFile.mock.calls[1][2] as { signal: AbortSignal }).signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

it('does not block authenticated status on a stalled filesystem metadata probe', async () => {
  jest.useFakeTimers();
  const host = machine({ installed: ['claude'] });
  host.fs.readdir.mockImplementation(() => new Promise(() => {}));
  const result = detectLocalAgents();
  await jest.advanceTimersByTimeAsync(3000);
  expect((await result).preferred).toBe('claude');
});

it.each([
  '/home/test/.nvm/versions/node/v22.18.0/bin', '/home/test/.volta/bin', '/home/test/.claude/local',
])('detects and probes GUI-hidden agents in %s with node on the child PATH', async folder => {
  const host = machine({ installed: [], environment: { PATH: '/usr/bin' } });
  for (const name of ['claude', 'codex', 'node']) host.file(`${folder}/${name}`);
  const result = await detectLocalAgents();
  for (const agent of ['claude', 'codex'] as const) {
    expect(result.agents[agent]).toMatchObject({ installed: true, signedIn: true });
    expect(host.execFile).toHaveBeenCalledWith(`${folder}/${agent}`, expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ PATH: expect.stringContaining(folder) }), timeout: 3000 }), expect.any(Function));
  }
  expect(host.fs.readFile.mock.calls.every(([path]) => path.startsWith('/home/test/.config/systemsculpt/'))).toBe(true);
});

it('keeps the existing detection deadline when install-directory enumeration stalls', async () => {
  jest.useFakeTimers();
  const host = machine({ installed: [] });
  host.fs.readdir.mockImplementation(() => new Promise(() => {}));
  const result = detectLocalAgents();
  await jest.advanceTimersByTimeAsync(3000);
  expect((await result).preferred).toBe('systemsculpt');
  expect(host.execFile).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('probes Windows npm agents without a shell and keeps native credential homes and the deadline', async () => {
  const { execFile } = machine(), windows = windowsNpmHost();
  execFile.mockImplementation((_binary, args, _options, callback) => {
    queueMicrotask(() => callback(null, args[0] === windows.scripts.claude ? '{"loggedIn":true}' : '', args[0] === windows.scripts.codex ? 'Logged in using ChatGPT' : ''));
  });
  const result = await detectLocalAgents({ workingDirectory: windows.cwd });
  for (const agent of ['claude', 'codex'] as const) {
    expect(result.agents[agent]).toMatchObject({ installed: true, signedIn: true });
    expect(execFile).toHaveBeenCalledWith(windows.node, [windows.scripts[agent], ...(agent === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'])],
      expect.objectContaining({ shell: false, timeout: 3000, killSignal: 'SIGKILL', cwd: agent === 'claude' ? windows.cwd : windows.home,
        env: expect.objectContaining({ CODEX_HOME: windows.environment.CODEX_HOME, CLAUDE_CONFIG_DIR: windows.environment.CLAUDE_CONFIG_DIR }) }), expect.any(Function));
  }
});

it('does not spawn a late Windows status process after shim I/O exceeds the existing deadline', async () => {
  jest.useFakeTimers();
  const { execFile } = machine(), windows = windowsNpmHost(), read = windows.fs.readFile.getMockImplementation()!;
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  windows.fs.readFile.mockImplementation(async file => { if (/\.cmd$/i.test(file)) await stalled; return read(file); });
  const result = detectLocalAgents({ workingDirectory: windows.cwd });
  await jest.advanceTimersByTimeAsync(3000);
  expect((await result).preferred).toBe('systemsculpt');
  // Both attempts retain the original deadline, including shim resolution.
  await jest.advanceTimersByTimeAsync(3000);
  release();
  await jest.advanceTimersByTimeAsync(0);
  expect(execFile).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('leaves mobile on hosted without loading filesystem or child-process adapters', async () => {
  jest.mocked(hasHostCapability).mockReturnValue(false);
  expect((await detectLocalAgents({ force: true })).preferred).toBe('systemsculpt');
  expect(desktopHost.fs).not.toHaveBeenCalled();
  expect(desktopHost.childProcess).not.toHaveBeenCalled();
});
