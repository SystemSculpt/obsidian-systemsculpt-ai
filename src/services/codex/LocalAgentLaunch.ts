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

/** True when the agent's CLI resolves to a file the way its launch would find it. Never starts it. */
export async function isLocalAgentInstalled(agent: LocalAgentId): Promise<boolean> {
  try {
    const [fs, os, path] = await Promise.all([desktopHost.fs(), desktopHost.os(), desktopHost.path()]);
    const { setting, environment } = await readLocalAgentLaunchConfig(agent, LOCAL_AGENTS[agent]);
    const binary = setting('binary', agent), windows = os.platform() === 'win32';
    const extensions = windows ? ['', ...(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
    const folders = path.isAbsolute(binary) ? [''] : (environment.PATH || '').split(path.delimiter).filter(Boolean);
    for (const folder of folders) for (const extension of extensions) {
      const stat = await fs.stat(folder ? path.join(folder, binary + extension) : binary + extension).catch(() => null);
      if (stat?.isFile() && (windows || (stat.mode & 0o111) !== 0)) return true;
    }
  } catch { /* An unreadable launch setting shows its own guidance when the agent runs. */ }
  return false;
}

/** Claude Code unless only Codex is installed; with neither, Claude Code's chat explains how to install it. */
export async function preferredLocalAgent(): Promise<LocalAgentId> {
  if (await isLocalAgentInstalled('claude')) return 'claude';
  return await isLocalAgentInstalled('codex') ? 'codex' : 'claude';
}
