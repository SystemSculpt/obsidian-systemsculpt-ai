import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { readLocalAgentLaunchConfig, type LocalAgentLaunchConfig } from './LocalAgentLaunch';

/** Machine-local launch preferences. Never read or copy Codex credentials. */
export async function resolveCodexLaunchOptions(launch?: LocalAgentLaunchConfig) {
  const [fs, path] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
  const { configPath, home, setting, environment } = launch ?? await readLocalAgentLaunchConfig('codex', 'Codex');
  const binary = setting('binary', 'codex');
  const codexHome = setting('home', environment.CODEX_HOME || path.join(home, '.codex'));
  if (!path.isAbsolute(codexHome)) throw new Error(`Codex home must be an absolute path in ${configPath}.`);
  let homeStat;
  try { homeStat = await fs.stat(codexHome); }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error(`Codex home does not exist: ${codexHome}. Run codex login with that CODEX_HOME, or select an existing home in ${configPath}.`);
    throw new Error(`Cannot access Codex home ${codexHome}. Check its directory permissions.`);
  }
  if (!homeStat.isDirectory()) throw new Error(`Codex home is not a directory: ${codexHome}`);
  // Detection and execution must inspect the same native login and session store.
  return { binary, environment: { ...environment, CODEX_HOME: codexHome }, home, codexHome };
}
