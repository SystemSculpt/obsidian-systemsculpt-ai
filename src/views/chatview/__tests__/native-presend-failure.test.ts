/** @jest-environment jsdom */
import { App, TFile } from 'obsidian';
import type { ChatMessage } from '../../../types';
import type { AgentRunResult } from '../../../chat/ChatSession';
import type { LocalAgentId } from '../../../services/codex/LocalAgents';
import { CodexThreadLocator } from '../../../services/codex/CodexThreadLocator';
import { localAgentChatDirectory } from '../../../services/codex/CodexExecutionSettings';
import { AgentChatView } from '../AgentChatView';
import { AgentConversationRenderer } from '../AgentConversationRenderer';
import { ChatStorageService } from '../ChatStorageService';
import { NativeChatSessions, nativeChatSessions } from '../NativeChatSessions';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian'), yaml = jest.requireActual('yaml');
  return { ...actual, parseYaml: yaml.parse, stringifyYaml: yaml.stringify };
});
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { os: jest.fn(async () => ({ homedir: () => '/home/test' })) } }));
jest.mock('../../../services/codex/CodexExecutionSettings', () => ({
  ...jest.requireActual('../../../services/codex/CodexExecutionSettings'),
  localAgentChatDirectory: jest.fn(async () => '/vault'),
}));
jest.mock('../../../services/codex/LocalCodexClient', () => ({
  CodexChatTransport: jest.fn(() => ({ run: mockRun, close: jest.fn() })),
}));
jest.mock('../../../services/claude/LocalClaudeClient', () => ({
  ...jest.requireActual('../../../services/claude/LocalClaudeClient'),
  ClaudeChatTransport: jest.fn(() => ({ run: mockRun, close: jest.fn() })),
}));
const mockRun = jest.fn();

/** A real chat view, Markdown chat storage and native session; only the agent process is replaced. */
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
  const storage = new ChatStorageService(app, 'SystemSculpt/Chats');
  const plugin = {
    app,
    settings: { textExecutionBackend: backend, textExecutionBackendExplicit: true, favoriteChats: [] },
    manifest: { version: 'test' },
    getLoadedPluginBuildId: jest.fn(async () => `sha256:${'d'.repeat(64)}`),
    getLogger: () => ({ error: jest.fn() }),
  };
  const view = Object.create(AgentChatView.prototype) as any;
  app.workspace.getLeavesOfType = jest.fn(() => [{ view }] as never);
  const workspace = {
    setPlanOfferVisible: jest.fn(), setRunPending: jest.fn(), setBanner: jest.fn(),
    resetMessageEditor: jest.fn(), setApprovalMode: jest.fn(), setTitle: jest.fn(),
    setHistory: jest.fn(async () => undefined), setAgentSnapshot: jest.fn(async () => undefined),
    setComposerReadOnly: jest.fn(), setChrome: jest.fn(), resetComposerDraft: jest.fn(), restoreRejectedSubmission: jest.fn(),
    settleCompletedRun: jest.fn(async () => undefined), settleUnfinishedRun: jest.fn(async () => undefined),
  };
  let context: { kind: 'text'; path: string; content: string }[] = [];
  Object.assign(view, {
    app, plugin, workspace, chatStorage: storage, containerEl: document.body.createDiv(),
    agentMutationJournal: { idle: async () => {} },
    contextManager: { getPinnedFiles: () => [], setPinnedFiles: async () => {}, clearPinnedFiles: () => {}, dispose: () => {} },
    attachmentStore: { hydrateMessage: async (message: unknown) => message },
    queueRepository: { save: async () => {} },
    conversationOriginToken: 'initial', activeSubmissionOperation: null, runConversationOrigins: new Map(),
    sessionTrustedToolNames: new Set(), queuedFollowUps: [], queueHydrated: false, queuePersistence: Promise.resolve(),
    queueDrainSuppressionDepth: 0, pendingForkHistory: null, pendingRetry: null, pendingRejectedRetry: null,
    messageEditGeneration: 0, chatId: '', chatTitle: 'Notes', chatVersion: 0, chatFontSize: 'medium', approvalMode: 'ask',
    chatExecutionBackend: backend, automationApprovalMode: 'interactive', isFullyLoaded: true, detection: null,
    thinClientId: `client_${'c'.repeat(32)}`, creditsBalance: null,
    readThinAgentContextSources: async () => ({ sources: context, measurement: {} }),
    bindQueueToChat: async () => {}, hydrateQueue: async () => {}, persistQueueState: async () => {},
    applyFontSize: () => {}, syncAttachments: () => {}, syncQueue: () => {}, syncChrome: () => {},
    updateViewState: () => {}, loadCodexCatalog: () => {}, applyBackendAvailability: () => {},
    prepareThinConversation: async () => {}, refreshCreditsBalance: async () => {},
  });
  view.bindTranscript(view.createTranscript());
  view.agent = view.createAgentSession();
  view.bindAgentSession();
  const send = async (text: string) => {
    let result: AgentRunResult | undefined;
    await view.executeSubmission({ text, mode: 'send' }, { onResult: (value: AgentRunResult) => { result = value; } });
    return result!;
  };
  const saved = async () => ((await storage.loadChat(view.chatId))?.messages ?? []) as ChatMessage[];
  return { view, plugin, workspace, send, saved, pinContext: (content: string) => { context = [{ kind: 'text', path: 'Big note.md', content }]; } };
}

