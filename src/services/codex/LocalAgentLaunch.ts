import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { LOCAL_AGENTS, type LocalAgentId } from './LocalAgents';

export type LocalAgentLaunchConfig = {
  configPath: string;
  home: string;
  /** A string preference from the machine-local file, with `~/` expanded. */
  setting: (key: string, fallback: string) => string;
  /** The inherited environment with the usual CLI install folders on PATH. */
  environment: Record<string, string | undefined>;
};

/** Reads `~/.config/systemsculpt/<name>.json`. Never reads an agent's own credentials or history. */
export async function readLocalAgentLaunchConfig(name: LocalAgentId, label: string): Promise<LocalAgentLaunchConfig> {
  const [fs, os, path] = await Promise.all([desktopHost.fs(), desktopHost.os(), desktopHost.path()]);
  const home = os.homedir();
  const configPath = path.join(home, '.config', 'systemsculpt', `${name}.json`);
  let config: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!isRecord(value)) throw new Error('Expected an object.');
    config = value;
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw new Error(`Cannot read ${label} launch settings at ${configPath}.`);
  }
  const setting = (key: string, fallback: string) => {
    const value = config[key];
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${label} ${key} in ${configPath}.`);
    return value.startsWith('~/') ? path.join(home, value.slice(2)) : value.trim();
  };
  // Detection and native child processes share this PATH, including node for env shebangs.
  const environment: Record<string, string | undefined> = { ...desktopHost.environment() };
  const platform = os.platform(), windows = platform === 'win32';
  // Node passes only the first case-insensitive PATH key to Windows children.
  const pathKey = windows ? Object.keys(environment).sort().find(key => key.toUpperCase() === 'PATH') : 'PATH';
  const inheritedPath = (pathKey ? environment[pathKey] : '') || '';
  if (windows) for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
  const roaming = environment.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const data = environment.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const existingFolders = [...inheritedPath.split(path.delimiter),
    ...(windows ? [] : ['/opt/homebrew/bin', '/usr/local/bin']), path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];
  const setPath = (folders: string[]) => { environment.PATH = [...new Set(folders)].filter(Boolean).join(path.delimiter); };
  setPath(existingFolders);
  const launch = { configPath, home, setting, environment };
  const existingBinary = await resolveLocalAgentBinary(name, launch);
  const installFolders = [
    ...(windows ? [path.join(roaming, 'npm'),
      path.join(environment.ProgramFiles || path.join(path.parse(home).root, 'Program Files'), 'nodejs'),
      path.join(environment['ProgramFiles(x86)'] || path.join(path.parse(home).root, 'Program Files (x86)'), 'nodejs'),
      path.join(local, 'Programs', 'nodejs')] : []),
    path.join(environment.VOLTA_HOME || (windows ? path.join(local, 'Volta') : path.join(home, '.volta')), 'bin'),
    path.join(environment.ASDF_DATA_DIR || path.join(home, '.asdf'), 'shims'), path.join(home, '.asdf', 'bin'),
    path.join(environment.BUN_INSTALL || path.join(home, '.bun'), 'bin'),
    environment.PNPM_HOME || (windows ? path.join(local, 'pnpm') : platform === 'darwin' ? path.join(home, 'Library', 'pnpm') : path.join(data, 'pnpm')),
    path.join(home, '.claude', 'local'),
  ];
  setPath([...existingFolders, ...installFolders]);
  // Optional version-manager I/O must not delay an installation that already worked.
  if (existingBinary) return launch;
  const nvm = environment.NVM_DIR || (windows ? environment.NVM_HOME || path.join(roaming, 'nvm') : path.join(home, '.nvm'));
  const fnmRoots = environment.FNM_DIR ? [environment.FNM_DIR] : windows ? [path.join(roaming, 'fnm')]
    : [platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'fnm') : path.join(data, 'fnm'), path.join(home, '.fnm')];
  const runtimeBin = (root: string) => windows ? root : path.join(root, 'bin');
  const hasNode = async (folder: string) => {
    const stat = await fs.stat(path.join(folder, windows ? 'node.exe' : 'node')).catch(() => null);
    return !!stat?.isFile() && (windows || (stat.mode & 0o111) !== 0);
  };
  const newestBin = async (root: string, installation = '') => {
    // Only list version directory names; never source shell startup files or read agent stores.
    const versions = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && /^v?\d+\.\d+\.\d+$/.test(entry.name))
      .map(entry => entry.name).sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
    return versions[0] ? runtimeBin(path.join(root, versions[0], installation)) : '';
  };
  const nvmBin = async () => {
    const active = environment.NVM_BIN || (windows ? environment.NVM_SYMLINK : path.join(nvm, 'current', 'bin'));
    if (active && await hasNode(active)) return active;
    return newestBin(windows ? nvm : path.join(nvm, 'versions', 'node'));
  };
  const fnmBins = fnmRoots.map(async root => {
    const active = environment.FNM_MULTISHELL_PATH ? runtimeBin(environment.FNM_MULTISHELL_PATH) : runtimeBin(path.join(root, 'aliases', 'default'));
    return await hasNode(active) ? active : newestBin(path.join(root, 'node-versions'), 'installation');
  });
  const versionBins = await Promise.all([nvmBin(), ...fnmBins]);
  setPath([...existingFolders, ...installFolders, ...versionBins]);
  return launch;
}

/** Resolves the same machine-local binary and PATH a native run uses. Never starts it. */
export async function resolveLocalAgentBinary(agent: LocalAgentId, launch?: LocalAgentLaunchConfig, workingDirectory?: string): Promise<string | null> {
  const { setting, environment, home } = launch ?? await readLocalAgentLaunchConfig(agent, LOCAL_AGENTS[agent]);
  // Codex starts its app-server from home; Claude Code starts in the task's cwd.
  return resolveBinary(setting('binary', agent), environment, agent === 'codex' ? home : workingDirectory);
}

async function resolveBinary(binary: string, environment: Record<string, string | undefined>, cwd?: string): Promise<string | null> {
  const [fs, os, path] = await Promise.all([desktopHost.fs(), desktopHost.os(), desktopHost.path()]);
  const windows = os.platform() === 'win32';
  const relativePath = !path.isAbsolute(binary) && (binary.includes('/') || (windows && binary.includes('\\')));
  if (relativePath && (!cwd || !path.isAbsolute(cwd))) return null;
  const command = relativePath ? path.resolve(cwd!, binary) : binary;
  // npm also writes an extensionless POSIX shell companion; Windows must prefer .cmd.
  const extensions = windows && !path.extname(command) ? [...(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
  const folders = path.isAbsolute(command) ? [''] : (environment.PATH || '').split(path.delimiter).filter(Boolean);
  for (const folder of folders) for (const extension of extensions) {
    if (folder && !path.isAbsolute(folder) && (!cwd || !path.isAbsolute(cwd))) continue;
    const directory = folder && !path.isAbsolute(folder) ? path.resolve(cwd!, folder) : folder;
    const candidate = directory ? path.join(directory, command + extension) : command + extension;
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile() && (windows || (stat.mode & 0o111) !== 0)) return candidate;
  }
  return null;
}

// Recognize complete npm shims, not a command fragment in an arbitrary batch file.
// Extra setup, interpreter flags, or commands must not silently lose their semantics.
const NPM_SHIM_HEADER = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', ''].join('\n');
const NPM_NODE_SHIM_HEADER = NPM_SHIM_HEADER + [
  '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', '',
].join('\n');

/** Prepare native argv without a shell. npm .cmd shims run their installed script through Node. */
export async function resolveLocalAgentCommand(binary: string, args: string[], environment: Record<string, string | undefined>, cwd: string): Promise<{ binary: string; args: string[] }> {
  const os = await desktopHost.os();
  if (os.platform() !== 'win32') return { binary, args };
  const resolved = await resolveBinary(binary, environment, cwd) ?? binary;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { binary: resolved, args };
  const [fs, path] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
  const source = (await fs.readFile(resolved, 'utf8')).replace(/\r\n/g, '\n').trim();
  const nodeTarget = source.startsWith(NPM_NODE_SHIM_HEADER)
    ? /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" {2}"%dp0%\\([^"\r\n\0]+)" %\*$/.exec(source.slice(NPM_NODE_SHIM_HEADER.length))?.[1] : undefined;
  // Newer Claude npm installs expose a native .exe through npm's no-shebang shim.
  const nativeTarget = source.startsWith(NPM_SHIM_HEADER) ? /^"%dp0%\\([^"\r\n\0]+)" {3}%\*$/.exec(source.slice(NPM_SHIM_HEADER.length))?.[1] : undefined;
  const target = nodeTarget ?? nativeTarget;
  if (!target) {
    throw new Error(`Cannot launch ${resolved}: not a standard npm CLI shim. Reinstall the CLI with npm or set its native executable as the SystemSculpt launch binary.`);
  }
  const directory = path.dirname(resolved), script = path.resolve(directory, target);
  if (!(await fs.stat(script).catch(() => null))?.isFile()) throw new Error(`Cannot find the npm CLI target at ${script}. Reinstall the CLI with npm.`);
  if (nativeTarget) return { binary: script, args };
  const localNode = path.join(directory, 'node.exe');
  const node = (await fs.stat(localNode).catch(() => null))?.isFile() ? localNode : await resolveBinary('node.exe', environment, cwd);
  if (!node) throw new Error(`Cannot find node.exe for ${resolved}. Install Node.js or add it to PATH.`);
  // Absolute script path prevents Node option injection. No quoting, interpolation, or cmd.exe.
  return { binary: node, args: [script, ...args] };
}

export async function isLocalAgentInstalled(agent: LocalAgentId): Promise<boolean> {
  try { return await resolveLocalAgentBinary(agent) !== null; }
  catch { return false; } // Launch failures show their own guidance when the agent runs.
}
