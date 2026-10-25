/** @jest-environment jsdom */
import { App, TFile } from 'obsidian';
import { AgentChatView } from '../AgentChatView';
import { ChatStorageService } from '../ChatStorageService';
import { nativeChatSessions } from '../NativeChatSessions';
import { CodexThreadLocator } from '../../../services/codex/CodexThreadLocator';
import type { LocalAgentId } from '../../../services/codex/LocalAgents';
import type { LocalAgentChatSession } from '../../../services/codex/LocalAgentChatSession';
import { showConfirm } from '../../../core/ui/notifications';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian'), yaml = jest.requireActual('yaml');
  return { ...actual, parseYaml: yaml.parse, stringifyYaml: yaml.stringify };
});
jest.mock('../../../core/ui/notifications', () => ({ showConfirm: jest.fn(async () => ({ confirmed: true })) }));
jest.mock('../../../services/codex/CodexExecutionSettings', () => ({
  ...jest.requireActual('../../../services/codex/CodexExecutionSettings'),
  localAgentChatDirectory: async () => '/vault',
}));
jest.mock('../../../services/codex/LocalCodexClient', () => ({
  CodexChatTransport: jest.fn(() => ({ run: mockRun, close: mockClose })),
}));
jest.mock('../../../services/claude/LocalClaudeClient', () => ({
  ...jest.requireActual('../../../services/claude/LocalClaudeClient'),
  ClaudeChatTransport: jest.fn(() => ({ run: mockRun, close: mockClose })),
}));
const mockRun = jest.fn();
const mockClose = jest.fn();

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(backend: LocalAgentId) {
  const app = new App();
  const notes = new Map<string, { file: TFile; content: string }>();
  let clock = 1_000;
  const store = (file: TFile, content: string) => {
    notes.set(file.path, { file, content });
    file.stat = { ...file.stat, mtime: ++clock, size: content.length };
  };
  Object.assign(app.vault, {
    getAbstractFileByPath: jest.fn((path: string) => notes.get(path)?.file ?? null),
    getMarkdownFiles: jest.fn(() => [...notes.values()].map(note => note.file)),
    read: jest.fn(async (file: TFile) => notes.get(file.path)!.content),
    modify: jest.fn(async (file: TFile, content: string) => store(file, content)),
    process: jest.fn(async (file: TFile, update: (content: string) => string) => {
      const content = update(notes.get(file.path)!.content); store(file, content); return content;
    }),
    create: jest.fn(async (path: string, content: string) => {
      if (notes.has(path)) throw new Error('File already exists.');
      const file = new TFile({ path, stat: { ctime: ++clock, mtime: clock, size: content.length } });
      store(file, content); return file;
    }),
    createFolder: jest.fn(async () => undefined),
  });
  app.vault.adapter.exists = jest.fn(async () => true);
  const trashFile = jest.fn(async (file: TFile) => { notes.delete(file.path); });
  Object.assign(app.fileManager, { trashFile });
  const storage = new ChatStorageService(app, 'SystemSculpt/Chats');
  const plugin = {
    app,
    settings: { textExecutionBackend: backend, textExecutionBackendExplicit: true, favoriteChats: [] },
    manifest: { version: 'test' },
    getLoadedPluginBuildId: jest.fn(async () => `sha256:${'d'.repeat(64)}`),
    getLogger: () => ({ error: jest.fn() }),
  };
  const views: any[] = [];
  app.workspace.getLeavesOfType = jest.fn(() => views.map(view => ({ view })) as never);
  function createView() {
    const view = Object.create(AgentChatView.prototype) as any;
    const workspace = {
      setPlanOfferVisible: jest.fn(), setRunPending: jest.fn(), setBanner: jest.fn(),
      resetMessageEditor: jest.fn(), setApprovalMode: jest.fn(), setTitle: jest.fn(),
      setHistory: jest.fn(async () => undefined), setAgentSnapshot: jest.fn(async () => undefined),
      setComposerReadOnly: jest.fn(), setChrome: jest.fn(), resetComposerDraft: jest.fn(),
      settleCompletedRun: jest.fn(async () => undefined), settleUnfinishedRun: jest.fn(async () => undefined),
    };
    Object.assign(view, {
      app, plugin, workspace, chatStorage: storage, containerEl: document.body.createDiv(),
      agentMutationJournal: { idle: async () => {} },
      contextManager: { getPinnedFiles: () => [], setPinnedFiles: async () => {}, clearPinnedFiles: () => {}, dispose: () => {} },
      attachmentStore: { hydrateMessage: async (message: unknown) => message },
      queueRepository: { save: async () => {} },
      conversationOriginToken: 'initial', activeSubmissionOperation: null, runConversationOrigins: new Map(),
      sessionTrustedToolNames: new Set(), queuedFollowUps: [], queueHydrated: false, queuePersistence: Promise.resolve(),
      queueDrainSuppressionDepth: 0, pendingForkHistory: null, pendingRetry: null, pendingRejectedRetry: null,
      messageEditGeneration: 0, chatId: '', chatTitle: 'Original', chatVersion: 0, chatFontSize: 'medium', approvalMode: 'ask',
      chatExecutionBackend: backend, automationApprovalMode: 'interactive', isFullyLoaded: true, detection: null,
      thinClientId: `client_${'c'.repeat(32)}`, creditsBalance: null,
      readThinAgentContextSources: async () => ({ sources: [], measurement: {} }),
      bindQueueToChat: async () => {}, hydrateQueue: async () => {}, persistQueueState: async () => {},
      applyFontSize: () => {}, syncAttachments: () => {}, syncQueue: () => {}, syncChrome: () => {},
      updateViewState: () => {}, loadCodexCatalog: () => {}, applyBackendAvailability: () => {},
      prepareThinConversation: async () => {}, refreshCreditsBalance: async () => {},
    });
    view.bindTranscript(view.createTranscript());
    view.agent = view.createAgentSession();
    view.bindAgentSession();
    views.push(view);
    return view;
  }
  const view = createView();
  const started = deferred<{ signal: AbortSignal; text: (text: string) => void }>();
  const finish = deferred<{ text: string }>();
  mockRun.mockImplementation(async (_turn, signal: AbortSignal, events) => {
    await (events.thread ?? events.session)('native-thread');
    events.text('Working');
    started.resolve({ signal, text: events.text });
    signal.addEventListener('abort', () => finish.resolve({ text: 'Working' }), { once: true });
    return finish.promise;
  });
  return { view, createView, plugin, notes, storage, started, finish, trashFile };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(CodexThreadLocator.prototype, 'read').mockResolvedValue(undefined);
  jest.spyOn(CodexThreadLocator.prototype, 'write').mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); document.body.empty(); });

