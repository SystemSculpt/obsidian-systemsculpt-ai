import { EventEmitter } from 'node:events';
import { posix } from 'node:path';
import { CLAUDE_SIGN_IN_MESSAGE, ClaudeChatTransport, claudeLaunchArgs, claudePermissionResponse, runLocalClaude } from '../LocalClaudeClient';
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
  (desktopHost.fs as jest.Mock).mockResolvedValue({ readdir: jest.fn(async () => []), stat: jest.fn(async () => ({ isDirectory: () => true, isFile: () => false })),
    readFile: options.config === undefined ? jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })) : jest.fn(async () => JSON.stringify(options.config)) });
  (desktopHost.path as jest.Mock).mockResolvedValue(posix);
  (desktopHost.os as jest.Mock).mockResolvedValue({ homedir: () => '/home/test', platform: () => 'darwin' });
  (desktopHost.environment as jest.Mock).mockReturnValue({ PATH: '/bin', HOME: '/home/test', CLAUDECODE: '1' });
  return { child, messages, send, reply, spawn };
}
const callbacks = (allow = true) => ({ session: jest.fn(), log: jest.fn(), text: jest.fn(), permission: jest.fn(async () => allow) });
const input = { prompt: 'Read note.md', workingDirectory: '/vault' };
// window.crypto is shared by every test file in a worker, so the stub must not outlive this one.
let uuid: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  uuid = jest.spyOn(window.crypto, 'randomUUID').mockReturnValue(SESSION);
});
afterEach(() => uuid.mockRestore());

