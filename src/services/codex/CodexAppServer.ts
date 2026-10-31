import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { resolveCodexLaunchOptions } from './CodexLaunch';
import { resolveLocalAgentCommand } from './LocalAgentLaunch';
export type CodexJson = Record<string, unknown>;
export type CodexConnection = {
  request: (method: string, params: CodexJson) => Promise<CodexJson>;
  close: () => void;
  /** Mark a retained chat connection idle between turns. */
  idle?: () => void;
  /** Resolves after this caller's threads and pending approvals have detached. */
  closed: Promise<void>;
};
type Callbacks = {
  notification: (method: string, params: CodexJson) => void;
  request: (method: string, params: CodexJson, signal: AbortSignal, requestId?: string | number) => Promise<unknown>;
  error: (error: Error) => void;
  abort?: () => void | Promise<void>;
};

type AppServerConnection = CodexConnection & { withdraw: (threads: ReadonlySet<string>) => void };
type SessionClient = { threads: Set<string>; busy: boolean; alive: () => boolean; callbacks: Callbacks; close: (error?: Error) => Promise<void>; fail: (error: Error) => void };
let session: CodexAppServerSession | undefined;
let pluginLifetime = new AbortController();

/** Re-enable native connections when this plugin instance loads again. */
export function startCodexSession(): void { if (pluginLifetime.signal.aborted) pluginLifetime = new AbortController(); }

type CodexLaunch = Awaited<ReturnType<typeof resolveCodexLaunchOptions>>;
const launchKey = (launch: CodexLaunch) => JSON.stringify([launch.binary, launch.home, launch.codexHome, launch.environment]);
function abortable<T>(operation: Promise<T>, signals: readonly AbortSignal[], error: () => Error = () => new Error('Codex run canceled.')): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { for (const signal of signals) signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(error()); };
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, cause => { cleanup(); reject(cause instanceof Error ? cause : new Error(String(cause))); });
    if (signals.some(signal => signal.aborted)) abort();
  });
}

/** One native process for this plugin session; callers own threads, never the process. */
export async function connectCodex(workingDirectory: string, signal: AbortSignal, callbacks: Callbacks, refresh = false): Promise<CodexConnection> {
  const lifetime = pluginLifetime.signal;
  if (signal.aborted || lifetime.aborted) throw new Error('Codex run canceled.');
  const [fs, path] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
  if (!path.isAbsolute(workingDirectory) || !(await fs.stat(workingDirectory)).isDirectory()) throw new Error('Codex requires an existing absolute working directory.');
  let launch = await resolveCodexLaunchOptions();
  if (refresh) session?.retire();
  while (session && (session.stopped || session.retiring || session.key !== launchKey(launch))) {
    session.retire();
    await abortable(session.closed, [signal, lifetime]);
    launch = await resolveCodexLaunchOptions();
  }
  if (signal.aborted || lifetime.aborted) throw new Error('Codex run canceled.');
  session ??= new CodexAppServerSession(launch);
  return session.connect(signal, callbacks);
}

/** Plugin unload drains the shared process even when only a cached picker used it. */
export async function disposeCodexSession(): Promise<void> { pluginLifetime.abort(); await session?.stop(); }

class CodexAppServerSession {
  private readonly lifetime = new AbortController();
  private readonly clients = new Set<SessionClient>();
  private readonly process: Promise<AppServerConnection>;
  readonly closed: Promise<void>;
  stopped = false;
  retiring = false;
  readonly key: string;
  private idleTimer?: number;
  private ready = false;