it.each(['claude', 'codex'] as const)('%s keeps New chat independent and saves the answer to the original Markdown note', async backend => {
  const h = harness(backend);
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  const native = await h.started.promise;
  const chatId = h.view.chatId;
  const path = h.view.transcript.chatPath(chatId);
  const session = h.view.agent;
  expect(nativeChatSessions(h.plugin).get(chatId)?.session).toBe(session);
  await h.view.startNewChat(false);
  h.view.chatTitle = 'Unrelated draft';
  h.view.approvalMode = 'full-access';
  expect(h.view.chatId).toBe('');
  expect(h.view.agent).not.toBe(session);
  expect(native.signal.aborted).toBe(false);
  expect(mockClose).not.toHaveBeenCalled();
  expect(h.view.isChatWorkingAnywhere(chatId)).toBe(true);
  native.text('Still working after switching');
  expect(h.view.workspace.setAgentSnapshot).toHaveBeenLastCalledWith(null);
  h.finish.resolve({ text: 'Still working after switching — complete' });
  await run;
  expect(h.view.chatId).toBe('');
  expect(h.view.messages).toEqual([]);
  expect(h.notes.get(path)?.content).toContain('complete');
  expect(await h.storage.loadChat(chatId)).toMatchObject({ title: 'Original task', approvalMode: 'ask', messages: [
    expect.objectContaining({ content: 'Original task' }),
    expect.objectContaining({ content: 'Still working after switching — complete' }),
  ] });
  expect(h.view.isChatWorkingAnywhere(chatId)).toBe(false);
  await nativeChatSessions(h.plugin).dispose();
  expect(nativeChatSessions(h.plugin).get(chatId)).toBeUndefined();
});