describe('launch arguments', () => {
  it('streams JSON both ways, routes permission prompts to the plugin and uses Auto by default', () => {
    const args = claudeLaunchArgs({});
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'auto']);
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

describe('Auto compatibility', () => {
  it.each(['auto', 'manual', 'acceptEdits', 'plan'])('passes supported %s with stdio prompts', mode => {
    expect(claudeLaunchArgs({ permissionMode: mode })).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'stdio', '--permission-mode', mode]));
  });
  it('sends manual for the old Ask spelling and rejects dontAsk', () => {
    expect(claudeLaunchArgs({ permissionMode: 'default' })).toContain('manual');
    expect(() => claudeLaunchArgs({ permissionMode: 'dontAsk' })).toThrow('Invalid Claude Code permission mode.');
  });
  it.each(['stderr', 'result', 'pipe'])('retries Auto rejection from %s once as Accept edits', async source => {
    const fallback = host();
    const rejected = host({ script: (send, msg, child) => {
      if (msg.type !== 'user') return;
      if (source === 'result') send({ type: 'result', subtype: 'error', is_error: true, errors: ['Auto mode is not available'] });
      else {
        if (source === 'pipe') child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        child.stderr.emit('data', "error: option '--permission-mode <mode>' argument 'auto' is invalid. Allowed choices: acceptEdits, manual, plan");
        child.emit('close', 1);
      }
    } });
    const spawn = jest.fn().mockImplementationOnce(() => rejected.child).mockImplementationOnce(() => fallback.child);
    (desktopHost.childProcess as jest.Mock).mockResolvedValue({ spawn });
    const cb = { ...callbacks(), notice: jest.fn() };
    await expect(runLocalClaude(input, new AbortController().signal, cb)).resolves.toMatchObject({ text: 'hello there' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(cb.notice).toHaveBeenCalledTimes(1);
    expect(cb.notice).toHaveBeenCalledWith(expect.stringContaining("Auto mode isn't available"));
  });
  it.each(['stderr', 'result', 'pipe'])('retains the chat fallback process across follow-up turns after %s rejection', async source => {
    const fallback = host();
    const rejected = host({ script: (send, message, child) => {
      if (message.type !== 'user') return;
      if (source === 'result') send({ type: 'result', subtype: 'error', is_error: true, errors: ['Auto mode is not available'] });
      else {
        if (source === 'pipe') child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        child.stderr.emit('data', "error: permission-mode auto is unsupported"); child.emit('close', 1);
      }
    } });
    const spawn = jest.fn().mockImplementationOnce(() => rejected.child).mockImplementationOnce(() => fallback.child);
    (desktopHost.childProcess as jest.Mock).mockResolvedValue({ spawn });
    const resetNotice = jest.fn(), transport = new ClaudeChatTransport(resetNotice), cb = { ...callbacks(), notice: jest.fn() };
    try {
      await transport.run(input, new AbortController().signal, cb);
      expect(fallback.child.stdin.end).not.toHaveBeenCalled();
      await transport.run({ ...input, sessionId: SESSION }, new AbortController().signal, cb);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
      expect(fallback.messages.filter(message => message.type === 'user')).toHaveLength(2);
      expect(cb.notice).toHaveBeenCalledTimes(1); expect(resetNotice).not.toHaveBeenCalled();
    } finally { await transport.close(); }
  });
  it.each(['manual', 'acceptEdits'])('honors init downgrade to %s without replaying work', async permissionMode => {
    const { spawn, messages } = host({ script: (send, msg) => {
      if (msg.type === 'user') {
        send({ type: 'system', subtype: 'init', session_id: SESSION, permissionMode });
        if (permissionMode === 'acceptEdits') send({ type: 'result', subtype: 'success', result: 'done', session_id: SESSION });
      }
      if (msg.type === 'control_request') {
        expect(msg.request).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' });
        send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
        send({ type: 'result', subtype: 'success', result: 'done', session_id: SESSION });
      }
    } });
    const cb = { ...callbacks(), notice: jest.fn() };
    await expect(runLocalClaude(input, new AbortController().signal, cb)).resolves.toMatchObject({ text: 'done' });
    expect(spawn).toHaveBeenCalledTimes(1); expect(messages.filter(msg => msg.type === 'user')).toHaveLength(1);
    expect(cb.notice).toHaveBeenCalledTimes(1);
  });
  it('never replays a rejection after agent activity', async () => {
    const { spawn } = host({ script: (send, msg) => {
      if (msg.type !== 'user') return;
      send({ type: 'assistant', session_id: SESSION, message: { content: [] } });
      send({ type: 'result', subtype: 'error', is_error: true, errors: ['Auto mode is not available'] });
    } });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).rejects.toThrow('Auto mode is not available');
    expect(spawn).toHaveBeenCalledTimes(1);
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
  it.each(['/home/test/.nvm/versions/node/v22.18.0/bin', '/home/test/.volta/bin', '/home/test/.claude/local'])('launches a CLI and its node interpreter from %s with a bare GUI PATH', async folder => {
    const { spawn, child } = host();
    const fs = await desktopHost.fs();
    const files = new Set([`${folder}/claude`, `${folder}/node`]);
    (fs.stat as jest.Mock).mockImplementation(async path => ({ isDirectory: () => path === '/vault', isFile: () => files.has(path), mode: 0o100755 }));
    (fs.readdir as jest.Mock).mockImplementation(async path => path === '/home/test/.nvm/versions/node' && folder.includes('/.nvm/')
      ? [{ name: 'v22.18.0', isDirectory: () => true }] : []);
    spawn.mockImplementationOnce((...args: unknown[]) => {
      const [binary, , options] = args as [string, string[], { env: { PATH: string } }];
      const resolve = (name: string) => options.env.PATH.split(':').map(path => `${path}/${name}`).find(path => files.has(path));
      expect(resolve(binary)).toBe(`${folder}/claude`);
      expect(resolve('node')).toBe(`${folder}/node`);
      return child;
    });
    await expect(runLocalClaude(input, new AbortController().signal, callbacks())).resolves.toMatchObject({ text: 'hello there' });
    expect(spawn).toHaveBeenCalledTimes(1);
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

describe('chat-owned native transport', () => {
  it('emits exact text tail offsets beyond the Studio rolling buffer', async () => {
    const chunks = ['a'.repeat(255_990), 'b'.repeat(20), 'tail'], full = chunks.join('');
    host({ script: (send, message) => {
      if (message.type !== 'user') return;
      send({ type: 'system', subtype: 'init', session_id: SESSION });
      for (const text of chunks) send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }, session_id: SESSION });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: full }] }, session_id: SESSION });
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'next' } }, session_id: SESSION });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'next' }] }, session_id: SESSION });
      send({ type: 'result', subtype: 'success', result: 'next', session_id: SESSION });
    } });
    const transport = new ClaudeChatTransport(), updates: [string, number][] = [];
    try {
      await transport.run(input, new AbortController().signal, { ...callbacks(), text: (text, offset = 0) => updates.push([text, offset]) });
      expect(updates).toEqual([[chunks[0], 0], [chunks[1], 255_990], ['tail', 256_010], [full, 0], ['\n\nnext', full.length], ['\n\nnext', full.length]]);
      expect(updates.reduce((text, [tail, offset]) => text.slice(0, offset) + tail, '')).toBe(`${full}\n\nnext`);
    } finally { await transport.close(); }
  });
  it('retains one process and native grants across serial turns without replaying grants', async () => {
    let granted = false;
    const { child, messages, spawn } = host({ script: (send, message) => {
      if (message.type === 'user') {
        send({ type: 'system', subtype: 'init', session_id: SESSION });
        if (!granted) send({ type: 'control_request', request_id: 'grant', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'command', input: { command: 'pwd' }, permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'pwd' }], destination: 'session' }] } });
        else send({ type: 'result', subtype: 'success', result: 'second', session_id: SESSION });
      }
      if (message.type === 'control_response') { granted = true; send({ type: 'result', subtype: 'success', result: 'first', session_id: SESSION }); }
    } });
    const transport = new ClaudeChatTransport(), permission = jest.fn(async () => ({ approved: true, rememberForSession: true }));
    try {
      await expect(transport.run(input, new AbortController().signal, { ...callbacks(), permission })).resolves.toMatchObject({ text: 'first' });
      expect(child.stdin.end).not.toHaveBeenCalled();
      const second = callbacks();
      await expect(transport.run({ ...input, sessionId: SESSION }, new AbortController().signal, second)).resolves.toMatchObject({ text: 'second' });
      expect(spawn).toHaveBeenCalledTimes(1); expect(permission).toHaveBeenCalledTimes(1); expect(second.permission).not.toHaveBeenCalled();
      expect(messages.filter(message => message.type === 'control_response')).toHaveLength(1);
      await expect(runLocalClaude({ ...input, sessionId: SESSION }, new AbortController().signal, callbacks())).rejects.toThrow('already running');
    } finally { await transport.close(); }
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });
  it.each([{ model: 'opus' }, { permissionMode: 'plan' }, { workingDirectory: '/other' }])('restarts and explains grant reset when options change (%j)', async change => {
    const first = host(), notice = jest.fn(), transport = new ClaudeChatTransport(notice);
    await transport.run(input, new AbortController().signal, callbacks());
    const second = host();
    try {
      await transport.run({ ...input, sessionId: SESSION, ...change }, new AbortController().signal, callbacks());
      expect(first.child.stdin.end).toHaveBeenCalledTimes(1); expect(second.spawn).toHaveBeenCalledTimes(1);
      expect(notice).toHaveBeenCalledWith(expect.stringContaining('Previous session approvals no longer apply'));
    } finally { await transport.close(); }
  });
  it('invalidates an idle child exit and starts a fresh native process next turn', async () => {
    const first = host(), notice = jest.fn(), transport = new ClaudeChatTransport(notice);
    await transport.run(input, new AbortController().signal, callbacks());
    first.child.emit('close', 0);
    const second = host();
    try {
      await transport.run({ ...input, sessionId: SESSION }, new AbortController().signal, callbacks());
      expect(second.spawn).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(1);
    } finally { await transport.close(); }
  });
  it('cancels an active retained turn and rejects concurrent turns', async () => {
    const { messages, child } = host({ script: () => {} }), transport = new ClaudeChatTransport(), controller = new AbortController();
    const running = transport.run(input, controller.signal, callbacks());
    for (let i = 0; i < 60 && !messages.length; i++) await Promise.resolve();
    await expect(transport.run(input, new AbortController().signal, callbacks())).rejects.toThrow('Wait for');
    controller.abort(); await expect(running).rejects.toThrow('canceled'); await transport.close();
    expect(child.stdin.end).toHaveBeenCalled(); expect(transport.connection).toBeUndefined();
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

describe('inline native protocol', () => {
  it('publishes tool starts, streamed inputs and results matched by tool_use_id', async () => {
    host({ script: (send, msg) => {
      if (msg.type !== 'user') return;
      send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'Bash', input: {} } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } } });
      send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Bash', input: { command: 'pwd' } }, { type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/vault/a.md' } }] } });
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'two', content: 'missing', is_error: true }, { type: 'tool_result', tool_use_id: 'one', content: '/vault' }] } });
      send({ type: 'result', subtype: 'success', result: 'done', session_id: SESSION });
    } });
    const tool = jest.fn(); await runLocalClaude(input, new AbortController().signal, { ...callbacks(), tool });
    expect(tool.mock.calls.map(([activity]) => [activity.id, activity.state])).toEqual([
      ['one', 'input-streaming'], ['one', 'input-streaming'], ['one', 'running'], ['one', 'running'], ['two', 'running'], ['two', 'failed'], ['one', 'succeeded'],
    ]);
    expect(tool).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', input: { command: 'pwd' } }));
    expect(tool).toHaveBeenLastCalledWith({ id: 'one', state: 'succeeded', output: '/vault' });
  });
  it('sends exact suggested permission updates with session destinations only', async () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git diff:*' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/workspace'], destination: 'userSettings' },
      { type: 'replaceRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' },
      { type: 'removeRules', rules: [{ toolName: 'Edit' }], behavior: 'deny', destination: 'session' },
      { type: 'removeDirectories', directories: ['/old'], destination: 'cliArg' },
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ];
    const toolInput = { command: 'git diff' };
    const { messages } = host({ script: (send, msg) => {
      if (msg.type === 'user') send({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_use_id: 'bash', tool_name: 'Bash', input: toolInput, description: 'Inspect changes', decision_reason: 'Needs consent', permission_suggestions: suggestions } });
      if (msg.type === 'control_response') send({ type: 'result', subtype: 'success', result: 'done', session_id: SESSION });
    } });
    const permission = jest.fn(async () => ({ approved: true, rememberForSession: true }));
    await runLocalClaude(input, new AbortController().signal, { ...callbacks(), permission });
    expect(permission).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'permission', toolUseId: 'bash', description: 'Inspect changes\nNeeds consent', permissionSuggestions: suggestions }), expect.any(AbortSignal));
    expect(messages.find(message => message.type === 'control_response').response.response).toEqual({ behavior: 'allow', updatedInput: toolInput, updatedPermissions: suggestions.map(suggestion => ({ ...suggestion, destination: 'session' })) });
    expect(suggestions[0].destination).toBe('localSettings');
  });
  it('never grants bypass/dontAsk modes and never synthesizes suggestions', () => {
    const request = { toolName: 'Bash', description: '', input: { command: 'pwd' }, permissionSuggestions: ['bypassPermissions', 'dontAsk'].map(mode => ({ type: 'setMode', mode, destination: 'session' })) };
    expect(claudePermissionResponse(request, { approved: true, rememberForSession: true })).toEqual({ behavior: 'allow', updatedInput: request.input });
    expect(claudePermissionResponse(request, { approved: false, rememberForSession: true })).toEqual({ behavior: 'deny', message: 'The user declined this action in SystemSculpt.' });
  });
  it('maps inline question answers into the native updatedInput', () => {
    const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Blue', description: 'Cool' }] }];
    expect(claudePermissionResponse({ toolName: 'AskUserQuestion', description: '', input: { questions } }, { approved: true, answers: { 'Which color?': ['Blue'] } })).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which color?': 'Blue' } } });
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
    expect(cb.permission).toHaveBeenCalledWith({ toolName: 'Edit', description: 'note.md', input: edit.request.input, requestId: 'req-1' }, expect.any(AbortSignal));
    expect(messages.find(m => m.type === 'control_response').response).toEqual({ subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: edit.request.input } });
  });
  it('denies a declined edit', async () => {
    const { messages } = host({ script: permissionScript() });
    await runLocalClaude(input, new AbortController().signal, callbacks(false));
    expect(messages.find(m => m.type === 'control_response').response.response).toEqual({ behavior: 'deny', message: 'The user declined this action in SystemSculpt.' });
  });
  it.each([
    { answer: ['Blue'] }, { answer: ['Blue', 'Green'] }, { answer: ['A shade of turquoise'] },
  ])('returns inline question answer $answer in the permission response updatedInput', async ({ answer }) => {
    const questions = [{ question: 'Which color?', header: 'Color', multiSelect: answer.length > 1, options: [{ label: 'Blue' }, { label: 'Green' }] }];
    const toolInput = { questions, metadata: { source: 'native' } };
    const { messages } = host({ script: (send, msg) => {
      if (msg.type === 'user') send({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: toolInput } });
      if (msg.type === 'control_response') send({ type: 'result', subtype: 'success', result: 'Answer received', session_id: SESSION });
    } });
    const permission = jest.fn(async () => ({ approved: true, answers: { 'Which color?': answer } }));
    await runLocalClaude(input, new AbortController().signal, { ...callbacks(), supportsQuestions: true, permission });
    expect(permission).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'AskUserQuestion', input: toolInput }), expect.any(AbortSignal));
    expect(messages.find(m => m.response?.request_id === 'ask').response).toEqual({ subtype: 'success', request_id: 'ask', response: {
      behavior: 'allow', updatedInput: { ...toolInput, answers: { 'Which color?': answer.join(', ') } },
    } });
    expect(toolInput).not.toHaveProperty('answers');
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
    let promptSignal: AbortSignal | undefined, withdrew!: () => void;
    const withdrawn = new Promise<void>(resolve => { withdrew = resolve; });
    const controller = new AbortController();
    const { messages } = host({ script: (send, msg) => { if (msg.type === 'user') { send(edit); send({ type: 'control_cancel_request', request_id: 'req-1' }); withdrew(); } } });
    const cb = { ...callbacks(), permission: jest.fn((_request, signal: AbortSignal) => { promptSignal = signal; return new Promise<boolean>(() => {}); }) };
    const running = runLocalClaude(input, controller.signal, cb);
    await withdrawn;
    expect(promptSignal?.aborted).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow('Claude Code run canceled.');
    expect(messages.some(m => m.type === 'control_request' && m.request.subtype === 'interrupt')).toBe(true);
  });
});
