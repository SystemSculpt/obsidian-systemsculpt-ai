import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../studio/utils';
import { readLocalAgentLaunchConfig } from '../codex/LocalAgentLaunch';
import { LocalAgentUsageLimitError } from '../codex/LocalAgents';

export const CLAUDE_PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'settings'] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];
export type ClaudeExecutionOptions = { model?: string; permissionMode?: string };
export type ClaudeRequest = ClaudeExecutionOptions & { prompt: string; workingDirectory: string; sessionId?: string; images?: readonly string[] };
export type ClaudeResult = { sessionId: string; text: string };
export type ClaudePermissionRequest = {
  toolName: string; description: string; input: Record<string, unknown>;
  requestId?: string; toolUseId?: string; permissionSuggestions?: readonly Record<string, unknown>[];
};
export type ClaudePermissionDecision = boolean | { approved: boolean; rememberForSession?: boolean; answers?: Record<string, string[]> };
export type ClaudeToolActivity = {
  id: string; name?: string; input?: unknown; inputText?: string;
  state: 'input-streaming' | 'running' | 'succeeded' | 'failed'; output?: unknown;
};
export type ClaudeCallbacks = {
  session: (sessionId: string) => void | Promise<void>;
  log: (text: string) => void;
  notice?: (text: string) => void;
  /** Tail snapshot plus its absolute character offset in this turn's text. */
  text?: (text: string, offset?: number) => void;
  tool?: (activity: ClaudeToolActivity) => void;
  supportsQuestions?: boolean;
  /** Studio may return a boolean; chat can additionally choose a native session-scoped grant. */
  permission: (request: ClaudePermissionRequest, signal: AbortSignal) => Promise<ClaudePermissionDecision>;
};

/** Exact reusable native suggestions, redirected only to in-memory session scope. */
export function claudeSessionPermissionUpdates(request: ClaudePermissionRequest): Record<string, unknown>[] {
  return request.permissionSuggestions?.filter(suggestion => !(suggestion.type === 'setMode' && ['bypassPermissions', 'dontAsk'].includes(String(suggestion.mode)))).map(suggestion => ({ ...suggestion, destination: 'session' })) ?? [];
}

/** Claude Code 2.1.309's public PermissionResult / PermissionUpdate protocol. No settings writes. */
export function claudePermissionResponse(request: ClaudePermissionRequest, decision: ClaudePermissionDecision): Record<string, unknown> {
  const approved = typeof decision === 'boolean' ? decision : decision.approved;
  if (!approved) return { behavior: 'deny', message: 'The user declined this action in SystemSculpt.' };
  const updatedInput = request.toolName === 'AskUserQuestion' && typeof decision !== 'boolean' && decision.answers
    ? { ...request.input, answers: Object.fromEntries(Object.entries(decision.answers).map(([question, answers]) => [question, answers.join(', ')])) } : request.input;
  const updates = typeof decision !== 'boolean' && decision.rememberForSession
    ? claudeSessionPermissionUpdates(request) : undefined;
  return { behavior: 'allow', updatedInput, ...(updates?.length ? { updatedPermissions: updates } : {}) };
}

export const CLAUDE_SIGN_IN_MESSAGE = 'Claude Code is not signed in. Open a terminal, run `claude`, then type /login. Send your message again after signing in.';
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
const MAX_LINE = 16 * 1024 * 1024;
const activeSessions = new Set<string>();
export const CLAUDE_AUTO_FALLBACK_NOTICE = "Claude Code's Auto mode isn't available here, so edits are accepted automatically and other actions ask. Update Claude Code to use Auto.";
class ClaudeAutoUnavailable extends Error {}
function rejectsAutoMode(message: string): boolean {
  return /(?:permission.?mode[^\n]*auto|auto[^\n]*(?:mode|permission))/i.test(message)
    && /invalid|unsupported|not (?:available|supported|allowed|enabled)|unavailable|not eligible|requires|choices|cannot use/i.test(message);
}