it.each(['claude', 'codex'] as const)('%s survives a history switch and reattaches to the same live turn', async backend => {
  const h = harness(backend);
  await h.storage.saveChat('other', [{ role: 'user', content: 'Other task', message_id: 'other-user' }], { title: 'Other chat' });
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  const native = await h.started.promise;
  const chatId = h.view.chatId, session = h.view.agent;
  await h.view.loadChatById('other');
  expect(h.view.chatId).toBe('other');
  expect(native.signal.aborted).toBe(false);
  expect(h.view.isChatWorkingAnywhere(chatId)).toBe(true);
  native.text('Background progress');
  await h.view.loadChatById(chatId);
  expect(h.view.agent).toBe(session);
  expect(h.view.isWorking()).toBe(true);
  expect(h.view.workspace.setAgentSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running', parts: [expect.objectContaining({ markdown: 'Background progress' })] }));
  native.text('Visible after reopening');
  expect(h.view.workspace.setAgentSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [expect.objectContaining({ markdown: 'Visible after reopening' })] }));
  h.finish.resolve({ text: 'Visible after reopening — done' });
  await run;
  expect(h.view.messages.at(-1)?.content).toContain('done');
  expect((await h.storage.loadChat('other'))?.messages).toHaveLength(1);
  await nativeChatSessions(h.plugin).dispose();
});

it('shares a live session between views and keeps it alive when either leaves', async () => {
  const h = harness('claude');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  const native = await h.started.promise;
  const chatId = h.view.chatId, session = h.view.agent;
  const second = h.createView();
  await second.loadChatById(chatId);
  expect(second.agent).toBe(session);
  expect(second.transcript).toBe(h.view.transcript);
  await h.view.startNewChat(false);
  expect(native.signal.aborted).toBe(false);
  native.text('Second view still receives progress');
  expect(second.workspace.setAgentSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running' }));
  h.finish.resolve({ text: 'Second view still receives progress — done' });
  await run;
  expect(second.messages.at(-1)?.content).toContain('done');
  await nativeChatSessions(h.plugin).dispose();
});

it('gives every pane an independent draft after deleting their shared chat', async () => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId, path = h.view.transcript.chatPath(chatId);
  const second = h.createView();
  await second.loadChatById(chatId);
  await h.view.deleteSavedChat({ chatId, chatPath: path, title: 'Original', favorite: false });
  await run;
  expect(h.view.transcript).not.toBe(second.transcript);
  await h.view.executeSubmission({ text: 'Independent first draft', mode: 'send' });
  expect(second.chatId).toBe('');
  expect(second.messages).toEqual([]);
  await second.executeSubmission({ text: 'Independent second draft', mode: 'send' });
  expect(second.chatId).not.toBe(h.view.chatId);
  await nativeChatSessions(h.plugin).dispose();
});

it('removes a departing secondary pane as the shared metadata provider', async () => {
  const h = harness('claude');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId;
  const second = h.createView();
  await second.loadChatById(chatId);
  await second.startNewChat(false);
  second.approvalMode = 'full-access';
  second.chatFontSize = 'large';
  h.view.chatFontSize = 'small';
  h.finish.resolve({ text: 'Original answer' });
  await run;
  expect(await h.storage.loadChat(chatId)).toMatchObject({ approvalMode: 'ask', chatFontSize: 'small' });
  await nativeChatSessions(h.plugin).dispose();
});

it.each(['claude', 'codex'] as const)('%s retries with the preceding conversation after reattachment in another pane', async backend => {
  const h = harness(backend);
  await h.view.transcript.commitUser({ kind: 'append', message: { role: 'user', content: 'Remember the first question', message_id: 'prior-user' } });
  await h.view.transcript.persistAssistant({ role: 'assistant', content: 'Remember the first answer', message_id: 'prior-assistant' });
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId;
  await h.view.onClose();
  const second = h.createView();
  await second.loadChatById(chatId);
  h.finish.resolve({ text: 'Original answer' });
  await run;
  const snapshot = second.transcript.snapshot();
  mockRun.mockClear();
  await second.executeSubmission({ text: 'Retry this task', mode: 'send' }, {
    historicalResubmit: { targetMessageId: snapshot.messages[2].message_id, expectedIndex: 2, expectedVersion: snapshot.version },
  });
  expect(mockRun.mock.calls[0][0].prompt).toContain('Remember the first question');
  expect(mockRun.mock.calls[0][0].prompt).toContain('Remember the first answer');
  expect(mockRun.mock.calls[0][0].prompt).not.toContain('Original answer');
  await nativeChatSessions(h.plugin).dispose();
});

