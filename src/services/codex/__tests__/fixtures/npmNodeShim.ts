import { win32 } from 'node:path';
import { desktopHost } from '../../../../platform/desktopOnly';

/** npm cmd-shim's Node launcher, also checked against npm-generated shims on Windows CI. */
export function npmNodeShim(target: string): string {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
  ].join('\r\n');
}

export function npmNativeShim(target: string): string {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', `"%dp0%\\${target}"   %*`, ''].join('\r\n');
}

/** Only installed shim text and SystemSculpt launch config may be read; never native credentials. */
export function windowsNpmHost() {
  const home = 'C:\\Users\\A & B', cwd = 'D:\\Vault %PATH% !name! & notes';
  const folder = win32.join(home, 'AppData', 'Roaming', 'npm'), node = 'C:\\Program Files\\nodejs\\node.exe';
  const targets = { claude: 'node_modules\\@anthropic-ai\\claude-code\\cli.js', codex: 'node_modules\\@openai\\codex\\bin\\codex.js' };
  const scripts = { claude: win32.join(folder, targets.claude), codex: win32.join(folder, targets.codex) };
  const files = new Map<string, string>([[node.toLowerCase(), 'native node']]);
  for (const agent of ['claude', 'codex'] as const) {
    files.set(win32.join(folder, `${agent}.cmd`).toLowerCase(), npmNodeShim(targets[agent]));
    files.set(win32.join(folder, agent).toLowerCase(), '#!/bin/sh');
    files.set(scripts[agent].toLowerCase(), 'installed script');
  }
  const environment = { Path: 'C:\\Windows\\System32', CODEX_HOME: 'D:\\Native Codex', CLAUDE_CONFIG_DIR: 'D:\\Native Claude', CLAUDECODE: '1' };
  const directories = [home, cwd, environment.CODEX_HOME, environment.CLAUDE_CONFIG_DIR];
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fs = {
    stat: jest.fn(async (file: string) => ({ isFile: () => files.has(file.toLowerCase()), isDirectory: () => directories.includes(file) })),
    readdir: jest.fn(async () => []),
    readFile: jest.fn(async (file: string) => {
      if (file.startsWith(win32.join(home, '.config', 'systemsculpt'))) throw missing;
      if (!/\.cmd$/i.test(file)) throw new Error(`Unexpected content read: ${file}`);
      const content = files.get(file.toLowerCase());
      if (content === undefined) throw missing;
      return content;
    }),
  };
  jest.mocked(desktopHost.fs).mockResolvedValue(fs as never);
  jest.mocked(desktopHost.path).mockResolvedValue(win32);
  jest.mocked(desktopHost.os).mockResolvedValue({ homedir: () => home, platform: () => 'win32' } as never);
  jest.mocked(desktopHost.environment).mockReturnValue(environment);
  return { fs, home, cwd, node, scripts, environment };
}