export function resolveClaudeOptions(options: ClaudeExecutionOptions): Required<ClaudeExecutionOptions> & { permissionMode: ClaudePermissionMode } {
  const model = options.model?.trim() || '';
  const selected = options.permissionMode?.trim() || 'auto';
  // "default" was the old CLI spelling of Ask; persisted defaults migrate to Auto.
  const permissionMode = selected === 'default' ? 'manual' : selected;
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/.test(model)) throw new Error('Invalid Claude Code model.');
  if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(permissionMode)) throw new Error('Invalid Claude Code permission mode.');
  return { model, permissionMode: permissionMode as ClaudePermissionMode };
}

/** Print mode with JSON streams on both ends; permission prompts come back to the plugin over stdio. */
export function claudeLaunchArgs(options: ClaudeExecutionOptions, sessionId?: string): string[] {
  const { model, permissionMode } = resolveClaudeOptions(options);
  if (sessionId !== undefined && !SESSION_PATTERN.test(sessionId)) throw new Error('Invalid saved Claude Code session identity.');
  return ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    // "settings" leaves the mode to Claude Code's own configuration.
    ...(permissionMode === 'settings' ? [] : ['--permission-mode', permissionMode]),
    ...(model ? ['--model', model] : []),
    ...(sessionId ? ['--resume', sessionId] : [])];
}

function userMessage(prompt: string, images: readonly string[]): Record<string, unknown> {
  const blocks = images.map(url => {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new Error('Claude Code accepts PNG, JPEG, GIF or WebP images.');
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  });
  return { type: 'user', message: { role: 'user', content: blocks.length ? [{ type: 'text', text: prompt }, ...blocks] : prompt } };
}

function toolSummary(name: string, input: unknown, cwd: string): string {
  const value = isRecord(input) ? input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url : undefined;
  if (typeof value !== 'string') return name;
  const target = value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value;
  return `${name} ${target.slice(0, 160)}`;
}

type ClaudeLiveConnection = {
  sessionId: string;
  key: string;
  next: (input: ClaudeRequest, signal: AbortSignal, callbacks: ClaudeCallbacks) => Promise<ClaudeResult>;
  close: () => Promise<void>;
};
const claudeConnectionKey = (input: ClaudeRequest) => JSON.stringify([input.workingDirectory, resolveClaudeOptions(input)]);

/** A chat owns its live native permission context. Nothing is replayed from the transcript. */
export class ClaudeChatTransport {
  connection?: ClaudeLiveConnection;
  closing: Promise<void> = Promise.resolve();
  private used = false;
  private running = false;
  constructor(private readonly notice?: (message: string) => void) {}
  async run(input: ClaudeRequest, signal: AbortSignal, callbacks: ClaudeCallbacks): Promise<ClaudeResult> {
    if (this.running) throw new Error('Wait for the current Claude Code response to finish.');
    this.running = true;
    try {
      await this.closing;
      if (signal.aborted) throw new Error('Claude Code run canceled.');
      if (this.connection && (this.connection.key !== claudeConnectionKey(input) || this.connection.sessionId !== input.sessionId)) await this.close();
      if (!this.connection && this.used) this.notice?.('Claude Code started a new native session. Previous session approvals no longer apply.');
      this.used = true;
      const result = await runLocalClaude(input, signal, callbacks, this);
      // Compare the selected settings, not an effective native fallback mode, on the next turn.
      if (this.connection) this.connection.key = claudeConnectionKey(input);
      return result;
    } finally { this.running = false; }
  }
  async close(): Promise<void> { const connection = this.connection; this.connection = undefined; if (connection) this.closing = connection.close(); await this.closing; }
}

/** One turn by default (Studio); chat may explicitly retain the native stdio session. */
export async function runLocalClaude(input: ClaudeRequest, signal: AbortSignal, callbacks: ClaudeCallbacks, owner?: ClaudeChatTransport): Promise<ClaudeResult> {
  try { return await runClaudeAttempt(input, signal, callbacks, owner); }
  catch (error) {
    if (!(error instanceof ClaudeAutoUnavailable) || signal.aborted) throw error;
    callbacks.notice?.(CLAUDE_AUTO_FALLBACK_NOTICE); callbacks.log(CLAUDE_AUTO_FALLBACK_NOTICE);
    return runClaudeAttempt({ ...input, permissionMode: 'acceptEdits' }, signal, callbacks, owner);
  }
}

