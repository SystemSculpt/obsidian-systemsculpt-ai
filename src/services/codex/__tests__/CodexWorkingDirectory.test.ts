import { posix, win32 } from 'node:path';
import { codexWorkingDirectory } from '../CodexExecutionSettings';
import { hasHostCapability } from '../../../platform/hostCapabilities';
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));

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