function renderer() {
  const parent = document.body.createDiv();
  const options = { app: new App(), sourcePath: () => '', backendName: () => 'Claude Code', onRetryFailedTurn: jest.fn(), onDetectAgain: jest.fn(async () => true), onUseHosted: jest.fn(),
    onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(), onCopyText: jest.fn() };
  const view = new AgentConversationRenderer(parent, options);
  view.load();
  return { parent, view, options };
}

const turns = (messages: readonly ChatMessage[]) => messages.map(message => [message.role, message.content, message.terminalOutcome ?? null]);
const identities = (messages: readonly ChatMessage[]) => messages.map(message => message.message_id);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(CodexThreadLocator.prototype, 'read').mockResolvedValue(undefined);
  jest.spyOn(CodexThreadLocator.prototype, 'write').mockResolvedValue(undefined);
  mockRun.mockImplementation(async () => ({ text: 'First answer' }));
});
afterEach(() => { jest.restoreAllMocks(); document.body.empty(); });

const agents = ['claude', 'codex'] as const;
const preSend = agents.flatMap(agent => [
  { agent, scenario: 'pinned context over the input limit', message: 'input limit', arrange: (h: ReturnType<typeof harness>) => h.pinContext('x'.repeat(260_000)) },
  { agent, scenario: 'chat changed before the request was admitted', message: 'This chat changed before the request was admitted.', arrange: (h: ReturnType<typeof harness>) => {
    jest.mocked(localAgentChatDirectory).mockImplementationOnce(async () => { h.view.conversationOriginToken = 'another chat'; return '/vault'; });
  } },
]);

it.each(preSend)('$agent: a message that fails before sending ($scenario) saves no failed reply', async ({ agent, message, arrange }) => {
  const h = harness(agent);
  expect((await h.send('First question')).kind).toBe('completed');
  const before = await h.saved();
  expect(turns(before)).toEqual([['user', 'First question', null], ['assistant', 'First answer', null]]);
  mockRun.mockClear();

  arrange(h);
  const result = await h.send('Second question');
  expect(result).toMatchObject({ kind: 'failed', error: { message: expect.stringContaining(message) } });
  expect(mockRun).not.toHaveBeenCalled();
  expect(turns(h.view.transcript.snapshot().messages)).toEqual(turns(before));
  const saved = await h.saved();
  expect(turns(saved)).toEqual(turns(before));
  expect(identities(saved)).toEqual(identities(before));
  if (h.view.conversationOriginToken === 'initial') {
    // The composer gets the words back, and Retry resends them as a new message.
    expect(h.workspace.restoreRejectedSubmission).toHaveBeenCalledWith(expect.objectContaining({ text: 'Second question' }));
    expect(h.view.pendingRejectedRetry).toMatchObject({ turnId: result.snapshot.turnId });
  }
  await nativeChatSessions(h.plugin).dispose();
});

it.each(agents)('%s: a message committed before its start fails keeps its failure after reload', async agent => {
  const h = harness(agent);
  await h.send('First question');
  mockRun.mockClear();
  // beforeSend commits the user turn, then registering the native session fails.
  jest.spyOn(NativeChatSessions.prototype, 'retain').mockImplementationOnce(() => { throw new Error('This chat already has a native session.'); });
  const result = await h.send('Second question');
  expect(result.kind).toBe('failed');
  expect(mockRun).not.toHaveBeenCalled();
  const saved = await h.saved();
  expect(turns(saved)).toEqual([['user', 'First question', null], ['assistant', 'First answer', null], ['user', 'Second question', null], ['assistant', '', 'failed']]);
  expect(saved[3]).toMatchObject({ message_id: `${saved[2].message_id}_assistant`, terminalFailureCode: `local_${agent}_failed`, terminalFailureMessage: 'This chat already has a native session.', terminalRetryable: true });
  expect(h.workspace.restoreRejectedSubmission).not.toHaveBeenCalled();

  const restored = renderer();
  await restored.view.renderHistory(saved);
  expect(restored.parent.querySelectorAll('.systemsculpt-agent-part.is-error')).toHaveLength(1);
  restored.parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.retry-failed"]')!.click();
  expect(restored.options.onRetryFailedTurn).toHaveBeenCalledWith(saved[2].message_id);
  restored.view.unload();
  await nativeChatSessions(h.plugin).dispose();
});

it('hides a failed reply that 6.18.0 saved without its own message', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'First question', message_id: 'u1' },
    { role: 'assistant', content: 'First answer', message_id: 'u1_assistant' },
    { role: 'assistant', content: '', message_id: 'u2_assistant', messageParts: [], terminalOutcome: 'failed', terminalFailureCode: 'local_claude_failed',
      terminalFailureMessage: 'This message and its attached context exceed the Claude Code input limit.', terminalRetryable: true },
  ];
  const restored = renderer();
  await restored.view.renderHistory(history);
  expect(restored.parent.textContent).toContain('First answer');
  expect(restored.parent.querySelector('.systemsculpt-agent-part.is-error')).toBeNull();
  expect(restored.parent.querySelector('[data-testid="chat.turn.retry-failed"]')).toBeNull();
  restored.view.unload();
});
