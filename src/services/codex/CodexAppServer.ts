import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { resolveCodexLaunchOptions } from './CodexLaunch';
export type CodexJson = Record<string, unknown>;
export type CodexConnection = {
  request: (method: string, params: CodexJson) => Promise<CodexJson>;
  close: () => void;
};
type Callbacks = {
  notification: (method: string, params: CodexJson) => void;
  request: (method: string, params: CodexJson, signal: AbortSignal) => Promise<unknown>;
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
  const pending = new Map<number, { resolve: (value: CodexJson) => void; reject: (error: Error) => void; timer: number }>();
  const questions = new AbortController();
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
    stopped = true; signal.removeEventListener('abort', abort); questions.abort(); callbacks.error(error);
    for (const waiter of pending.values()) { window.clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear(); child.kill();
  };
  const abort = () => {
    // Give native interruption a chance to stop its command processes before closing stdio.
    const timer = window.setTimeout(() => stop(new Error('Codex run canceled.')), 5000);
    void Promise.resolve().then(() => callbacks.abort?.()).catch(() => {}).finally(() => { window.clearTimeout(timer); stop(new Error('Codex run canceled.')); });
  };
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', error => stop(new Error(`Unable to start the installed Codex CLI: ${error.message}`)));
  child.on('exit', () => stop(new Error(`Codex connection closed before completion.${stderr ? ` ${stderr.slice(-2000)}` : ''}`)));
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
    if (message.id !== undefined) {
      void callbacks.request(method, params, questions.signal).then(result => write({ id: message.id, result })).catch(error => {
        write({ id: message.id, error: { code: -32601, message: error instanceof Error ? error.message : 'Unsupported client request.' } });
      });
    } else callbacks.notification(method, params);
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
    return { request, close: () => stop(new Error('Codex transport closed.')) };
  } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); throw error; }
}