  constructor(launch: CodexLaunch) {
    this.key = launchKey(launch);
    this.process = startCodex(launch, this.lifetime.signal, {
      error: error => this.fail(error),
      notification: (method, params) => {
        for (const client of this.clients) if (client.alive() && client.threads.has(String(params.threadId))) {
          try { client.callbacks.notification(method, params); }
          catch (cause) { void client.close(cause instanceof Error ? cause : new Error(String(cause))); }
        }
      },
      request: (method, params, signal, id) => {
        const client = [...this.clients].find(client => client.alive() && client.threads.has(String(params.threadId)));
        return client ? client.callbacks.request(method, params, signal, id) : Promise.reject(new Error('Native approval withdrawn.'));
      },
    }).then(connection => { this.ready = true; return connection; });
    this.closed = this.process.then(connection => connection.closed, () => {}).then(() => {
      if (session === this) session = undefined;
    });
    void this.process.catch(() => {});
  }

  async connect(signal: AbortSignal, callbacks: Callbacks): Promise<CodexConnection> {
    this.clearIdle();
    let release!: () => void, ended = false, endingError = new Error('Codex connection closed.');
    const lifetime = new AbortController();
    const reject = (error: Error) => {
      endingError = error; lifetime.abort();
      try { callbacks.error(error); } catch { /* A caller's presentation must not break another native thread. */ }
    };
    let transport: AppServerConnection | undefined;
    const mutations = new Set<Promise<CodexJson>>(), turns = new Map<string, string>(), interrupted = new Set<string>();
    const closed = new Promise<void>(resolve => { release = resolve; });
    const client: SessionClient = { threads: new Set(), busy: true, alive: () => !ended, callbacks,
      close: (error = new Error('Codex session closed.')) => { finish(error); return closed; }, fail: error => {
      if (ended) return;
      ended = true; signal.removeEventListener('abort', abort); reject(error);
      this.clients.delete(client); void this.closed.then(release);
    } };
    const finish = (error: Error) => {
      if (ended) return;
      // Start native interruption before withdrawing this client's ability to send requests.
      const wasBusy = client.busy;
      let interruption: Promise<void>;
      try { interruption = wasBusy ? Promise.resolve(callbacks.abort?.()) : Promise.resolve(); } catch (cause) { interruption = Promise.reject(cause instanceof Error ? cause : new Error(String(cause))); }
      let timer: number | undefined;
      const grace = new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error('Codex interruption did not finish.')), 5000); });
      const draining = Promise.race([interruption, grace]).finally(() => { window.clearTimeout(timer); });
      void draining.catch(() => {});
      transport?.withdraw(client.threads);
      ended = true; signal.removeEventListener('abort', abort); reject(error);
      if (!transport) {
        // This caller cannot own a thread before the shared handshake completes.
        this.clients.delete(client); release();
        if (!this.clients.size) void this.stop();
        return;
      }
      void this.process.then(async connection => {
        try {
          await Promise.all([...mutations]);
          connection.withdraw(client.threads);
          await draining;
          if (wasBusy) await Promise.all([...turns].filter(([, turnId]) => !interrupted.has(turnId)).map(([threadId, turnId]) => connection.request('turn/interrupt', { threadId, turnId })));
          if (!this.stopped) await Promise.all([...client.threads].map(threadId => connection.request('thread/unsubscribe', { threadId }).catch(() => {})));
        } catch {
          // An unconfirmed stop cannot release a still-executing native turn to another caller.
          connection.close(); await connection.closed;
        }
      }).catch(() => {}).finally(() => { this.clients.delete(client); release(); this.scheduleIdle(); });
    };
    const abort = () => finish(new Error('Codex run canceled.'));
    this.clients.add(client);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const connection = await abortable(this.process, [lifetime.signal], () => endingError);
      transport = connection;
      return {
        request: async (method, params) => {
          if (ended || this.stopped) throw new Error('Codex connection closed.');
          client.busy = true; this.clearIdle();
          if (method === 'turn/start' && typeof params.threadId === 'string') turns.delete(params.threadId);
          if (method === 'turn/interrupt' && typeof params.turnId === 'string') interrupted.add(params.turnId);
          const response = connection.request(method, params).then(result => {
            if ((method === 'thread/start' || method === 'thread/resume') && isRecord(result.thread) && typeof result.thread.id === 'string') client.threads.add(result.thread.id);
            // Own the turn before handing the response through any caller's await chain.
            if (method === 'turn/start' && typeof params.threadId === 'string' && isRecord(result.turn) && typeof result.turn.id === 'string') turns.set(params.threadId, result.turn.id);
            return result;
          });
          if (method === 'thread/start' || method === 'thread/resume' || method === 'turn/start') {
            mutations.add(response); void response.finally(() => mutations.delete(response)).catch(() => {});
          }
          // A cancellation still waits for native interruption, not its own rejected caller race.
          return method === 'turn/interrupt' ? response : abortable(response, [lifetime.signal], () => endingError);
        },
        idle: () => { client.busy = false; this.scheduleIdle(); },
        close: () => finish(new Error('Codex transport closed.')),
        closed,
      };
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); await closed; throw error; }
  }

  private clearIdle(): void { window.clearTimeout(this.idleTimer); this.idleTimer = undefined; }
  private scheduleIdle(): void {
    this.clearIdle();
    if (this.stopped || [...this.clients].some(client => client.busy)) return;
    if (this.retiring) { void this.stop(); return; }
    // Reuse the catalog's existing cache window; active turns and waiting tools never expire.
    this.idleTimer = window.setTimeout(() => { void this.stop(); }, 60_000);
  }
  private fail(error: Error): void {
    this.stopped = true; this.clearIdle();
    for (const client of [...this.clients]) client.fail(error);
  }
  retire(): void { this.retiring = true; this.scheduleIdle(); }
  stop(): Promise<void> {
    if (!this.stopped) {
      this.clearIdle();
      const clients = [...this.clients].map(client => client.close());
      this.stopped = true;
      if (!this.ready) this.lifetime.abort();
      else void Promise.all(clients).finally(() => this.lifetime.abort());
    }
    return this.closed;
  }
}

