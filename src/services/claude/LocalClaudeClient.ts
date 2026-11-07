import { resolveClaudeOptions, type ClaudeExecutionOptions } from './ClaudeExecutionOptions';
import { NativeTurnText } from '../codex/NativeTurnText';
import { desktopHost } from '../../platform/desktopOnly';
import { isRecord } from '../../utils/jsonRecord';
import { readLocalAgentLaunchConfig, resolveLocalAgentCommand } from '../codex/LocalAgentLaunch';
import { LocalAgentUsageLimitError } from '../codex/LocalAgents';
import type { SystemSculptToolset } from '../../tools/systemsculpt/SystemSculptTools';
import { answerClaudeToolBridgeMessage, claudeToolBridgeArgs, claudeToolBridgeInitialize, isClaudeToolBridgeMessage } from './ClaudeToolBridge';

export type ClaudeRequest = ClaudeExecutionOptions & { prompt: string; workingDirectory: string; sessionId?: string; images?: readonly string[]; tools?: SystemSculptToolset; pluginVersion?: string };
export type ClaudeResult = { sessionId: string; text: string };
export type ClaudePermissionRequest = {
  toolName: string; description: string; input: Record<string, unknown>;
  requestId?: string; toolUseId?: string; permissionSuggestions?: readonly Record<string, unknown>[];
};
type ClaudePermissionDecision = boolean | { approved: boolean; rememberForSession?: boolean; answers?: Record<string, string[]> };
type ClaudeToolActivity = {
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

/**
 * Claude Code 2.1.309's public PermissionResult / PermissionUpdate protocol. No settings writes.
 * @internal Unit-tested directly.
 */
export function claudePermissionResponse(request: ClaudePermissionRequest, decision: ClaudePermissionDecision): Record<string, unknown> {
  const approved = typeof decision === 'boolean' ? decision : decision.approved;
  if (!approved) return { behavior: 'deny', message: 'The user declined this action in SystemSculpt.' };
  const updatedInput = request.toolName === 'AskUserQuestion' && typeof decision !== 'boolean' && decision.answers
    ? { ...request.input, answers: Object.fromEntries(Object.entries(decision.answers).map(([question, answers]) => [question, answers.join(', ')])) } : request.input;
  const updates = typeof decision !== 'boolean' && decision.rememberForSession
    ? claudeSessionPermissionUpdates(request) : undefined;
  return { behavior: 'allow', updatedInput, ...(updates?.length ? { updatedPermissions: updates } : {}) };
}

/** @internal Tests assert against this value. */
export const CLAUDE_SIGN_IN_MESSAGE = 'Claude Code is not signed in. Open a terminal, run `claude`, then type /login. Send your message again after signing in.';
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
const MAX_LINE = 16 * 1024 * 1024;
const activeSessions = new Set<string>();
const CLAUDE_AUTO_FALLBACK_NOTICE = "Claude Code's Auto mode isn't available here, so edits are accepted automatically and other actions ask. Update Claude Code to use Auto.";
class ClaudeAutoUnavailable extends Error {}
function rejectsAutoMode(message: string): boolean {
  return /(?:permission.?mode[^\n]*auto|auto[^\n]*(?:mode|permission))/i.test(message)
    && /invalid|unsupported|not (?:available|supported|allowed|enabled)|unavailable|not eligible|requires|choices|cannot use/i.test(message);
}


/**
 * Print mode with JSON streams on both ends; permission prompts come back to the plugin over stdio.
 * @internal Unit-tested directly.
 */
export function claudeLaunchArgs(options: ClaudeExecutionOptions, sessionId?: string, withTools = false): string[] {
  const { model, permissionMode } = resolveClaudeOptions(options);
  if (sessionId !== undefined && !SESSION_PATTERN.test(sessionId)) throw new Error('Invalid saved Claude Code session identity.');
  return ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    // "settings" leaves the mode to Claude Code's own configuration.
    ...(permissionMode === 'settings' ? [] : ['--permission-mode', permissionMode]),
    ...(model ? ['--model', model] : []),
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(withTools ? claudeToolBridgeArgs(permissionMode) : [])];
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
const claudeConnectionKey = (input: ClaudeRequest) => JSON.stringify([input.workingDirectory, resolveClaudeOptions(input), Boolean(input.tools)]);

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
  const args = claudeLaunchArgs(input, input.sessionId, Boolean(input.tools));
  const message = userMessage(input.prompt, input.images || []);
  if (signal.aborted) throw new Error('Claude Code run canceled.');
  const [childProcess, fs, path] = await Promise.all([desktopHost.childProcess(), desktopHost.fs(), desktopHost.path()]);
  if (!path.isAbsolute(input.workingDirectory) || !(await fs.stat(input.workingDirectory)).isDirectory()) throw new Error('Claude Code requires an existing absolute working directory.');
  const launch = await readLocalAgentLaunchConfig('claude', 'Claude Code');
  const binary = launch.setting('binary', 'claude');
  // A plugin turn is a top-level session even when Obsidian was opened from a Claude Code terminal.
  const environment = { ...launch.environment }; delete environment.CLAUDECODE;
  // Native idle includes background agents and their notification turns, but not long-lived shell servers.
  // A result alone only ends the main agent's current turn, not a resumed subagent's work.
  environment.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  environment.CLAUDE_CODE_BG_TASKS_REPORT_RUNNING = '1';
  // A new session gets its identity up front, so every event can be checked against it.
  const sessionId = input.sessionId || window.crypto.randomUUID();
  if (!input.sessionId) args.push('--session-id', sessionId);
  const command = await resolveLocalAgentCommand(binary, args, environment, input.workingDirectory);
  if (signal.aborted) throw new Error('Claude Code run canceled.');
  if (activeSessions.has(sessionId)) throw new Error('This Claude Code session is already running in another Studio or chat view.');
  activeSessions.add(sessionId);
  let retained = false;
  try {
    const child = childProcess.spawn(command.binary, command.args, { cwd: input.workingDirectory, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const prompts = new Map<string, AbortController>();
      const toolCalls = new Map<string, AbortController>();
      const toolBlocks = new Map<number, { id: string; name: string; inputText: string }>();
      let buffer = '', stderr = '', settled = false, signedOut = false, nextRequest = 0;
      let initialized = false, activityStarted = false, pipeFailure = false, fallbackRequestId: string | undefined;
      const auto = resolveClaudeOptions(input).permissionMode === 'auto';
      const text = new NativeTurnText({ mode: owner ? 'offsets' : 'snapshot', snapshot: 'joined-segments' }, (...update) => callbacks.text?.(...update));
      // A new identity is saved once Claude Code confirms it, so a launch that never started cannot leave a chat resuming a missing session.
      let saving: Promise<void> | undefined = input.sessionId ? Promise.resolve() : undefined;
      let outcome: { result?: ClaudeResult; error?: Error } | undefined;
      let nativeState: 'running' | 'requires_action' | 'idle' | undefined;
      let pendingResult: ClaudeResult | undefined;
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
      const finish = (value: { result?: ClaudeResult; error?: Error }) => {
        if (settled) { if (value.error && owner) void closeProcess(); return; }
        outcome = value; settled = true; signal.removeEventListener('abort', abort);
        for (const prompt of prompts.values()) prompt.abort(); prompts.clear();
        for (const call of toolCalls.values()) call.abort(); toolCalls.clear();
        if (owner && value.result && saving) {
          // Keep native session grants alive between successful chat turns. Studio still closes below.
          void saving.then(() => resolve(value.result!), error => { outcome = { error }; void closeProcess(); });
        } else void closeProcess();
      };
      const finishWhenIdle = () => {
        // Older CLIs without state events retain the result-only protocol.
        if (pendingResult && (nativeState === undefined || nativeState === 'idle')) finish({ result: pendingResult });
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
      const callTool = (requestId: string, message: Record<string, unknown>) => {
        const tools = input.tools!, controller = new AbortController();
        toolCalls.set(requestId, controller);
        const stop = () => controller.abort();
        signal.addEventListener('abort', stop, { once: true });
        void answerClaudeToolBridgeMessage(tools, message, input.pluginVersion ?? '0', controller.signal)
          .catch(error => ({ jsonrpc: '2.0', id: message.id ?? 0, error: { code: -32603, message: error instanceof Error ? error.message : 'SystemSculpt tool failed.' } }))
          .then(response => {
            signal.removeEventListener('abort', stop);
            if (toolCalls.get(requestId) !== controller || !toolCalls.delete(requestId) || controller.signal.aborted) return;
            write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { mcp_response: response } } });
          });
      };
      const receive = (event: Record<string, unknown>) => {
        if (typeof event.session_id === 'string') {
          if (event.session_id !== sessionId) { finish({ error: new Error('Claude Code returned a different session identity.') }); return; }
          if (!saving) {
            saving = Promise.resolve().then(() => callbacks.session(sessionId));
            saving.catch(error => finish({ error: error instanceof Error ? error : new Error(String(error)) }));
          }
        }
        if (event.type === 'system' && event.subtype === 'session_state_changed'
          && (event.state === 'running' || event.state === 'requires_action' || event.state === 'idle')) {
          nativeState = event.state;
          finishWhenIdle();
          return;
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
        // The tool server handshake runs at startup; only model activity counts.
        if (event.type === 'assistant' || event.type === 'stream_event' || event.type === 'control_request' && !(isRecord(event.request) && event.request.subtype === 'mcp_message')) activityStarted = true;
        if (event.type === 'control_request' && typeof event.request_id === 'string' && isRecord(event.request)) {
          if (event.request.subtype === 'can_use_tool') answer(event.request_id, event.request);
          else if (input.tools && isClaudeToolBridgeMessage(event.request)) callTool(event.request_id, event.request.message as Record<string, unknown>);
          else write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: `SystemSculpt does not support ${String(event.request.subtype)}.` } });
          return;
        }
        if (event.type === 'control_cancel_request' && typeof event.request_id === 'string') {
          prompts.get(event.request_id)?.abort(); prompts.delete(event.request_id);
          toolCalls.get(event.request_id)?.abort(); toolCalls.delete(event.request_id);
          return;
        }
        // Native ids match tool results even when the tool belongs to a subagent. Only main-conversation text becomes the reply.
        if ((event.type === 'assistant' || event.type === 'user') && isRecord(event.message)) {
          for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
            if (!isRecord(block)) continue;
            if (block.type === 'tool_use' && typeof block.id === 'string') callbacks.tool?.({ id: block.id, name: String(block.name), input: block.input, state: 'running' });
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') callbacks.tool?.({ id: block.tool_use_id, state: block.is_error === true ? 'failed' : 'succeeded', output: block.content });
          }
        }
        if (event.parent_tool_use_id) return;
        // A notification can start another native turn after an interim result. Its idle and result
        // can arrive in either order; never settle that turn with the previous turn's result.
        if (event.type === 'assistant' || event.type === 'stream_event'
          || event.type === 'user' && isRecord(event.origin) && event.origin.kind === 'task-notification') pendingResult = undefined;
        if (event.type === 'stream_event' && isRecord(event.event)) {
          const streamed = event.event;
          if (streamed.type === 'message_start') toolBlocks.clear();
          if (streamed.type === 'content_block_start') {
            text.startSegment();
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
            text.append(streamed.delta.text);
          }
          return;
        }
        if (event.type === 'assistant' && isRecord(event.message)) {
          if (event.error === 'rate_limit' || event.error === 'billing_error') {
            const content = Array.isArray(event.message.content) ? event.message.content : [];
            const notice = content.filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n\n');
            // Retract only text matching the native notice, not genuine unfinished output.
            const partial = text.partialText, partialLength = text.partialLength;
            const noticeLength = partial && notice
              ? partialLength === partial.length && notice.startsWith(partial) ? partialLength : partial.endsWith(notice) ? notice.length : 0
              : 0;
            if (noticeLength) text.retractPartial(noticeLength);
            finish({ error: new LocalAgentUsageLimitError(notice || 'Claude Code reported a usage or billing limit.') });
            return;
          }
          if (event.error === 'authentication_failed') signedOut = true;
          for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
            if (!isRecord(block)) continue;
            if (block.type === 'text' && typeof block.text === 'string' && !signedOut) {
              text.complete(block.text);
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
          } else {
            // Batched task notifications emit zero-turn placeholders before the result
            // carrying their shared answer. Even an idle event must not settle on one.
            if (event.num_turns === 0 && event.result === '' && isRecord(event.origin) && event.origin.kind === 'task-notification') {
              pendingResult = undefined;
              return;
            }
            pendingResult = { sessionId, text: typeof event.result === 'string' ? event.result : text.text };
            finishWhenIdle();
          }
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
              buffer = ''; stderr = ''; text.reset(); signedOut = false; outcome = undefined; settled = false; toolBlocks.clear();
              pendingResult = undefined;
              if (nativeState !== undefined) nativeState = 'running';
              signal.addEventListener('abort', abort, { once: true });
              write(nextMessage);
            });
          },
          close: () => { if (!settled) abort(); return closeProcess(); },
        };
        owner.connection = connection; retained = true;
      }
      if (input.tools) write(claudeToolBridgeInitialize(`systemsculpt-init-${++nextRequest}`));
      write(message);
    });
  } finally {
    if (!retained) activeSessions.delete(sessionId);
  }
}
