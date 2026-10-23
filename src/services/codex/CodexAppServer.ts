import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { resolveCodexLaunchOptions } from './CodexLaunch';
export type CodexJson = Record<string, unknown>;
export type CodexConnection = {
  request: (method: string, params: CodexJson) => Promise<CodexJson>;
  close: () => void;
  /** Resolves only after the child process and its stdio have closed. */
  closed: Promise<void>;
};
type Callbacks = {
  notification: (method: string, params: CodexJson) => void;
  request: (method: string, params: CodexJson, signal: AbortSignal, requestId?: string | number) => Promise<unknown>;
  error: (error: Error) => void;
  abort?: () => void | Promise<void>;
};

/** A bounded JSON-RPC connection to the installed CLI, with its existing auth/config. */
export async function connectCodex(workingDirectory: string, signal: AbortSignal, callbacks: Callbacks): Promise<CodexConnection> {
  if (signal.aborted) throw new Error('Codex run canceled.');
  const [childProcess, fs, path] = await Promise.all([desktopHost.childProcess(), desktopHost.fs(), desktopHost.path()]);
  if (!path.isAbsolute(workingDirectory) || !(await fs.stat(workingDirectory)).isDirectory()) throw new Error('Codex requires an existing absolute working directory.');
  const launch = await resolveCodexLaunchOptions();
  if (signal.aborted) throw new Error('Codex run canceled.');
  // Start the transport from home; thread/start and thread/resume own the task cwd.
  // Some macOS application hosts stall CLI initialization in Documents subfolders.
  const child = childProcess.spawn(launch.binary, ['app-server'], { cwd: launch.home, env: launch.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    pending.clear(); child.kill();
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
  child.on('close', () => { stop(new Error('Codex connection closed.')); release(); });
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
    return { request, close: () => stop(new Error('Codex transport closed.')), closed };
  } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); await closed; throw error; }
}
