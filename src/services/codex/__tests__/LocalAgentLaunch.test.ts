import { posix, win32 } from 'node:path';
import { readLocalAgentLaunchConfig, resolveLocalAgentBinary } from '../LocalAgentLaunch';
import type { LocalAgentId } from '../LocalAgents';
import { desktopHost } from '../../../platform/desktopOnly';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn() } }));

/** Found means a binary resolved; a launch-settings failure counts as not found. */
const isLocalAgentInstalled = (agent: LocalAgentId) => resolveLocalAgentBinary(agent).then(binary => binary !== null, () => false);

const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
const executable = { isFile: () => true, mode: 0o100755 };

/** A machine whose files are `files` (path → stat) and whose launch settings are `configs` (agent → JSON text). */
function machine(files: Record<string, unknown>, configs: Record<string, string> = {}, platform = 'darwin') {
  const windows = platform === 'win32', paths = windows ? win32 : posix;
  (desktopHost.fs as jest.Mock).mockResolvedValue({
    readdir: jest.fn(async (directory: string) => [...new Set(Object.keys(files)
      .filter(file => file.startsWith(directory + paths.sep))
      .map(file => file.slice(directory.length + 1).split(paths.sep)[0]))]
      .map(name => ({ name, isDirectory: () => !(paths.join(directory, name) in files) }))),
    stat: jest.fn(async (path: string) => { if (path in files) return files[path]; throw missing; }),
    readFile: jest.fn(async (path: string) => {
      const agent = /([a-z]+)\.json$/.exec(path)?.[1];
      if (agent && agent in configs) return configs[agent];
      throw missing;
    }),
  });
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => windows ? 'C:\\Users\\test' : '/home/test', platform: () => platform });
  (desktopHost.path as jest.Mock).mockResolvedValue(paths);
  (desktopHost.environment as jest.Mock).mockReturnValue(windows
    ? { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }
    : { PATH: '/usr/bin' });
}

it('finds an agent on PATH or in the folders CLI installers use', async () => {
  machine({ '/home/test/.local/bin/claude': executable });
  await expect(isLocalAgentInstalled('claude')).resolves.toBe(true);
  await expect(isLocalAgentInstalled('codex')).resolves.toBe(false);
});

it('ignores folders and files that are not executable', async () => {
  machine({ '/usr/bin/claude': { isFile: () => false, mode: 0o40755 }, '/opt/homebrew/bin/codex': { isFile: () => true, mode: 0o100644 } });
  await expect(isLocalAgentInstalled('claude')).resolves.toBe(false);
  await expect(isLocalAgentInstalled('codex')).resolves.toBe(false);
});

it('follows a binary set in the machine-local launch settings', async () => {
  machine({ '/home/test/tools/claude-cli': executable }, { claude: JSON.stringify({ binary: '~/tools/claude-cli' }) });
  await expect(isLocalAgentInstalled('claude')).resolves.toBe(true);
  machine({}, { claude: '{not json' });
  await expect(isLocalAgentInstalled('claude')).resolves.toBe(false);
});

it('resolves Windows command extensions', async () => {
  machine({ 'C:\\Tools\\codex.CMD': { isFile: () => true, mode: 0o100666 } }, {}, 'win32');
  await expect(isLocalAgentInstalled('codex')).resolves.toBe(true);
});

it.each(['./tools/claude', 'tools/claude'])('resolves a relative configured binary from the same cwd as execution (%s)', async binary => {
  machine({ '/vault/tools/claude': executable, '/usr/bin/tools/claude': executable }, { claude: JSON.stringify({ binary }) });
  await expect(resolveLocalAgentBinary('claude', undefined, '/vault')).resolves.toBe('/vault/tools/claude');
  await expect(resolveLocalAgentBinary('claude')).resolves.toBeNull();
});

it('resolves relative Windows binary paths and command extensions from the task directory', async () => {
  machine({ 'C:\\Vault\\tools\\claude.CMD': executable }, { claude: JSON.stringify({ binary: '.\\tools\\claude' }) }, 'win32');
  await expect(resolveLocalAgentBinary('claude', undefined, 'C:\\Vault')).resolves.toBe('C:\\Vault\\tools\\claude.CMD');
});

