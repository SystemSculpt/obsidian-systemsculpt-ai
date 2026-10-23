import { EventEmitter } from 'node:events';
import { CLAUDE_SIGN_IN_MESSAGE, claudeLaunchArgs, runLocalClaude } from '../LocalClaudeClient';
import { desktopHost } from '../../../platform/desktopOnly';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { childProcess: jest.fn(), fs: jest.fn(), os: jest.fn(), path: jest.fn(), environment: jest.fn() } }));

const SESSION = 'b33728f4-ea7d-4fec-bcd0-bf79649b7d28';
type Script = (send: (value: unknown) => void, message: any, child: any) => void;
function host(options: { config?: unknown; spawnError?: string; script?: Script } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }), stderr: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() }), kill: jest.fn(),
  });
  // Like the real CLI, closing stdin ends the process.
  child.stdin.end.mockImplementation(() => queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }));
  const messages: any[] = [];
  const send = (value: unknown) => child.stdout.emit('data', JSON.stringify(value) + '\n');
  const reply = (text: string) => {
    send({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-test' });
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0 }, session_id: SESSION, parent_tool_use_id: null });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }, session_id: SESSION, parent_tool_use_id: null });
    send({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SESSION, parent_tool_use_id: null });
    send({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SESSION });
  };
  child.stdin.write.mockImplementation((line: string) => {
    const message = JSON.parse(line); messages.push(message);
    queueMicrotask(() => (options.script ?? ((_send, msg) => { if (msg.type === 'user') reply('hello there'); }))(send, message, child));
    return true;
  });
  const spawn = jest.fn(() => {
    if (options.spawnError) queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: options.spawnError })));
    return child;
  });
  (desktopHost.childProcess as jest.Mock).mockResolvedValue({ spawn });
  (desktopHost.fs as jest.Mock).mockResolvedValue({ stat: jest.fn(async () => ({ isDirectory: () => true })),
    readFile: options.config === undefined ? jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })) : jest.fn(async () => JSON.stringify(options.config)) });
  (desktopHost.path as jest.Mock).mockResolvedValue({ isAbsolute: (path: string) => path.startsWith('/'), delimiter: ':', join: (...parts: string[]) => parts.join('/') });
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => '/home/test' });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/bin', HOME: '/home/test', CLAUDECODE: '1' });
  return { child, messages, send, reply, spawn };
}
const callbacks = (allow = true) => ({ session: jest.fn(), log: jest.fn(), text: jest.fn(), permission: jest.fn(async () => allow) });
const input = { prompt: 'Read note.md', workingDirectory: '/vault' };
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => SESSION });
});

describe('launch arguments', () => {
  it('streams JSON both ways, routes permission prompts to the plugin and asks before edits by default', () => {
    const args = claudeLaunchArgs({});
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default']);
    expect(args.join(' ')).not.toMatch(/bypass|dangerously/i);
  });
  it('leaves the mode to Claude Code settings, passes the model and resumes a saved session', () => {
    expect(claudeLaunchArgs({ permissionMode: 'settings', model: 'opus' }, SESSION)).toEqual(expect.arrayContaining(['--model', 'opus', '--resume', SESSION]));
    expect(claudeLaunchArgs({ permissionMode: 'settings' })).not.toContain('--permission-mode');
    expect(claudeLaunchArgs({ permissionMode: 'acceptEdits' })).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
  });
  it('rejects bypass, unknown modes, odd models and unsafe session identities', () => {
    expect(() => claudeLaunchArgs({ permissionMode: 'bypassPermissions' })).toThrow('Invalid Claude Code permission mode.');
    expect(() => claudeLaunchArgs({ model: '--dangerously-skip-permissions' })).toThrow('Invalid Claude Code model.');
    expect(() => claudeLaunchArgs({}, '--resume')).toThrow('Invalid saved Claude Code session identity.');
  });
});

