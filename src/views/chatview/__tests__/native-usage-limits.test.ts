/** @jest-environment jsdom */
import { EventEmitter } from 'node:events';
import { posix } from 'node:path';
import { App } from 'obsidian';
import { desktopHost } from '../../../platform/desktopOnly';
import { ClaudeChatSession } from '../../../services/claude/ClaudeChatSession';
import { CodexChatSession } from '../../../services/codex/CodexChatSession';
import { AgentConversationRenderer } from '../AgentConversationRenderer';
import { presentAgentConversation } from '../AgentConversationPresentation';

jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { childProcess: jest.fn(), fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn() } }));
jest.mock('../../../services/codex/CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn(() => ({ read: jest.fn(), write: jest.fn() })) }));
jest.mock('../../../services/codex/CodexExecutionSettings', () => ({
  ...jest.requireActual('../../../services/codex/CodexExecutionSettings'),
  localAgentChatDirectory: jest.fn(async () => '/vault'),
}));

const SESSION = 'b33728f4-ea7d-4fec-bcd0-bf79649b7d28';
const NOTICE = "You've hit your limit · resets Oct 25 at 2pm (America/Los_Angeles)";
const PARTIAL = 'I checked the first note.';
const cases = [
  { agent: 'claude', name: 'Claude Code', code: 'rate_limit' },
  { agent: 'claude', name: 'Claude Code', code: 'billing_error' },
  { agent: 'codex', name: 'Codex', code: 'usageLimitExceeded' },
];

/** Replay public native JSON at stdio; the real transports, sessions and renderer stay connected. */
function nativeHost(agent: string, code: string, partial: boolean, options: { streamedNotice?: boolean; earlyClose?: boolean; pendingText?: string } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() }), kill: jest.fn(),
  });
  const close = () => queueMicrotask(() => child.emit('close', 0));
  child.stdin.end.mockImplementation(close); child.kill.mockImplementation(close);
  const send = (value: unknown) => child.stdout.emit('data', `${JSON.stringify(value)}\n`);
  child.stdin.write.mockImplementation((line: string) => {
    const message = JSON.parse(line);
    queueMicrotask(() => {
      if (agent === 'claude' && message.type === 'user') {
        send({ type: 'system', subtype: 'init', session_id: SESSION, permissionMode: 'auto' });
        if (partial) send({ type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: PARTIAL }] } });
        for (const text of [options.pendingText, options.streamedNotice ? NOTICE : ''].filter(Boolean)) {
          send({ type: 'stream_event', session_id: SESSION, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
        }
        send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, error: code, message: { content: [{ type: 'text', text: NOTICE }] } });
        if (options.earlyClose) child.emit('close', 1);
        else send({ type: 'result', session_id: SESSION, subtype: 'success', is_error: true, result: NOTICE });
      }
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'native-thread' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'native-turn' } } });
        if (partial) send({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'reply', type: 'agentMessage', text: PARTIAL } } });
        send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'failed', error: { message: NOTICE, codexErrorInfo: code } } } });
      }
    });
    return true;
  });
  (desktopHost.childProcess as jest.Mock).mockResolvedValue({ spawn: jest.fn(() => child) });
  (desktopHost.fs as jest.Mock).mockResolvedValue({ readdir: jest.fn(async () => []), stat: jest.fn(async () => ({ isDirectory: () => true, isFile: () => false })), readFile: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })) });
  (desktopHost.path as jest.Mock).mockResolvedValue(posix);
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => '/home/test', platform: () => 'darwin' });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/bin', HOME: '/home/test' });
}

