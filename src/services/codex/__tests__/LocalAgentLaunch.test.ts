import { isLocalAgentInstalled, resolveLocalAgentBinary } from '../LocalAgentLaunch';
import { desktopHost } from '../../../platform/desktopOnly';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn() } }));

const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
const executable = { isFile: () => true, mode: 0o100755 };

/** A machine whose files are `files` (path → stat) and whose launch settings are `configs` (agent → JSON text). */
function machine(files: Record<string, unknown>, configs: Record<string, string> = {}, platform = 'darwin') {
  const windows = platform === 'win32';
  (desktopHost.fs as jest.Mock).mockResolvedValue({
    stat: jest.fn(async (path: string) => { if (path in files) return files[path]; throw missing; }),
    readFile: jest.fn(async (path: string) => {
      const agent = /([a-z]+)\.json$/.exec(path)?.[1];
      if (agent && agent in configs) return configs[agent];
      throw missing;
    }),
  });
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => '/home/test', platform: () => platform });
  (desktopHost.path as jest.Mock).mockResolvedValue({
    isAbsolute: (path: string) => windows ? /^[A-Z]:\\/.test(path) : path.startsWith('/'),
    delimiter: windows ? ';' : ':',
    join: (...parts: string[]) => parts.join(windows ? '\\' : '/'),
  });
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

it('returns the concrete binary path used by the status probe', async () => {
  machine({ '/home/test/.local/bin/claude': executable });
  await expect(resolveLocalAgentBinary('claude')).resolves.toBe('/home/test/.local/bin/claude');
});