it('resolves relative PATH entries in the task directory', async () => {
  machine({ '/vault/tools/claude': executable });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: 'tools' });
  await expect(resolveLocalAgentBinary('claude', undefined, '/vault')).resolves.toBe('/vault/tools/claude');
  await expect(resolveLocalAgentBinary('claude')).resolves.toBeNull();
});

it('returns the concrete binary path used by the status probe', async () => {
  machine({ '/home/test/.local/bin/claude': executable });
  await expect(resolveLocalAgentBinary('claude')).resolves.toBe('/home/test/.local/bin/claude');
});

it.each([
  ['darwin', '/home/test/.nvm/versions/node/v22.18.0/bin'],
  ['linux', '/home/test/.nvm/versions/node/v24.10.0/bin'],
  ['darwin', '/home/test/.volta/bin'],
  ['linux', '/home/test/.asdf/shims'],
  ['darwin', '/home/test/Library/Application Support/fnm/node-versions/v24.10.0/installation/bin'],
  ['linux', '/home/test/.local/share/fnm/node-versions/v22.18.0/installation/bin'],
  ['linux', '/home/test/.fnm/aliases/default/bin'],
  ['darwin', '/home/test/.bun/bin'],
  ['darwin', '/home/test/Library/pnpm'],
  ['linux', '/home/test/.local/share/pnpm'],
  ['darwin', '/home/test/.claude/local'],
  ['win32', 'C:\\Users\\test\\AppData\\Roaming\\npm'],
  ['win32', 'C:\\Users\\test\\AppData\\Local\\Volta\\bin'],
  ['win32', 'C:\\Users\\test\\AppData\\Local\\pnpm'],
  ['win32', 'C:\\Users\\test\\AppData\\Roaming\\fnm\\node-versions\\v24.10.0\\installation'],
])('finds both agents with only a GUI PATH on %s in %s', async (platform, folder) => {
  const paths = platform === 'win32' ? win32 : posix, suffix = platform === 'win32' ? '.EXE' : '';
  machine(Object.fromEntries(['claude', 'codex', 'node'].map(name => [paths.join(folder, name + suffix), executable])), {}, platform);
  const launch = await readLocalAgentLaunchConfig('claude', 'Claude Code');
  for (const agent of ['claude', 'codex'] as const) {
    await expect(resolveLocalAgentBinary(agent, launch)).resolves.toBe(paths.join(folder, agent + suffix));
  }
  expect(launch.environment.PATH!.split(paths.delimiter)).toContain(folder);
});

it('selects the newest nvm version numerically, ignoring unrelated entries', async () => {
  const root = '/home/test/.nvm/versions/node';
  machine(Object.fromEntries(['v9.9.9', 'v22.9.0', 'v22.18.0', 'unrelated'].flatMap(version =>
    ['claude', 'node'].map(name => [`${root}/${version}/bin/${name}`, executable]))));
  const launch = await readLocalAgentLaunchConfig('claude', 'Claude Code');
  await expect(resolveLocalAgentBinary('claude', launch)).resolves.toBe(`${root}/v22.18.0/bin/claude`);
  expect(launch.environment.PATH).not.toContain('v9.9.9');
});

it.each(['environment', 'current symlink'])('prefers the active nvm runtime (%s) over the newest', async active => {
  const root = '/home/test/.nvm', folder = active === 'environment' ? `${root}/versions/node/v20.19.0/bin` : `${root}/current/bin`;
  machine({ [`${folder}/node`]: executable, [`${folder}/claude`]: executable,
    [`${root}/versions/node/v24.10.0/bin/node`]: executable, [`${root}/versions/node/v24.10.0/bin/claude`]: executable });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/usr/bin', ...(active === 'environment' ? { NVM_BIN: folder } : {}) });
  await expect(resolveLocalAgentBinary('claude')).resolves.toBe(`${folder}/claude`);
});

