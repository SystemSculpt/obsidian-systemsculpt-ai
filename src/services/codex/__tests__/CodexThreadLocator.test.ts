import { CodexThreadLocator } from '../CodexThreadLocator';

const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FOLDER = '.obsidian/plugins/systemsculpt-ai';
const chat = (n: number) => `conversation_${String(n).padStart(32, '0')}`;

/** In-memory vault adapter shaped like Obsidian's: vault-relative paths, list returns full child paths. */
function host(files: Record<string, string> = {}, configDir = '.obsidian') {
  const store = new Map(Object.entries(files)), folders = new Set<string>();
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/'));
  const adapter = {
    exists: jest.fn(async (path: string) => store.has(path) || folders.has(path) || [...store.keys()].some(file => parent(file) === path)),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    write: jest.fn(async (path: string, data: string) => { store.set(path, data); }),
    stat: jest.fn(async (path: string) => store.has(path) ? { type: 'file', size: Buffer.byteLength(store.get(path)!), ctime: 0, mtime: 0 } : null),
    read: jest.fn(async (path: string) => { if (!store.has(path)) throw new Error(`ENOENT: ${path}`); return store.get(path)!; }),
    list: jest.fn(async (path: string) => ({ files: [...store.keys()].filter(file => parent(file) === path), folders: [] })),
  };
  return { app: { vault: { configDir, adapter } } as never, adapter, store };
}

it('keeps each agent\'s thread in its own locator under the vault config folder', async () => {
  const { app, adapter, store } = host({}, '.config');
  const codex = new CodexThreadLocator(app), claude = new CodexThreadLocator(app, 'claude');

  await codex.write(chat(1), THREAD);
  expect(adapter.mkdir.mock.calls).toEqual([['.config/plugins/systemsculpt-ai/codex-threads']]);
  expect(Object.fromEntries(store)).toEqual({ [`.config/plugins/systemsculpt-ai/codex-threads/${chat(1)}.json`]: JSON.stringify({ schema: 1, threadId: THREAD }) });
  await expect(codex.read(chat(1))).resolves.toBe(THREAD);
  await expect(claude.read(chat(1))).resolves.toBeUndefined();

  const session = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  await claude.write(chat(2), session);
  await expect(claude.read(chat(2))).resolves.toBe(session);
  await expect(codex.read(chat(2))).resolves.toBeUndefined();
  await expect(codex.conversationIds()).resolves.toEqual(new Set([chat(1)]));
  await expect(claude.conversationIds()).resolves.toEqual(new Set([chat(2)]));
});

it('creates the locator folder once and replaces a chat\'s thread when it is saved again', async () => {
  const { app, adapter } = host();
  const locator = new CodexThreadLocator(app);
  const next = 'ffffffff-0000-4000-8000-000000000001';

  await locator.write(chat(1), THREAD);
  await locator.write(chat(1), next);
  await locator.write(chat(2), THREAD);
  expect(adapter.mkdir).toHaveBeenCalledTimes(1);
  await expect(locator.read(chat(1))).resolves.toBe(next);
  await expect(locator.read(chat(2))).resolves.toBe(THREAD);
});

it.each([
  ['empty', ''],
  ['a parent folder', '..'],
  ['a traversal', '../data'],
  ['a nested path', 'chats/chat-1'],
  ['a Windows path', 'chats\\chat-1'],
  ['an extension', 'chat-1.json'],
  ['whitespace', 'chat 1'],
  ['too long', 'x'.repeat(161)],
])('rejects %s chat identity before touching the vault', async (_label, conversationId) => {
  const { app, adapter } = host();
  const locator = new CodexThreadLocator(app);

  await expect(locator.read(conversationId)).rejects.toThrow('Invalid chat identity.');
  await expect(locator.write(conversationId, THREAD)).rejects.toThrow('Invalid chat identity.');
  for (const call of Object.values(adapter)) expect(call).not.toHaveBeenCalled();
});

it('accepts the longest supported chat identity', async () => {
  const { app } = host();
  const locator = new CodexThreadLocator(app), conversationId = `Az09_-${'x'.repeat(154)}`;

  await locator.write(conversationId, THREAD);
  await expect(locator.read(conversationId)).resolves.toBe(THREAD);
});

it('reports no thread for a chat this agent never ran, or a host that cannot check files', async () => {
  const { app, adapter } = host({ [`${FOLDER}/codex-threads/other.json`]: JSON.stringify({ schema: 1, threadId: THREAD }) });
  await expect(new CodexThreadLocator(app).read(chat(1))).resolves.toBeUndefined();
  expect(adapter.stat).not.toHaveBeenCalled();
  expect(adapter.read).not.toHaveBeenCalled();

  const noExists = { vault: { configDir: '.obsidian', adapter: { stat: jest.fn(), read: jest.fn() } } };
  await expect(new CodexThreadLocator(noExists as never).read(chat(1))).resolves.toBeUndefined();
  expect(noExists.vault.adapter.stat).not.toHaveBeenCalled();
  expect(noExists.vault.adapter.read).not.toHaveBeenCalled();
});