it('updates every attached pane with committed history before the next live turn', async () => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const second = h.createView();
  await second.loadChatById(h.view.chatId);
  h.finish.resolve({ text: 'Original answer' });
  await run;
  expect(second.workspace.settleCompletedRun).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ content: 'Original answer' })]));
  const nextStarted = deferred(), nextFinish = deferred<{ text: string }>();
  mockRun.mockImplementationOnce(async () => { nextStarted.resolve(); return nextFinish.promise; });
  const next = h.view.executeSubmission({ text: 'Next question', mode: 'send' });
  await nextStarted.promise;
  expect(second.workspace.setHistory).toHaveBeenLastCalledWith(expect.arrayContaining([
    expect.objectContaining({ content: 'Original answer' }), expect.objectContaining({ content: 'Next question' }),
  ]));
  nextFinish.resolve({ text: 'Next answer' });
  await next;
  await nativeChatSessions(h.plugin).dispose();
});

it('saves metadata from the pane that edits it, not the last pane attached', async () => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId;
  const second = h.createView();
  await second.loadChatById(chatId);
  await h.view.setChatFontSize('small');
  expect((await h.storage.loadChat(chatId))?.chatFontSize).toBe('small');
  h.finish.resolve({ text: 'Original answer' });
  await run;
  expect((await h.storage.loadChat(chatId))?.chatFontSize).toBe('small');
  await nativeChatSessions(h.plugin).dispose();
});

it.each(['new-chat', 'close'] as const)('fences a reattachment superseded by %s while outgoing detach is pending', async action => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId;
  await h.view.startNewChat(false, undefined, undefined, { backend: 'systemsculpt' });
  const peer = h.createView();
  await peer.loadChatById(chatId);
  const detaching = deferred(), allowDetach = deferred(), nextQueued = deferred();
  const replace = h.view.replaceAgentSession.bind(h.view);
  let superseding = false;
  h.view.replaceAgentSession = async (target?: string) => {
    if (target === chatId) {
      const detach = h.view.agent.detach.bind(h.view.agent);
      h.view.agent.detach = async () => { detaching.resolve(); await allowDetach.promise; await detach(); };
    }
    const replacement = replace(target);
    if (superseding) nextQueued.resolve();
    await replacement;
  };
  const loading = h.view.loadChatById(chatId);
  await detaching.promise;
  superseding = true;
  const departing = action === 'close' ? h.view.onClose() : h.view.startNewChat(false);
  if (action === 'new-chat') await nextQueued.promise;
  allowDetach.resolve();
  await Promise.all([loading, departing]);
  const departedIdentity = h.view.chatId;
  // A closed/superseded pane must not regain a transcript or metadata subscription.
  peer.chatFontSize = 'small';
  h.finish.resolve({ text: 'Answer after superseded reattachment' });
  await run;
  expect(h.view.chatId).toBe(departedIdentity);
  if (action === 'new-chat') expect(h.view.messages).toEqual([]);
  expect(await h.storage.loadChat(chatId)).toMatchObject({ chatFontSize: 'small', messages: [
    expect.objectContaining({ content: 'Original task' }),
    expect.objectContaining({ content: expect.stringContaining('Answer after superseded reattachment') }),
  ] });
  await nativeChatSessions(h.plugin).dispose();
});

it('closing the last view preserves the native run and its save target', async () => {
  const h = harness('claude');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  const native = await h.started.promise;
  const chatId = h.view.chatId;
  await h.view.onClose();
  expect(native.signal.aborted).toBe(false);
  expect(nativeChatSessions(h.plugin).isWorking(chatId)).toBe(true);
  h.finish.resolve({ text: 'Working after the view closed' });
  await run;
  expect((await h.storage.loadChat(chatId))?.messages.at(-1)?.content).toBe('Working after the view closed');
  await nativeChatSessions(h.plugin).dispose();
});

it('pins the selected live session while the temporary connection detaches', async () => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId, session = h.view.agent;
  await h.view.startNewChat(false);
  const replace = h.view.replaceAgentSession.bind(h.view);
  h.view.replaceAgentSession = async (target?: string) => {
    if (target === chatId) {
      const detach = h.view.agent.detach.bind(h.view.agent);
      h.view.agent.detach = async () => {
        h.finish.resolve({ text: 'Finished during the connection handoff' });
        await run;
        await detach();
      };
    }
    await replace(target);
  };
  await h.view.loadChatById(chatId);
  expect(h.view.agent).toBe(session);
  expect(h.view.messages.at(-1)?.content).toBe('Finished during the connection handoff');
  await nativeChatSessions(h.plugin).dispose();
});