const input = { conversationId: 'conversation', turnId: 'turn', message: { id: 'turn', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Check my notes' }] } };
let uuid: jest.SpyInstance;
beforeEach(() => { jest.clearAllMocks(); uuid = jest.spyOn(window.crypto, 'randomUUID').mockReturnValue(SESSION); });
afterEach(() => { uuid.mockRestore(); document.body.empty(); });

it.each(cases.flatMap(native => [false, true].map(partial => ({ ...native, partial }))))(
  'shows $code as a limit with the hosted action, preserving only real work (partial: $partial)',
  async ({ agent, name, code, partial }) => {
    nativeHost(agent, code, partial);
    const app = new App(), persistAssistant = jest.fn(async () => {}), onUseHosted = jest.fn(), onRetryFailedTurn = jest.fn();
    const session = agent === 'claude' ? new ClaudeChatSession(app, { persistAssistant }) : new CodexChatSession(app, { persistAssistant });
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, { app, sourcePath: () => '', backendName: () => name,
      onUseHosted, onRetryFailedTurn, onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(), onCopyText: jest.fn() });
    renderer.load();
    try {
      await expect(session.start(input)).resolves.toMatchObject({ kind: 'failed', error: { code: `local_${agent}_usage_limit`, message: NOTICE, retryable: false } });
      const snapshot = session.getSnapshot();
      await renderer.renderActive(snapshot, presentAgentConversation(snapshot, false));
      expect(parent.querySelector('.systemsculpt-agent-error-heading')?.textContent).toBe(`${name} usage limit reached`);
      expect(parent.querySelector('.systemsculpt-agent-error-message')?.textContent).toBe(NOTICE);
      expect(parent.querySelector('[data-testid="chat.turn.error-details"]')).toBeNull();
      expect(parent.querySelector('[data-testid="chat.turn.retry-failed"]')).toBeNull();
      const hosted = parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.use-hosted"]');
      expect(hosted?.textContent).toBe('Use SystemSculpt instead');
      hosted!.click();
      expect(onUseHosted).toHaveBeenCalledTimes(1); expect(onRetryFailedTurn).not.toHaveBeenCalled();
      expect(snapshot.parts.filter(part => part.kind === 'text').map(part => part.markdown).join('')).toBe(partial ? PARTIAL : '');
      expect(JSON.stringify(persistAssistant.mock.calls)).not.toContain(NOTICE);
      if (partial) expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: PARTIAL, terminalOutcome: 'failed' }));
      else expect(persistAssistant).not.toHaveBeenCalled();
    } finally { renderer.unload(); await session.detach(); }
  },
);

it.each(['rate_limit', 'billing_error'].flatMap(code => [false, true].map(partial => ({ code, partial }))))(
  'retracts a streamed $code notice even if Claude exits before its result (partial: $partial)', async ({ code, partial }) => {
    nativeHost('claude', code, partial, { streamedNotice: true, earlyClose: true });
    const persistAssistant = jest.fn(async () => {}), session = new ClaudeChatSession(new App(), { persistAssistant });
    try {
      await expect(session.start(input)).resolves.toMatchObject({ kind: 'failed', error: { code: 'local_claude_usage_limit', message: NOTICE, retryable: false } });
      if (partial) expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: PARTIAL }));
      else expect(persistAssistant).not.toHaveBeenCalled();
      expect(JSON.stringify(persistAssistant.mock.calls)).not.toContain(NOTICE);
    } finally { await session.detach(); }
  },
);

it.each([false, true])('preserves genuine unfinished text before a limit (streamed notice: %s)', async streamedNotice => {
  const pendingText = 'The second note contains three broken links.';
  nativeHost('claude', 'rate_limit', true, { pendingText, streamedNotice });
  const persistAssistant = jest.fn(async () => {}), session = new ClaudeChatSession(new App(), { persistAssistant });
  try {
    await expect(session.start(input)).resolves.toMatchObject({ kind: 'failed', error: { code: 'local_claude_usage_limit' } });
    expect(persistAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: `${PARTIAL}\n\n${pendingText}`, terminalOutcome: 'failed' }));
    expect(JSON.stringify(persistAssistant.mock.calls)).not.toContain(NOTICE);
  } finally { await session.detach(); }
});

it.each(['rateLimitExceeded', 'other'])('does not infer a Codex plan limit from prose when the native code is %s', async code => {
  nativeHost('codex', code, false);
  const session = new CodexChatSession(new App(), { persistAssistant: jest.fn() });
  try { await expect(session.start(input)).resolves.toMatchObject({ kind: 'failed', error: { code: 'local_codex_failed', retryable: true } }); }
  finally { await session.detach(); }
});