it('reads a locator of exactly the size limit', async () => {
  const body = JSON.stringify({ schema: 1, threadId: THREAD, pad: '' });
  const padded = JSON.stringify({ schema: 1, threadId: THREAD, pad: ' '.repeat(1024 - body.length) });
  expect(Buffer.byteLength(padded)).toBe(1024);
  const { app } = host({ [`${FOLDER}/codex-threads/${chat(1)}.json`]: padded });
  await expect(new CodexThreadLocator(app).read(chat(1))).resolves.toBe(THREAD);
});

it.each([
  ['an oversized file', JSON.stringify({ schema: 1, threadId: THREAD, pad: ' '.repeat(1024) }), 'Invalid saved on-machine thread locator.'],
  ['no thread identity', JSON.stringify({ schema: 1 }), 'Invalid saved on-machine thread identity.'],
  ['a numeric thread identity', JSON.stringify({ schema: 1, threadId: 42 }), 'Invalid saved on-machine thread identity.'],
  ['a thread identity wrapped in a list', JSON.stringify({ schema: 1, threadId: [THREAD] }), 'Invalid saved on-machine thread identity.'],
  ['a short thread identity', JSON.stringify({ schema: 1, threadId: 'abc123' }), 'Invalid saved on-machine thread identity.'],
  ['a long thread identity', JSON.stringify({ schema: 1, threadId: 'a'.repeat(81) }), 'Invalid saved on-machine thread identity.'],
  ['a path as thread identity', JSON.stringify({ schema: 1, threadId: '../../../../../deadbeef-0000' }), 'Invalid saved on-machine thread identity.'],
  ['a JSON array', '[]', 'Invalid saved on-machine thread identity.'],
  ['truncated JSON', '{"schema":1,"threadId":"0199a1b2', SyntaxError],
])('fails closed on a locator with %s', async (_label, contents, error) => {
  const { app } = host({ [`${FOLDER}/codex-threads/${chat(1)}.json`]: contents });
  await expect(new CodexThreadLocator(app).read(chat(1))).rejects.toThrow(error);
});

it('fails closed when the host has no metadata for an existing locator', async () => {
  const { app, adapter } = host({ [`${FOLDER}/codex-threads/${chat(1)}.json`]: JSON.stringify({ schema: 1, threadId: THREAD }) });
  adapter.stat.mockResolvedValueOnce(null);
  await expect(new CodexThreadLocator(app).read(chat(1))).rejects.toThrow('Invalid saved on-machine thread locator.');
  expect(adapter.read).not.toHaveBeenCalled();
});

it('lists the chats an agent ran from locator names alone, without reading them', async () => {
  const saved = JSON.stringify({ schema: 1, threadId: THREAD });
  const { app, adapter } = host({
    [`${FOLDER}/codex-threads/${chat(1)}.json`]: saved,
    [`${FOLDER}/codex-threads/${chat(2)}.json`]: 'damaged',
    [`${FOLDER}/codex-threads/.DS_Store`]: '',
    [`${FOLDER}/codex-threads/${chat(3)}.json.tmp`]: saved,
    [`${FOLDER}/codex-threads/notes.md`]: '',
    [`${FOLDER}/claude-threads/${chat(4)}.json`]: saved,
    [`${FOLDER}/data.json`]: '{}',
  });

  await expect(new CodexThreadLocator(app).conversationIds()).resolves.toEqual(new Set([chat(1), chat(2)]));
  await expect(new CodexThreadLocator(app, 'claude').conversationIds()).resolves.toEqual(new Set([chat(4)]));
  expect(adapter.read).not.toHaveBeenCalled();
  expect(adapter.stat).not.toHaveBeenCalled();
});

it('treats a missing, unlistable or unreadable locator folder as no on-machine chats', async () => {
  const empty = host();
  await expect(new CodexThreadLocator(empty.app).conversationIds()).resolves.toEqual(new Set());
  expect(empty.adapter.list).not.toHaveBeenCalled();

  const noList = { vault: { configDir: '.obsidian', adapter: { exists: jest.fn(async () => true) } } };
  await expect(new CodexThreadLocator(noList as never).conversationIds()).resolves.toEqual(new Set());
  expect(noList.vault.adapter.exists).not.toHaveBeenCalled();

  const failingList = host({ [`${FOLDER}/codex-threads/${chat(1)}.json`]: '{}' });
  failingList.adapter.list.mockRejectedValueOnce(new Error('EACCES'));
  await expect(new CodexThreadLocator(failingList.app).conversationIds()).resolves.toEqual(new Set());

  const failingExists = host();
  failingExists.adapter.exists.mockRejectedValueOnce(new Error('EIO'));
  await expect(new CodexThreadLocator(failingExists.app).conversationIds()).resolves.toEqual(new Set());
});