it.each([
  ['NVM_DIR', '/custom/nvm', '/custom/nvm/versions/node/v24.10.0/bin'],
  ['VOLTA_HOME', '/custom/volta', '/custom/volta/bin'],
  ['ASDF_DATA_DIR', '/custom/asdf', '/custom/asdf/shims'],
  ['FNM_DIR', '/custom/fnm', '/custom/fnm/node-versions/v24.10.0/installation/bin'],
  ['BUN_INSTALL', '/custom/bun', '/custom/bun/bin'],
  ['PNPM_HOME', '/custom/pnpm', '/custom/pnpm'],
  ['XDG_DATA_HOME', '/custom/data', '/custom/data/fnm/node-versions/v24.10.0/installation/bin'],
])('honors %s without needing machine-local launch settings', async (key, value, folder) => {
  machine({ [`${folder}/claude`]: executable, [`${folder}/node`]: executable }, {}, 'linux');
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/usr/bin', [key]: value });
  await expect(resolveLocalAgentBinary('claude')).resolves.toBe(`${folder}/claude`);
});

it('preserves inherited PATH precedence and does not mutate the host environment', async () => {
  machine({ '/tools/claude': executable, '/home/test/.volta/bin/claude': executable });
  const environment = { PATH: '/tools:/usr/bin:/tools' };
  (desktopHost.environment as jest.Mock).mockReturnValue(environment);
  const launch = await readLocalAgentLaunchConfig('claude', 'Claude Code');
  await expect(resolveLocalAgentBinary('claude', launch)).resolves.toBe('/tools/claude');
  expect(launch.environment.PATH!.split(':').filter(folder => folder === '/tools')).toHaveLength(1);
  expect(environment.PATH).toBe('/tools:/usr/bin:/tools');
});

it('normalizes Windows Path casing and honors redirected APPDATA', async () => {
  machine({ 'D:\\Roaming\\npm\\codex.CMD': executable }, {}, 'win32');
  (desktopHost.environment as jest.Mock).mockReturnValue({ Path: 'C:\\Windows\\System32', APPDATA: 'D:\\Roaming', PATHEXT: '.EXE;.CMD' });
  const launch = await readLocalAgentLaunchConfig('codex', 'Codex');
  await expect(resolveLocalAgentBinary('codex', launch)).resolves.toBe('D:\\Roaming\\npm\\codex.CMD');
  expect(launch.environment.PATH!.split(';')[0]).toBe('C:\\Windows\\System32');
  expect(launch.environment.Path).toBeUndefined();
});

it('includes the separate Windows Node installation for npm scripts', async () => {
  const files = { 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.CMD': executable, 'C:\\Program Files\\nodejs\\node.exe': executable };
  machine(files, {}, 'win32');
  (desktopHost.environment as jest.Mock).mockReturnValue({ Path: 'C:\\Windows\\System32' });
  const launch = await readLocalAgentLaunchConfig('codex', 'Codex');
  await expect(resolveLocalAgentBinary('codex', launch)).resolves.toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\codex.CMD');
  expect(launch.environment.PATH!.split(';').map(folder => win32.join(folder, 'node.exe')).find(file => file in files)).toBe('C:\\Program Files\\nodejs\\node.exe');
});

it('does not enumerate optional install directories for an already-resolvable binary', async () => {
  machine({ '/usr/bin/claude': executable });
  const fs = await desktopHost.fs();
  jest.mocked(fs.readdir).mockImplementation(() => new Promise(() => {}));
  await expect(resolveLocalAgentBinary('claude')).resolves.toBe('/usr/bin/claude');
  expect(fs.readdir).not.toHaveBeenCalled();
});

it('tolerates missing or inaccessible version-manager directories', async () => {
  machine({ '/home/test/.volta/bin/claude': executable });
  const fs = await desktopHost.fs();
  jest.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(resolveLocalAgentBinary('claude')).resolves.toBe('/home/test/.volta/bin/claude');
});