it('keeps saved metadata when a turn finishes during reattachment', async () => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId;
  await h.view.startNewChat(false);
  const loadingQueue = deferred(), resumeQueue = deferred();
  h.view.hydrateQueue = async () => { loadingQueue.resolve(); await resumeQueue.promise; };
  const reopening = h.view.loadChatById(chatId);
  await loadingQueue.promise;
  h.finish.resolve({ text: 'Working — finished while opening' });
  await run;
  resumeQueue.resolve();
  await reopening;
  expect((await h.storage.loadChat(chatId))?.approvalMode).toBe('ask');
  expect(h.view.workspace.setHistory).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ content: 'Working — finished while opening' })]));
  await nativeChatSessions(h.plugin).dispose();
});

it.each([false, true])('preserves a background rename or restores it on failure (failure: %s)', async failRename => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  await h.started.promise;
  const chatId = h.view.chatId, chatPath = h.view.transcript.chatPath(chatId);
  await h.view.startNewChat(false);
  if (failRename) {
    jest.spyOn(h.storage, 'renameChat').mockRejectedValueOnce(new Error('Write failed'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  }
  await h.view.renameSavedChat({ chatId, chatPath, title: 'Original task' }, 'Renamed task');
  h.finish.resolve({ text: 'Background answer' });
  await run;
  expect((await h.storage.loadChat(chatId))?.title).toBe(failRename ? 'Original task' : 'Renamed task');
  if (failRename) expect(console.log).toHaveBeenCalledWith("Notice: This chat couldn't be renamed.");
  await nativeChatSessions(h.plugin).dispose();
});

it.each(['stop', 'delete', 'unload'] as const)('explicit %s still cancels and drains the native turn', async action => {
  const h = harness('codex');
  const run = h.view.executeSubmission({ text: 'Original task', mode: 'send' });
  const native = await h.started.promise;
  const chatId = h.view.chatId, path = h.view.transcript.chatPath(chatId);
  if (action === 'stop') {
    expect(h.view.stopResponse()).toBe(true);
  } else {
    await h.view.startNewChat(false);
    if (action === 'delete') {
      expect(await h.view.deleteSavedChat({ chatId, chatPath: path, title: 'Original task', favorite: false })).toBe(true);
      expect(showConfirm).toHaveBeenCalled();
      expect(h.trashFile).toHaveBeenCalledTimes(1);
    } else await nativeChatSessions(h.plugin).dispose();
  }
  await run;
  expect(native.signal.aborted).toBe(true);
  if (action === 'delete') expect(h.notes.has(path)).toBe(false);
  else expect((await h.storage.loadChat(chatId))?.messages.at(-1)).toMatchObject({ terminalOutcome: 'cancelled' });
  await nativeChatSessions(h.plugin).dispose();
});

it('keeps an approval live offscreen and allows an answer after reattachment', async () => {
  const h = harness('claude');
  const pending = deferred();
  mockRun.mockImplementationOnce(async (_turn, signal: AbortSignal, events) => {
    const permission = events.permission({ toolUseId: 'write-1', requestId: 'request-1', toolName: 'Write', input: { file_path: '/vault/Plan.md' } }, signal);
    pending.resolve();
    const response = await permission;
    return { text: response.approved ? 'Approved edit finished' : 'Denied' };
  });
  const run = h.view.executeSubmission({ text: 'Edit my plan', mode: 'send' });
  await pending.promise;
  const chatId = h.view.chatId;
  await h.view.startNewChat(false);
  expect(h.view.isChatWorkingAnywhere(chatId)).toBe(true);
  await h.view.loadChatById(chatId);
  const session: LocalAgentChatSession = h.view.agent;
  const tool = session.getSnapshot().parts.find(part => part.kind === 'tool');
  expect(tool?.kind === 'tool' && tool.state).toBe('approval-required');
  expect(session.respondToApproval(tool!.kind === 'tool' ? tool!.approvalId! : '', true)).toBe(true);
  await run;
  expect(h.view.messages.at(-1)?.content).toBe('Approved edit finished');
  await nativeChatSessions(h.plugin).dispose();
});