describe('discovery', () => {
  it('runs the installed claude in the vault with a GUI-safe PATH and no nested-session marker', async () => {
    const { spawn, messages, child } = host(), cb = callbacks();
    await expect(runLocalClaude(input, new AbortController().signal, cb)).resolves.toEqual({ sessionId: SESSION, text: 'hello there' });
    expect(spawn).toHaveBeenCalledWith('claude', expect.arrayContaining(['-p', '--permission-prompt-tool', 'stdio']), expect.objectContaining({ cwd: '/vault' }));
    const env = (spawn.mock.calls[0] as any[])[2].env;
    expect(env.CLAUDECODE).toBeUndefined(); expect(env.PATH.split(':')).toEqual(expect.arrayContaining(['/bin', '/opt/homebrew/bin', '/home/test/.local/bin']));
    expect(messages[0]).toEqual({ type: 'user', message: { role: 'user', content: 'Read note.md' } });
    expect(child.stdin.end).toHaveBeenCalled();
  });
  it('uses the binary from ~/.config/systemsculpt/claude.json', async () => {
    const { spawn } = host({ config: { binary: '~/tools/claude' } });
    await runLocalClaude(input, new AbortController().signal, callbacks());
    expect(spawn).toHaveBeenCalledWith('/home/test/tools/claude', expect.any(Array), expect.any(Object));
    const fs = await desktopHost.fs();
    expect(fs.readFile).toHaveBeenCalledWith('/home/test/.config/systemsculpt/claude.json', 'utf8');
    expect((fs.readFile as jest.Mock).mock.calls.some(([path]) => String(path).includes('/.claude'))).toBe(false);
  });
  it('explains how to install Claude Code when the binary is missing', async () => {
    host({ spawnError: 'ENOENT' });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).rejects.toThrow(/not installed.*Install Claude Code, then run `claude` and type \/login.*\/home\/test\/\.config\/systemsculpt\/claude\.json/);
  });
});

describe('stream', () => {
  it('streams partial text, saves the session identity and returns the main reply only', async () => {
    host({ script: (send, msg) => {
      if (msg.type !== 'user') return;
      send({ type: 'system', subtype: 'init', session_id: SESSION });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'subagent noise' }] }, session_id: SESSION, parent_tool_use_id: 'toolu_1' });
      send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/vault/note.md' } }] }, session_id: SESSION, parent_tool_use_id: null });
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }, session_id: SESSION, parent_tool_use_id: null });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }] }, session_id: SESSION, parent_tool_use_id: null });
      send({ type: 'result', subtype: 'success', is_error: false, result: 'Hello.', session_id: SESSION });
    } });
    const cb = callbacks();
    await expect(runLocalClaude(input, new AbortController().signal, cb)).resolves.toEqual({ sessionId: SESSION, text: 'Hello.' });
    expect(cb.session).toHaveBeenCalledWith(SESSION); expect(cb.text).toHaveBeenCalledWith('Hel'); expect(cb.text).toHaveBeenLastCalledWith('Hello.');
    expect(cb.log).toHaveBeenCalledWith('Tool: Read note.md');
  });
  it('sends images as base64 blocks next to the text', async () => {
    const { messages } = host();
    await runLocalClaude({ ...input, images: ['data:image/png;base64,iVBORw0KGgo='] }, new AbortController().signal, callbacks());
    expect(messages[0].message.content).toEqual([{ type: 'text', text: 'Read note.md' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]);
  });
  it('says plainly how to sign in when Claude Code is signed out', async () => {
    host({ script: (send, msg) => {
      if (msg.type !== 'user') return;
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', session_id: SESSION, parent_tool_use_id: null });
      send({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: SESSION });
    } });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).rejects.toThrow(CLAUDE_SIGN_IN_MESSAGE);
    expect(CLAUDE_SIGN_IN_MESSAGE).toContain('run `claude`, then type /login');
  });
  it('reports a failed turn and an early exit with the CLI output', async () => {
    host({ script: (send, msg) => { if (msg.type === 'user') send({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: SESSION }); } });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).rejects.toThrow('Claude Code did not finish: error_max_turns');
    host({ script: (_send, msg, child) => { if (msg.type === 'user') { child.stderr.emit('data', 'boom'); child.emit('exit', 1); child.emit('close', 1); } } });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).rejects.toThrow('Claude Code stopped before finishing. boom');
  });
});