async function runClaudeAttempt(input: ClaudeRequest, signal: AbortSignal, callbacks: ClaudeCallbacks, owner?: ClaudeChatTransport): Promise<ClaudeResult> {
  if (!input.prompt.trim() || input.prompt.length > 256_000) throw new Error('A Claude Code prompt must contain 1–256,000 characters.');
  if (owner?.connection) return owner.connection.next(input, signal, callbacks);
  const args = claudeLaunchArgs(input, input.sessionId);
  const message = userMessage(input.prompt, input.images || []);
  if (signal.aborted) throw new Error('Claude Code run canceled.');
  const [childProcess, fs, path] = await Promise.all([desktopHost.childProcess(), desktopHost.fs(), desktopHost.path()]);
  if (!path.isAbsolute(input.workingDirectory) || !(await fs.stat(input.workingDirectory)).isDirectory()) throw new Error('Claude Code requires an existing absolute working directory.');
  const launch = await readLocalAgentLaunchConfig('claude', 'Claude Code');
  const binary = launch.setting('binary', 'claude');
  // A plugin turn is a top-level session even when Obsidian was opened from a Claude Code terminal.
  const environment = { ...launch.environment }; delete environment.CLAUDECODE;
  if (signal.aborted) throw new Error('Claude Code run canceled.');
  // A new session gets its identity up front, so every event can be checked against it.
  const sessionId = input.sessionId || window.crypto.randomUUID();
  if (!input.sessionId) args.push('--session-id', sessionId);
  if (activeSessions.has(sessionId)) throw new Error('This Claude Code session is already running in another Studio or chat view.');
  activeSessions.add(sessionId);
  let retained = false;
  try {
    const child = childProcess.spawn(binary, args, { cwd: input.workingDirectory, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const prompts = new Map<string, AbortController>();
      const toolBlocks = new Map<number, { id: string; name: string; inputText: string }>();
      let buffer = '', stderr = '', settled = false, text = '', partial = '', signedOut = false, nextRequest = 0;
      let initialized = false, activityStarted = false, pipeFailure = false, fallbackRequestId: string | undefined;
      const auto = resolveClaudeOptions(input).permissionMode === 'auto';
      let textLength = 0, partialLength = 0;
      // A new identity is saved once Claude Code confirms it, so a launch that never started cannot leave a chat resuming a missing session.
      let saving: Promise<void> | undefined = input.sessionId ? Promise.resolve() : undefined;
      let outcome: { result?: ClaudeResult; error?: Error } | undefined;
      let killTimer: number | undefined, closing = false;
      let release!: () => void;
      const closed = new Promise<void>(resolveClosed => { release = resolveClosed; });
      let connection: ClaudeLiveConnection | undefined;
      const closeProcess = () => {
        if (!closing) {
          closing = true;
          if (owner) { if (owner.connection === connection) owner.connection = undefined; owner.closing = closed; }
          killTimer = window.setTimeout(() => child.kill('SIGKILL'), 5000);
          try { child.stdin.end(); } catch { /* already closed */ }
        }
        return closed;
      };
      const write = (value: unknown) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify(value)}\n`); };
      const publish = () => callbacks.text?.([text, partial].filter(Boolean).join('\n\n'));
      const finish = (value: { result?: ClaudeResult; error?: Error }) => {
        if (settled) { if (value.error && owner) void closeProcess(); return; }
        outcome = value; settled = true; signal.removeEventListener('abort', abort);
        for (const prompt of prompts.values()) prompt.abort(); prompts.clear();
        if (owner && value.result && saving) {
          // Keep native session grants alive between successful chat turns. Studio still closes below.
          void saving.then(() => resolve(value.result!), error => { outcome = { error }; void closeProcess(); });
        } else void closeProcess();
      };
      const abort = () => {
        write({ type: 'control_request', request_id: `systemsculpt-${++nextRequest}`, request: { subtype: 'interrupt' } });
        finish({ error: new Error('Claude Code run canceled.') });
      };
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', (error: Error & { code?: string }) => finish({ error: new Error(error.code === 'ENOENT'
        ? `Claude Code is not installed or not on PATH. Install Claude Code, then run \`claude\` and type /login. If it is installed elsewhere, set "binary" in ${launch.configPath}.`
        : `Unable to start the installed Claude Code CLI: ${error.message}`) }));
      // Close, unlike exit, fires after stdout is drained, so a final result written just before exit still counts.
      child.on('close', () => {
        const error = auto && !initialized && !activityStarted && rejectsAutoMode(stderr)
          ? new ClaudeAutoUnavailable('Claude Code rejected Auto mode before starting.')
          : new Error(signedOut ? CLAUDE_SIGN_IN_MESSAGE : `Claude Code stopped before finishing.${stderr ? ` ${stderr.slice(-2000)}` : ''}`);
        // A rejected CLI option can close stdin before its diagnostic reaches stderr.
        if (error instanceof ClaudeAutoUnavailable && pipeFailure) outcome = { error };
        finish({ error });
        if (killTimer !== undefined) window.clearTimeout(killTimer);
        closing = true; activeSessions.delete(sessionId);
        if (owner && owner.connection === connection) owner.connection = undefined;
        release();
        if (outcome?.error || !saving) reject(outcome?.error ?? new Error('Claude Code did not confirm its session.'));
        else void saving.then(() => resolve(outcome!.result!), reject);
      });
      child.stdin.on('error', (error: Error & { code?: string }) => { pipeFailure = error.code === 'EPIPE'; finish({ error }); });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout.setEncoding('utf8');

      const answer = (requestId: string, request: Record<string, unknown>) => {
        const toolName = String(request.tool_name || 'tool'), toolInput = isRecord(request.input) ? request.input : {};
        const deny = (reason: string) => write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: reason } } });
        // Studio's modal remains approval-only; chat supplies the inline question surface.
        if (toolName === 'AskUserQuestion' && !callbacks.supportsQuestions) { deny('This chat cannot show interactive questions. Ask the question in your reply instead.'); return; }
        prompts.get(requestId)?.abort();
        const controller = new AbortController(); prompts.set(requestId, controller);
        const description = [request.description, request.decision_reason].filter(value => typeof value === 'string' && value).join('\n') || toolSummary(toolName, toolInput, input.workingDirectory);
        const permission: ClaudePermissionRequest = { toolName, description, input: toolInput, requestId,
          ...(typeof request.tool_use_id === 'string' ? { toolUseId: request.tool_use_id } : {}),
          ...(Array.isArray(request.permission_suggestions) ? { permissionSuggestions: request.permission_suggestions.filter(isRecord) } : {}) };
        void callbacks.permission(permission, controller.signal).then(decision => {
          if (prompts.get(requestId) !== controller || !prompts.delete(requestId) || settled || controller.signal.aborted) return;
          write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: claudePermissionResponse(permission, decision) } });
        }, () => { if (prompts.get(requestId) === controller && prompts.delete(requestId) && !settled && !controller.signal.aborted) deny('The user declined this action in SystemSculpt.'); });
      };
      const receive = (event: Record<string, unknown>) => {
        if (typeof event.session_id === 'string') {
          if (event.session_id !== sessionId) { finish({ error: new Error('Claude Code returned a different session identity.') }); return; }
          if (!saving) {
            saving = Promise.resolve().then(() => callbacks.session(sessionId));
            saving.catch(error => finish({ error: error instanceof Error ? error : new Error(String(error)) }));
          }
        }
        if (event.type === 'system' && event.subtype === 'init') {
          initialized = true;
          callbacks.log(`Connected to on-machine Claude Code${typeof event.model === 'string' ? ` · ${event.model}` : ''}`);
          if (auto && typeof event.permissionMode === 'string' && event.permissionMode !== 'auto') {
            callbacks.notice?.(CLAUDE_AUTO_FALLBACK_NOTICE); callbacks.log(CLAUDE_AUTO_FALLBACK_NOTICE);
            // Change the live session instead of replaying a prompt that may already be running.
            if (event.permissionMode !== 'acceptEdits') {
              fallbackRequestId = `systemsculpt-mode-${++nextRequest}`;
              write({ type: 'control_request', request_id: fallbackRequestId, request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } });
            }
          }
        }
        if (event.type === 'control_response' && isRecord(event.response) && event.response.request_id === fallbackRequestId) {
          if (event.response.subtype === 'error') finish({ error: new Error('Claude Code could not enable Accept edits. Choose Ask before edits or update Claude Code.') });
          fallbackRequestId = undefined;
          return;
        }
        if (event.type === 'assistant' || event.type === 'stream_event' || event.type === 'control_request') activityStarted = true;
        if (event.type === 'control_request' && typeof event.request_id === 'string' && isRecord(event.request)) {
          if (event.request.subtype === 'can_use_tool') answer(event.request_id, event.request);
          else write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: `SystemSculpt does not support ${String(event.request.subtype)}.` } });
          return;
        }
        if (event.type === 'control_cancel_request' && typeof event.request_id === 'string') { prompts.get(event.request_id)?.abort(); prompts.delete(event.request_id); return; }
        // Native ids match tool results even when the tool belongs to a subagent. Only main-conversation text becomes the reply.
        if ((event.type === 'assistant' || event.type === 'user') && isRecord(event.message)) {
          for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
            if (!isRecord(block)) continue;
            if (block.type === 'tool_use' && typeof block.id === 'string') callbacks.tool?.({ id: block.id, name: String(block.name), input: block.input, state: 'running' });
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') callbacks.tool?.({ id: block.tool_use_id, state: block.is_error === true ? 'failed' : 'succeeded', output: block.content });
          }
        }
        if (event.parent_tool_use_id) return;
        if (event.type === 'stream_event' && isRecord(event.event)) {
          const streamed = event.event;
          if (streamed.type === 'message_start') toolBlocks.clear();
          if (streamed.type === 'content_block_start') {
            partial = ''; partialLength = 0;
            if (isRecord(streamed.content_block) && streamed.content_block.type === 'tool_use' && typeof streamed.content_block.id === 'string') {
              const block = streamed.content_block;
              toolBlocks.set(Number(streamed.index), { id: String(block.id), name: String(block.name), inputText: '' });
              callbacks.tool?.({ id: String(block.id), name: String(block.name), input: block.input, state: 'input-streaming' });
            }
          }
          if (streamed.type === 'content_block_delta' && isRecord(streamed.delta) && streamed.delta.type === 'input_json_delta' && typeof streamed.delta.partial_json === 'string') {
            const block = toolBlocks.get(Number(streamed.index));
            if (block) { block.inputText += streamed.delta.partial_json; callbacks.tool?.({ id: block.id, name: block.name, inputText: block.inputText, state: 'input-streaming' }); }
          }
          if (streamed.type === 'content_block_stop') {
            const block = toolBlocks.get(Number(streamed.index));
            if (block) {
              let parsed: unknown;
              try { parsed = JSON.parse(block.inputText); } catch { /* The complete assistant tool_use supplies the canonical input. */ }
              callbacks.tool?.({ id: block.id, name: block.name, ...(parsed === undefined ? {} : { input: parsed }), state: 'running' });
              toolBlocks.delete(Number(streamed.index));
            }
          }
          if (streamed.type === 'content_block_delta' && isRecord(streamed.delta) && streamed.delta.type === 'text_delta' && typeof streamed.delta.text === 'string') {
            const separator = textLength ? '\n\n' : '';
            if (owner) callbacks.text?.((partialLength ? '' : separator) + streamed.delta.text, textLength + (partialLength ? separator.length + partialLength : 0));
            partialLength += streamed.delta.text.length;
            partial = (partial + streamed.delta.text).slice(-256_000);
            if (!owner) publish();
          }
          return;
        }
        if (event.type === 'assistant' && isRecord(event.message)) {
          if (event.error === 'rate_limit' || event.error === 'billing_error') {
            const content = Array.isArray(event.message.content) ? event.message.content : [];
            const notice = content.filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n\n');
            // The native error can follow streamed text; retract only that uncommitted tail.
            if (partialLength) { partial = ''; partialLength = 0; if (owner) callbacks.text?.('', textLength); else publish(); }
            finish({ error: new LocalAgentUsageLimitError(notice || 'Claude Code reported a usage or billing limit.') });
            return;
          }
          if (event.error === 'authentication_failed') signedOut = true;
          for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
            if (!isRecord(block)) continue;
            if (block.type === 'text' && typeof block.text === 'string' && !signedOut) {
              const segment = (textLength ? '\n\n' : '') + block.text;
              if (owner) callbacks.text?.(segment, textLength);
              textLength += segment.length; partialLength = 0;
              text = (text + (text ? '\n\n' : '') + block.text).slice(-256_000); partial = '';
              if (!owner) publish();
              callbacks.log(block.text.slice(-8000));
            } else if (block.type === 'tool_use') {
              callbacks.log(`Tool: ${toolSummary(String(block.name), block.input, input.workingDirectory)}`);
            }
          }
          return;
        }
        // The result holds the complete final answer; the streamed text also holds commentary and is capped.
        if (event.type === 'result') {
          if (signedOut) finish({ error: new Error(CLAUDE_SIGN_IN_MESSAGE) });
          else if (event.is_error === true || event.subtype !== 'success') {
            const detail = typeof event.result === 'string' && event.result ? event.result : Array.isArray(event.errors) ? event.errors.join(' ') : String(event.subtype);
            finish({ error: auto && !activityStarted && rejectsAutoMode(detail)
              ? new ClaudeAutoUnavailable('Claude Code rejected Auto mode before starting.')
              : new Error(`Claude Code did not finish: ${detail.slice(0, 2000)}`) });
          } else finish({ result: { sessionId, text: typeof event.result === 'string' ? event.result : text } });
        }
      };
      child.stdout.on('data', (chunk: string) => {
        // After cancellation or failure, buffered output must not reach the chat or open approval prompts.
        if (settled) return;
        buffer += chunk;
        if (buffer.length > MAX_LINE) { finish({ error: new Error('A Claude Code message exceeded 16 MiB.') }); return; }
        let newline: number;
        while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let event: unknown;
          try { event = JSON.parse(line); } catch { finish({ error: new Error('Claude Code sent an unreadable response. Update Claude Code with `claude update`.') }); return; }
          if (isRecord(event)) receive(event);
        }
      });
      if (owner) {
        connection = {
          sessionId, key: claudeConnectionKey(input),
          next: (nextInput, nextSignal, nextCallbacks) => {
            if (!settled || closing) return Promise.reject(new Error('Claude Code session is not ready for another turn.'));
            if (nextSignal.aborted) return Promise.reject(new Error('Claude Code run canceled.'));
            const nextMessage = userMessage(nextInput.prompt, nextInput.images || []);
            return new Promise<ClaudeResult>((nextResolve, nextReject) => {
              input = nextInput; signal = nextSignal; callbacks = nextCallbacks; resolve = nextResolve; reject = nextReject;
              buffer = ''; stderr = ''; text = ''; partial = ''; textLength = 0; partialLength = 0; signedOut = false; outcome = undefined; settled = false; toolBlocks.clear();
              signal.addEventListener('abort', abort, { once: true });
              write(nextMessage);
            });
          },
          close: () => { if (!settled) abort(); return closeProcess(); },
        };
        owner.connection = connection; retained = true;
      }
      write(message);
    });
  } finally {
    if (!retained) activeSessions.delete(sessionId);
  }
}

export function claudeOptionsFromSettings(settings: { claudeModel?: string; claudePermissionMode?: string }): ReturnType<typeof resolveClaudeOptions> {
  return resolveClaudeOptions({ model: settings.claudeModel, permissionMode: settings.claudePermissionMode });
}
