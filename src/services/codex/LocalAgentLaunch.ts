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
export async function readLocalAgentLaunchConfig(name: string, label: string): Promise<LocalAgentLaunchConfig> {
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
  // GUI apps start with a minimal PATH; add the folders CLI installers use.
  const environment: Record<string, string | undefined> = { ...desktopHost.environment() };
  environment.PATH = [...new Set([...(environment.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'),
  ])].filter(Boolean).join(path.delimiter);
  return { configPath, home, setting, environment };
}

/** Resolves the same machine-local binary and PATH a native run uses. Never starts it. */
export async function resolveLocalAgentBinary(agent: LocalAgentId, launch?: LocalAgentLaunchConfig, workingDirectory?: string): Promise<string | null> {
  const [fs, os, path] = await Promise.all([desktopHost.fs(), desktopHost.os(), desktopHost.path()]);
  const { setting, environment, home } = launch ?? await readLocalAgentLaunchConfig(agent, LOCAL_AGENTS[agent]);
  const binary = setting('binary', agent), windows = os.platform() === 'win32';
  // Codex starts its app-server from home; Claude Code starts in the task's cwd.
  const cwd = agent === 'codex' ? home : workingDirectory;
  const relativePath = !path.isAbsolute(binary) && (binary.includes('/') || (windows && binary.includes('\\')));
  if (relativePath && (!cwd || !path.isAbsolute(cwd))) return null;
  const command = relativePath ? path.resolve(cwd!, binary) : binary;
  const extensions = windows ? ['', ...(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
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

export async function isLocalAgentInstalled(agent: LocalAgentId): Promise<boolean> {
  try { return await resolveLocalAgentBinary(agent) !== null; }
  catch { return false; } // Launch failures show their own guidance when the agent runs.
}