describe('native lifecycle', () => {
  it('names a new session up front and saves it only once Claude Code confirms it', async () => {
    const { spawn } = host({ spawnError: 'ENOENT' }), missing = callbacks();
    await expect(runLocalClaude(input, new AbortController().signal, missing)).rejects.toThrow(/not installed/);
    expect((spawn.mock.calls[0] as any[])[1]).toEqual(expect.arrayContaining(['--session-id', SESSION]));
    expect(missing.session).not.toHaveBeenCalled();
    host(); const failing = callbacks();
    failing.session.mockRejectedValue(new Error('disk full'));
    await expect(runLocalClaude(input, new AbortController().signal, failing)).rejects.toThrow('disk full');
  });
  it('rejects an event from a different session', async () => {
    host({ script: (send, msg) => { if (msg.type === 'user') send({ type: 'system', subtype: 'init', session_id: 'c44839f5-fb8e-4fed-8de1-cf8a75a8e839' }); } });
    const cb = callbacks();
    await expect(runLocalClaude(input, new AbortController().signal, cb)).rejects.toThrow('different session identity');
    expect(cb.session).not.toHaveBeenCalled();
  });
  it('excludes overlapping resumes until the first process closes', async () => {
    const { child, messages, reply } = host({ script: () => {} });
    const first = runLocalClaude({ ...input, sessionId: SESSION }, new AbortController().signal, callbacks());
    for (let i = 0; i < 40 && !messages.length; i++) await Promise.resolve();
    await expect(runLocalClaude({ ...input, sessionId: SESSION }, new AbortController().signal, callbacks())).rejects.toThrow(/already running/);
    reply('done');
    await first;
    expect(child.stdin.end).toHaveBeenCalled();
  });
  it('waits for stdio close rather than failing at process exit', async () => {
    host({ script: (send, msg, child) => {
      if (msg.type !== 'user') return;
      child.emit('exit', 0);
      send({ type: 'result', subtype: 'success', result: 'final', session_id: SESSION });
      child.emit('close', 0);
    } });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).resolves.toMatchObject({ text: 'final' });
  });
  it('returns the terminal answer, not commentary or a truncated suffix', async () => {
    const final = 'x'.repeat(260_000);
    host({ script: (send, msg) => {
      if (msg.type !== 'user') return;
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] }, session_id: SESSION });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: final }] }, session_id: SESSION });
      send({ type: 'result', subtype: 'success', result: final, session_id: SESSION });
    } });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).resolves.toMatchObject({ text: final });
  });
  it('ignores buffered callbacks after cancellation and waits for process closure', async () => {
    const { child, send, messages } = host({ script: () => {} });
    child.stdin.end.mockImplementation(() => {});
    const cb = callbacks(), controller = new AbortController();
    let finished = false;
    const running = runLocalClaude(input, controller.signal, cb).finally(() => { finished = true; });
    void running.catch(() => {});
    for (let i = 0; i < 40 && !messages.length; i++) await Promise.resolve();
    controller.abort();
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } });
    send({ type: 'control_request', request_id: 'late', request: { subtype: 'can_use_tool', tool_name: 'Edit' } });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    expect(cb.text).not.toHaveBeenCalled(); expect(cb.permission).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(running).rejects.toThrow('canceled');
  });
});

describe('permissions', () => {
  const edit = { type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Edit', description: 'note.md', input: { file_path: '/vault/note.md', old_string: 'a', new_string: 'b' } } };
  const permissionScript = (extra?: (send: (value: unknown) => void) => void): Script => (send, msg) => {
    if (msg.type === 'user') { send({ type: 'system', subtype: 'init', session_id: SESSION }); send(edit); extra?.(send); }
    if (msg.type === 'control_response' && msg.response.request_id === 'req-1') send({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION });
  };
  it('forwards an approved edit with its unchanged input', async () => {
    const { messages } = host({ script: permissionScript() }), cb = callbacks(true);
    await runLocalClaude(input, new AbortController().signal, cb);
    expect(cb.permission).toHaveBeenCalledWith({ toolName: 'Edit', description: 'note.md', input: edit.request.input }, expect.any(AbortSignal));
    expect(messages.find(m => m.type === 'control_response').response).toEqual({ subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: edit.request.input } });
  });
  it('denies a declined edit', async () => {
    const { messages } = host({ script: permissionScript() });
    await runLocalClaude(input, new AbortController().signal, callbacks(false));
    expect(messages.find(m => m.type === 'control_response').response.response).toEqual({ behavior: 'deny', message: 'The user declined this action in SystemSculpt.' });
  });
  it('declines interactive questions and unsupported control requests without prompting', async () => {
    const { messages } = host({ script: (send, msg) => {
      if (msg.type !== 'user') return;
      send({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } });
      send({ type: 'control_request', request_id: 'hook', request: { subtype: 'hook_callback' } });
      send({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION });
    } }), cb = callbacks();
    await runLocalClaude(input, new AbortController().signal, cb);
    expect(cb.permission).not.toHaveBeenCalled();
    expect(messages.find(m => m.response?.request_id === 'ask').response.response.behavior).toBe('deny');
    expect(messages.find(m => m.response?.request_id === 'hook').response.subtype).toBe('error');
  });
  it('closes the prompt when Claude Code withdraws it, and interrupts on cancel', async () => {
    let promptSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const { messages } = host({ script: (send, msg) => { if (msg.type === 'user') { send(edit); send({ type: 'control_cancel_request', request_id: 'req-1' }); } } });
    const cb = { ...callbacks(), permission: jest.fn((_request, signal: AbortSignal) => { promptSignal = signal; return new Promise<boolean>(() => {}); }) };
    const running = runLocalClaude(input, controller.signal, cb);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(promptSignal?.aborted).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow('Claude Code run canceled.');
    expect(messages.some(m => m.type === 'control_request' && m.request.subtype === 'interrupt')).toBe(true);
  });
});
