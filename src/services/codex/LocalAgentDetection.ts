import { desktopHost } from '../../platform/desktopOnly';
import { hasHostCapability } from '../../platform/hostCapabilities';
import { isRecord } from '../../studio/utils';
import { resolveCodexLaunchOptions } from './CodexLaunch';
import { readLocalAgentLaunchConfig, resolveLocalAgentBinary, resolveLocalAgentCommand } from './LocalAgentLaunch';
import { LOCAL_AGENTS, type LocalAgentId, type TextExecutionBackend } from './LocalAgents';

export type LocalAgentAvailability = Readonly<{
  installed: boolean;
  /** Null means the probe ended before native sign-in status was known. */
  signedIn: boolean | null;
  recentSessionCount: number;
  lastUsed: number | null;
}>;
export type LocalAgentDetection = Readonly<{
  preferred: TextExecutionBackend;
  agents: Readonly<Record<LocalAgentId, LocalAgentAvailability>>;
}>;

const PROBE_TIMEOUT_MS = 3000;
const RECENT_USAGE_MS = 30 * 24 * 60 * 60 * 1000;
const unavailable = (): LocalAgentAvailability => ({ installed: false, signedIn: false, recentSessionCount: 0, lastUsed: null });
const cachedDetections = new Map<string | undefined, Promise<LocalAgentDetection>>();
const listeners = new Map<string | undefined, Set<(detection: LocalAgentDetection) => void>>();

/** Only sign-in state and aggregate timestamps/counts leave the probe; status output is never retained. */
async function signedIn(agent: LocalAgentId, binary: string, environment: Record<string, string | undefined>, cwd: string, signal: AbortSignal): Promise<boolean | null> {
  const childProcess = await desktopHost.childProcess();
  const command = await resolveLocalAgentCommand(binary, agent === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], environment, cwd);
  if (signal.aborted) return null;
  return new Promise(resolve => {
    childProcess.execFile(command.binary, command.args, {
      cwd, env: environment, signal, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, shell: false,
    }, (error, stdout, stderr) => {
      if (signal.aborted || error?.killed) { resolve(null); return; }
      if (error) { resolve(false); return; }
      if (agent === 'codex') { resolve(/^Logged in\b/im.test(`${stdout}\n${stderr}`)); return; }
      try {
        const status: unknown = JSON.parse(stdout);
        resolve(isRecord(status) && status.loggedIn === true);
      } catch { resolve(false); }
    });
  });
}

type Usage = { recentSessionCount: number; lastUsed: number | null };

/** Visits only primary session files, never contents, nested subagents, or symlinks. */
async function sessionUsage(agent: LocalAgentId, home: string, deadline: number): Promise<Usage> {
  const [fs, path] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
  const usage: Usage = { recentSessionCount: 0, lastUsed: null };
  const cutoff = Date.now() - RECENT_USAGE_MS;
  const list = async (directory: string) => {
    if (Date.now() >= deadline) return [];
    return fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  };
  const sessions = async (directory: string) => {
    const entries = await list(directory);
    for (const entry of entries) {
      if (Date.now() >= deadline) break;
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const stat = await fs.stat(path.join(directory, entry.name)).catch(() => null);
      if (!stat?.isFile() || !Number.isFinite(stat.mtimeMs)) continue;
      if (stat.mtimeMs >= cutoff) usage.recentSessionCount++;
      usage.lastUsed = Math.max(usage.lastUsed ?? 0, stat.mtimeMs);
    }
  };
  if (agent === 'claude') {
    const root = path.join(home, 'projects');
    for (const entry of await list(root)) {
      if (Date.now() >= deadline) break;
      // A project's mtime does not change when an existing session is updated.
      if (entry.isDirectory()) await sessions(path.join(root, entry.name));
    }
  } else {
    const root = path.join(home, 'sessions');
    // Codex partitions primary sessions by start date. Inspect recent days and
    // the newest older day for last-used evidence, rather than walking history.
    const newestDirectories = async (directory: string, pattern: RegExp) => (await list(directory))
      .filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name).sort().reverse();
    for (const year of await newestDirectories(root, /^\d{4}$/)) {
      for (const month of await newestDirectories(path.join(root, year), /^(0[1-9]|1[0-2])$/)) {
        for (const day of await newestDirectories(path.join(root, year, month), /^(0[1-9]|[12]\d|3[01])$/)) {
          if (Date.now() >= deadline) return usage;
          await sessions(path.join(root, year, month, day));
          if (Date.parse(`${year}-${month}-${day}T23:59:59.999Z`) < cutoff) return usage;
        }
      }
    }
  }
  return usage;
}

