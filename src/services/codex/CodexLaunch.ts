import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { readLocalAgentLaunchConfig } from './LocalAgentLaunch';

/** Machine-local launch preferences. Never read or copy Codex credentials. */
export async function resolveCodexLaunchOptions() {
  const [fs, path] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
  const { configPath, home, setting, environment } = await readLocalAgentLaunchConfig('codex', 'Codex');
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
  return { binary, environment: { ...environment, CODEX_HOME: codexHome }, home, codexHome };
}
