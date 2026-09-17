import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';

/** Machine-local launch preferences. Never read or copy Codex credentials. */
export async function resolveCodexLaunchOptions() {
  const [fs, os, path] = await Promise.all([desktopHost.fs(), desktopHost.os(), desktopHost.path()]);
  const home = os.homedir();
  const configPath = path.join(home, '.config', 'systemsculpt', 'codex.json');
  let config: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!isRecord(value)) throw new Error('Expected an object.');
    config = value;
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw new Error(`Cannot read Codex launch settings at ${configPath}.`);
  }
  const setting = (key: string, fallback: string) => {
    const value = config[key];
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Invalid Codex ${key} in ${configPath}.`);
    return value.startsWith('~/') ? path.join(home, value.slice(2)) : value.trim();
  };
  const binary = setting('binary', 'codex');
  const codexHome = setting('home', path.join(home, '.codex'));
  if (!path.isAbsolute(codexHome)) throw new Error(`Codex home must be an absolute path in ${configPath}.`);
  let homeStat;
  try { homeStat = await fs.stat(codexHome); }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error(`Codex home does not exist: ${codexHome}. Run codex login with that CODEX_HOME, or select an existing home in ${configPath}.`);
    throw new Error(`Cannot access Codex home ${codexHome}. Check its directory permissions.`);
  }
  if (!homeStat.isDirectory()) throw new Error(`Codex home is not a directory: ${codexHome}`);
  // GUI apps can inherit an agent's temporary CODEX_HOME without its launch arguments.
  // Use the normal native login unless this machine explicitly selects another home.
  const environment: Record<string, string | undefined> = { ...desktopHost.environment(), CODEX_HOME: codexHome };
  environment.PATH = [...new Set([...(environment.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'),
  ])].filter(Boolean).join(path.delimiter);
  return { binary, environment, home, codexHome };
}
