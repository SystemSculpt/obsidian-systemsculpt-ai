import { posix, win32 } from 'node:path';
import { desktopHost } from '../../../platform/desktopOnly';
import { resolveLocalAgentCommand } from '../LocalAgentLaunch';
import { npmNativeShim, npmNodeShim } from './fixtures/npmNodeShim';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { fs: jest.fn(), os: jest.fn(), path: jest.fn() } }));

const folder = 'C:\\Users\\A & B\\AppData\\Roaming\\npm';
const binary = win32.join(folder, 'claude.cmd');
const target = 'node_modules\\@anthropic-ai\\claude-code\\cli.js';
const node = 'C:\\Program Files\\nodejs\\node.exe';
const environment = { PATH: `C:\\Windows\\System32;${folder};${win32.dirname(node)}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', CODEX_HOME: 'C:\\native home' };
const args = ['-p', '', 'a "quote" \\', '& echo injected', '%PATH%', '!VAR!', 'a\nb', 'a^b|c>d<e', '(test)'];

function host(files: Record<string, string> = {}) {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fs = {
    stat: jest.fn(async (file: string) => { if (!(file.toLowerCase() in files)) throw missing; return { isFile: () => true }; }),
    readFile: jest.fn(async (file: string) => { const content = files[file.toLowerCase()]; if (content === undefined) throw missing; return content; }),
  };
  jest.mocked(desktopHost.fs).mockResolvedValue(fs as never);
  jest.mocked(desktopHost.os).mockResolvedValue({ platform: () => 'win32' } as never);
  jest.mocked(desktopHost.path).mockResolvedValue(win32);
  return fs;
}
function installation(extra: Record<string, string> = {}) {
  return host(Object.fromEntries(Object.entries({ [binary]: npmNodeShim(target), [win32.join(folder, target)]: 'script', [node]: 'exe', ...extra }).map(([key, value]) => [key.toLowerCase(), value])));
}

it('launches the npm script with Node and literal argv, not a shell or the extensionless sh companion', async () => {
  const fs = installation({ [win32.join(folder, 'claude')]: '#!/bin/sh' });
  await expect(resolveLocalAgentCommand('claude', args, environment, 'C:\\vault')).resolves.toEqual({ binary: node, args: [win32.join(folder, target), ...args] });
  expect(fs.readFile).toHaveBeenCalledTimes(1);
  expect(fs.readFile).toHaveBeenCalledWith(expect.stringMatching(/claude\.cmd$/i), 'utf8');
  expect(environment.CODEX_HOME).toBe('C:\\native home');
});

it('uses a colocated node.exe before PATH and supports explicitly configured mixed-case CMD paths', async () => {
  installation({ [win32.join(folder, 'node.exe')]: 'exe' });
  await expect(resolveLocalAgentCommand(binary.toUpperCase(), args, environment, 'C:\\vault')).resolves.toEqual({ binary: win32.join(folder.toUpperCase(), 'node.exe'), args: [win32.join(folder.toUpperCase(), target), ...args] });
});

it('launches the standard no-shebang npm shim used by current native Claude installs without needing Node', async () => {
  const native = 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  host({ [binary.toLowerCase()]: npmNativeShim(native), [win32.join(folder, native).toLowerCase()]: 'native exe' });
  await expect(resolveLocalAgentCommand(binary, args, environment, 'C:\\vault')).resolves.toEqual({ binary: win32.join(folder, native), args });
});

it('resolves a relative configured shim from the caller cwd', async () => {
  installation();
  await expect(resolveLocalAgentCommand('.\\claude.cmd', args, environment, folder)).resolves.toEqual({ binary: node, args: [win32.join(folder, target), ...args] });
});

it('never reads a missing relative shim against the host process cwd', async () => {
  const fs = host({ '.\\tools\\claude.cmd': npmNodeShim(target) });
  const command = '.\\tools\\claude.cmd';
  await expect(resolveLocalAgentCommand(command, args, environment, 'D:\\vault')).resolves.toEqual({ binary: command, args });
  expect(fs.readFile).not.toHaveBeenCalled();
});

it.each(['win32', 'darwin', 'linux'])('keeps native executables and argv unchanged on %s', async platform => {
  const fs = installation();
  jest.mocked(desktopHost.os).mockResolvedValue({ platform: () => platform } as never);
  if (platform !== 'win32') jest.mocked(desktopHost.path).mockResolvedValue(posix);
  const executable = platform === 'win32' ? 'C:\\native & agent.exe' : '/bin/claude';
  await expect(resolveLocalAgentCommand(executable, args, environment, 'C:\\vault')).resolves.toEqual({ binary: executable, args });
  expect(fs.readFile).not.toHaveBeenCalled();
});

it.each([
  '@echo off\r\nnode custom.js %*',
  npmNodeShim(target) + '\r\necho extra',
  npmNodeShim(target).replace('SET "_prog=node"', 'SET "_prog=powershell"'),
  npmNodeShim(target).replace('"%_prog%"  ', '"%_prog%" --require custom.js '),
  npmNodeShim(target).replace('SETLOCAL', 'SETLOCAL\r\nSET NODE_OPTIONS=--require custom.js'),
])('does not reinterpret an unknown or customized batch wrapper', async source => {
  installation({ [binary]: source });
  await expect(resolveLocalAgentCommand(binary, args, environment, 'C:\\vault')).rejects.toThrow(/npm CLI shim/);
});

it('fails clearly if the npm target or Node runtime is missing', async () => {
  host({ [binary.toLowerCase()]: npmNodeShim(target) });
  await expect(resolveLocalAgentCommand(binary, args, environment, 'C:\\vault')).rejects.toThrow(/target/);
  host({ [binary.toLowerCase()]: npmNodeShim(target), [win32.join(folder, target).toLowerCase()]: 'script' });
  await expect(resolveLocalAgentCommand(binary, args, environment, 'C:\\vault')).rejects.toThrow(/node.exe/);
});