async function probe(agent: LocalAgentId, workingDirectory?: string): Promise<LocalAgentAvailability> {
  const state = { ...unavailable() };
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: number | undefined;
  const work = async () => {
    try {
      const launch = await readLocalAgentLaunchConfig(agent, LOCAL_AGENTS[agent]);
      const binary = await resolveLocalAgentBinary(agent, launch, workingDirectory);
      if (!binary || Date.now() >= deadline) return;
      state.installed = true;
      state.signedIn = null;
      const path = await desktopHost.path();
      const native = agent === 'codex' ? await resolveCodexLaunchOptions(launch) : null;
      const environment: Record<string, string | undefined> = { ...(native?.environment ?? launch.environment) };
      delete environment.CLAUDECODE;
      const cwd = agent === 'codex' ? launch.home : workingDirectory || launch.home;
      const home = native?.codexHome ?? path.resolve(cwd, environment.CLAUDE_CONFIG_DIR || path.join(launch.home, '.claude'));
      await Promise.all([
        signedIn(agent, binary, environment, cwd, controller.signal).then(value => { state.signedIn = value; }),
        sessionUsage(agent, home, deadline).then(value => { Object.assign(state, value); }),
      ]);
    } catch {
      // A completed launch failure is distinct from a probe that ran out of time.
      if (!controller.signal.aborted) state.signedIn = false;
    }
  };
  try {
    await Promise.race([work(), new Promise<void>(resolve => { timer = window.setTimeout(resolve, PROBE_TIMEOUT_MS); })]);
    return { ...state };
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    controller.abort();
  }
}

export function isLocalAgentUsable(agent: LocalAgentAvailability | undefined): boolean {
  return Boolean(agent?.installed && (agent.signedIn === true || (agent.signedIn === null && agent.recentSessionCount > 0)));
}

function preferredAgent(agents: LocalAgentDetection['agents']): TextExecutionBackend {
  const usable = (['claude', 'codex'] as const).filter(agent => isLocalAgentUsable(agents[agent]));
  usable.sort((left, right) => agents[right].recentSessionCount - agents[left].recentSessionCount
    || (agents[right].lastUsed ?? 0) - (agents[left].lastUsed ?? 0));
  return usable[0] ?? 'systemsculpt';
}

/** Cached per task directory for this Obsidian session; no polling or persistent usage data. */
export function detectLocalAgents(options: { force?: boolean; workingDirectory?: string } = {}): Promise<LocalAgentDetection> {
  if (!hasHostCapability('local-cli')) return Promise.resolve({ preferred: 'systemsculpt', agents: { claude: unavailable(), codex: unavailable() } });
  if (options.force) invalidateLocalAgentDetection();
  let detection = cachedDetections.get(options.workingDirectory);
  if (!detection) {
    detection = Promise.all([probe('claude', options.workingDirectory), probe('codex', options.workingDirectory)]).then(([claude, codex]) => {
      const agents = { claude, codex };
      if (cachedDetections.get(options.workingDirectory) === detection && (claude.signedIn === null || codex.signedIn === null)) {
        // Cold CLI startup is not a sign-out. Retry unknown probes once, without
        // making the first caller wait or turning the session cache into polling.
        void Promise.all((['claude', 'codex'] as const).map(agent => agents[agent].signedIn === null
          ? probe(agent, options.workingDirectory) : Promise.resolve(agents[agent]))).then(([claude, codex]) => {
          if (cachedDetections.get(options.workingDirectory) !== detection) return;
          const agents = { claude, codex };
          const refreshed = { preferred: preferredAgent(agents), agents };
          cachedDetections.set(options.workingDirectory, Promise.resolve(refreshed));
          for (const listener of listeners.get(options.workingDirectory) ?? []) {
            try { listener(refreshed); } catch { /* A view must not interrupt detection. */ }
          }
        });
      }
      return { preferred: preferredAgent(agents), agents };
    });
    cachedDetections.set(options.workingDirectory, detection);
  }
  return detection;
}

/** Updates chrome after the one background retry, without switching an open chat's backend. */
export function subscribeLocalAgentDetection(workingDirectory: string | undefined, listener: (detection: LocalAgentDetection) => void): () => void {
  let subscribers = listeners.get(workingDirectory);
  if (!subscribers) { subscribers = new Set(); listeners.set(workingDirectory, subscribers); }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(workingDirectory);
  };
}

export function invalidateLocalAgentDetection(): void {
  cachedDetections.clear();
}
