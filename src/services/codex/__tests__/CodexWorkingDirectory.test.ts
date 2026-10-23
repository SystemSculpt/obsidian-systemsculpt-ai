import { posix, win32 } from 'node:path';
import { codexWorkingDirectory, localAgentChatDirectory } from '../CodexExecutionSettings';
import { desktopHost } from '../../../platform/desktopOnly';
import { hasHostCapability } from '../../../platform/hostCapabilities';
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { fs: jest.fn() } }));

it('canonicalizes only the current vault root for native chat, leaving Studio paths unchanged', async () => {
  const root = '/tmp/t136-qa/vault', canonical = '/private/tmp/t136-qa/vault';
  const app = { vault: { adapter: { getFullPath: (path: string) => posix.resolve(root, path) } } };
  const realpath = jest.fn(async () => canonical);
  (desktopHost.fs as jest.Mock).mockResolvedValue({ realpath });

  await expect(localAgentChatDirectory(app as never)).resolves.toBe(canonical);
  expect(realpath.mock.calls).toEqual([[root]]);
  expect(codexWorkingDirectory(app as never, '.')).toBe(root);
  expect(codexWorkingDirectory(app as never, '/external/repository')).toBe('/external/repository');
  expect(realpath).toHaveBeenCalledTimes(1);
});

it('does not launch chat with an unverified root when canonical metadata fails', async () => {
  const app = { vault: { adapter: { getFullPath: () => '/tmp/vault' } } };
  const realpath = jest.fn().mockRejectedValue(new Error('Root unavailable'));
  (desktopHost.fs as jest.Mock).mockResolvedValue({ realpath });
  await expect(localAgentChatDirectory(app as never)).rejects.toThrow('Root unavailable');
  expect(realpath.mock.calls).toEqual([['/tmp/vault']]);
});

it.each(['/Users/owner/main-vault', '/Volumes/Work/Obsidian Vault'])('resolves the same saved task relative to the current vault %s', root => {
  const app = { vault: { adapter: { getFullPath: (path: string) => posix.resolve(root, path) } } };
  const saved = 'SystemSculpt/Studio/Benchmarks/Blaxel Benchmarks.studio';
  expect(codexWorkingDirectory(app as never, saved)).toBe(`${root}/${saved}`);
  expect(codexWorkingDirectory(app as never, '.')).toBe(root);
  expect(codexWorkingDirectory(app as never, '')).toBe(root);
  expect(codexWorkingDirectory(app as never, '/external/repository')).toBe('/external/repository');
});

it('uses the current Windows vault adapter for portable paths', () => {
  const app = { vault: { adapter: { getFullPath: (path: string) => win32.resolve('D:\\Notes', path) } } };
  expect(codexWorkingDirectory(app as never, 'Studio/Benchmarks.studio')).toBe('D:\\Notes\\Studio\\Benchmarks.studio');
  expect(codexWorkingDirectory(app as never, 'C:\\Repos\\external')).toBe('C:\\Repos\\external');
});

it('does not try to resolve local execution on mobile', () => {
  (hasHostCapability as jest.Mock).mockReturnValueOnce(false);
  expect(() => codexWorkingDirectory({} as never, '.')).toThrow('Obsidian Desktop');
});