/** A bounded JSON-RPC connection to the installed CLI, with its existing auth/config. */
async function startCodex(launch: CodexLaunch, signal: AbortSignal, callbacks: Callbacks): Promise<AppServerConnection> {
  if (signal.aborted) throw new Error('Codex run canceled.');
  const childProcess = await desktopHost.childProcess();
  const command = await resolveLocalAgentCommand(launch.binary, ['app-server'], launch.environment, launch.home);
  if (signal.aborted) throw new Error('Codex run canceled.');
  // Start the transport from home; thread/start and thread/resume own the task cwd.
  // Some macOS application hosts stall CLI initialization in Documents subfolders.
  const processGroup = desktopHost.supportsProcessGroups?.() ?? false;
  const child = childProcess.spawn(command.binary, command.args, { cwd: launch.home, env: launch.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: processGroup });
  const forceStop = () => {
    if (processGroup && child.pid) { try { desktopHost.killProcessGroup(child.pid); return; } catch { /* Fall back to the owned child if its group already exited. */ } }
    try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
  };
  let killTimer: number | undefined;
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const pending = new Map<number, { resolve: (value: CodexJson) => void; reject: (error: Error) => void; timer: number }>();
  const questions = new Map<string | number, { controller: AbortController; threadId: unknown; turnId: unknown }>();
  const withdrawQuestions = (matches: (question: { threadId: unknown; turnId: unknown }) => boolean = () => true) => {
    for (const [id, question] of questions) if (matches(question)) { questions.delete(id); question.controller.abort(); }
  };
  let nextId = 0, buffer = '', stderr = '', stopped = false;
  const write = (value: unknown) => { if (!stopped) child.stdin.write(`${JSON.stringify(value)}\n`); };
  const request = (method: string, params: CodexJson): Promise<CodexJson> => new Promise((resolve, reject) => {
    if (stopped) { reject(new Error('Codex connection closed.')); return; }
    const id = ++nextId;
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error(`Codex did not respond to ${method}.`)); }, 30_000);
    pending.set(id, { resolve, reject, timer }); write({ id, method, params });
  });
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = true; signal.removeEventListener('abort', abort); withdrawQuestions(); callbacks.error(error);
    for (const waiter of pending.values()) { window.clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
    killTimer = window.setTimeout(forceStop, 5000);
    try { child.kill(); } catch { forceStop(); }
  };
  const abort = () => {
    withdrawQuestions();
    // Give native interruption a chance to stop its command processes before closing stdio.
    const timer = window.setTimeout(() => stop(new Error('Codex run canceled.')), 5000);
    void Promise.resolve().then(() => callbacks.abort?.()).catch(() => {}).finally(() => { window.clearTimeout(timer); stop(new Error('Codex run canceled.')); });
  };
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', error => stop(new Error(`Unable to start the installed Codex CLI: ${error.message}`)));
  child.on('exit', () => stop(new Error(`Codex connection closed before completion.${stderr ? ` ${stderr.slice(-2000)}` : ''}`)));
  child.on('close', () => {
    stop(new Error('Codex connection closed.')); window.clearTimeout(killTimer);
    if (processGroup && child.pid) { try { desktopHost.killProcessGroup(child.pid); } catch { /* No surviving helpers. */ } }
    release();
  });
  child.stdin.on('error', error => stop(error));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.setEncoding('utf8');
  const receive = (message: CodexJson) => {
    if (message.id !== undefined && typeof message.method !== 'string') {
      const waiter = pending.get(Number(message.id));
      if (!waiter) return;
      pending.delete(Number(message.id)); window.clearTimeout(waiter.timer);
      if (isRecord(message.error)) waiter.reject(new Error(String(message.error.message || 'Codex request failed.')));
      else waiter.resolve(isRecord(message.result) ? message.result : {});
      return;
    }
    const method = String(message.method || ''), params = isRecord(message.params) ? message.params : {};
    if (typeof message.id === 'string' || typeof message.id === 'number') {
      if (stopped || signal.aborted) return;
      const id = message.id, controller = new AbortController();
      questions.get(id)?.controller.abort();
      questions.set(id, { controller, threadId: params.threadId, turnId: params.turnId });
      const current = () => !stopped && !signal.aborted && !controller.signal.aborted && questions.get(id)?.controller === controller;
      void Promise.resolve().then(() => current() ? callbacks.request(method, params, controller.signal, id) : undefined).then(result => {
        if (!current()) return;
        questions.delete(id); write({ id, result });
      }).catch(error => {
        if (!current()) return;
        questions.delete(id); write({ id, error: { code: -32601, message: error instanceof Error ? error.message : 'Unsupported client request.' } });
      });
    } else {
      // Codex 0.162.1 withdraws client requests with serverRequest/resolved.
      if (method === 'serverRequest/resolved' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
        const question = questions.get(params.requestId);
        if (question && question.threadId === params.threadId) { questions.delete(params.requestId); question.controller.abort(); }
      }
      if (method === 'turn/completed' && isRecord(params.turn)) {
        withdrawQuestions(question => question.threadId === params.threadId && (question.turnId === undefined || question.turnId === (params.turn as CodexJson).id));
      }
      if (!stopped && !signal.aborted) callbacks.notification(method, params);
    }
  };
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { stop(new Error('Codex protocol message exceeded 4 MiB.')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { const message: unknown = JSON.parse(line); if (!isRecord(message)) throw new Error('Invalid message'); receive(message); }
      catch { stop(new Error('Invalid Codex protocol response.')); return; }
    }
  });
  try {
    if (signal.aborted) abort();
    await request('initialize', { clientInfo: { name: 'systemsculpt_studio', title: 'SystemSculpt Studio', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized', params: {} });
    const account = await request('account/read', { refreshToken: false });
    if (!isRecord(account.account) && account.requiresOpenaiAuth !== false) throw new Error(`Codex is not logged in for ${launch.codexHome}. Run codex login with that CODEX_HOME, then reconnect.`);
    return { request, close: () => stop(new Error('Codex transport closed.')), closed,
      withdraw: threads => withdrawQuestions(question => threads.has(String(question.threadId))) };
  } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); await closed; throw error; }
}
