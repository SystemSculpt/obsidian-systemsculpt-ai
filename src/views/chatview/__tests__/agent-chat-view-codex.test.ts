import { mountCodexExecutionControls } from "../../../services/codex/CodexExecutionControls";
jest.mock("../../../services/codex/CodexExecutionControls", () => ({ mountCodexExecutionControls: jest.fn(() => () => {}) }));
import { AgentChatView } from '../AgentChatView';
import { CodexChatSession } from '../../../services/codex/CodexChatSession';
import { AgentChatSession } from '../../../chat/managed/ChatSession';

const prototype = AgentChatView.prototype as any;
function view(backend: 'codex' | 'systemsculpt' = 'codex') {
  return { app: { vault: { adapter: {} } }, plugin: { settings: { textExecutionBackend: backend, licenseKey: '' }, manifest: { version: 'test' } },
    agentBaseUrl: 'https://systemsculpt.com', agentMutationJournal: {}, pendingForkHistory: null,
    creditsBalance: { totalRemaining: 0, availableUnreserved: 0 }, workspace: { setCreditsBalance: jest.fn() } } as any;
}
it('creates native sessions for the selected backend and retains saved-chat routing over the default', () => {
  const native = view(); native.agent = prototype.createAgentSession.call(native);
  expect(native.agent).toBeInstanceOf(CodexChatSession);
  expect(native.agent.forkHistory()).toEqual([]);
  native.pendingForkHistory = { prefix: [{ role: 'user', content: 'Earlier context', message_id: 'earlier' }] };
  expect(native.agent.forkHistory()).toEqual(native.pendingForkHistory.prefix);
  native.chatExecutionBackend = 'systemsculpt';
  expect(prototype.createAgentSession.call(native)).toBeInstanceOf(AgentChatSession);
  expect(prototype.createAgentSession.call(native)).not.toBeInstanceOf(CodexChatSession);
  const saved = view('systemsculpt'); saved.chatExecutionBackend = 'codex';
  expect(prototype.createAgentSession.call(saved)).toBeInstanceOf(CodexChatSession);
});
it('does not block native chat on SystemSculpt credits or show a subscription reminder', async () => {
  const native = view(); native.agent = prototype.createAgentSession.call(native);
  expect(prototype.hasAuthoritativeUnavailableBalance.call(native)).toBe(false);
  expect(prototype.planReminderBanner.call(native)).toBeNull();
  await prototype.refreshCreditsBalance.call(native);
  expect(native.creditsBalance).toBeNull(); expect(native.workspace.setCreditsBalance).toHaveBeenCalledWith(null);
});

it('mounts the active provider after session replacement and opens provider changes in a fresh tab', async () => {
  for (const backend of ['codex', 'systemsculpt'] as const) {
    const current = view(backend);
    current.plugin.openNewChat = jest.fn(async () => {});
    current.workspace.composer = { element: {} };
    current.bindAgentSession = jest.fn();
    current.codexControlsCleanup = jest.fn();
    const oldCleanup = current.codexControlsCleanup;
    current.createAgentSession = () => prototype.createAgentSession.call(current);
    current.agentSessionBinding = { replace: async (create: () => unknown) => create() };
    await prototype.replaceAgentSession.call(current);
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    const context = (mountCodexExecutionControls as jest.Mock).mock.calls.at(-1)[2];
    expect(context.backend).toBe(backend);
    await context.onProviderChange(); expect(current.plugin.openNewChat).toHaveBeenCalledTimes(1);
  }
});

function creditsView() {
  const current = Object.assign(Object.create(prototype), view('systemsculpt'));
  current.plugin.settings.licenseKey = 'test-license';
  current.agent = prototype.createAgentSession.call(current);
  current.bindAgentSession = jest.fn();
  current.agentSessionBinding = { replace: async (create: () => unknown) => create() };
  current.aiService = { readCreditsBalance: jest.fn() };
  current.recordCreditsRefreshLifecycle = jest.fn();
  return current;
}

it('clears already displayed managed credits when restoring a native chat', async () => {
  const current = creditsView();
  current.chatExecutionBackend = 'codex';

  await current.replaceAgentSession();

  expect(current.creditsBalance).toBeNull();
  expect(current.workspace.setCreditsBalance).toHaveBeenLastCalledWith(null);
  expect(current.aiService.readCreditsBalance).not.toHaveBeenCalled();
});

it.each([false, true])('ignores managed balance settlement after native restore and skips queued native refreshes (failure=%s)', async (failure) => {
  const current = creditsView();
  let resolveBalance!: (value: unknown) => void;
  let rejectBalance!: (error: Error) => void;
  current.aiService.readCreditsBalance.mockReturnValue(new Promise((resolve, reject) => {
    resolveBalance = resolve;
    rejectBalance = reject;
  }));
  const pending = current.refreshCreditsBalance({ reason: 'view_open' });
  const queued = current.refreshCreditsBalance({ requireFresh: true });
  current.chatExecutionBackend = 'codex';
  await current.replaceAgentSession();
  if (failure) rejectBalance(new Error('Network unavailable'));
  else resolveBalance({ totalRemaining: 70840, availableUnreserved: 70840 });
  await Promise.all([pending, queued]);

  expect(current.creditsBalance).toBeNull();
  expect(current.workspace.setCreditsBalance).toHaveBeenLastCalledWith(null);
  expect(current.aiService.readCreditsBalance).toHaveBeenCalledTimes(1);
});

it('refreshes managed credits after returning from native without publishing the pre-switch result', async () => {
  const current = creditsView();
  let resolveBalance!: (value: unknown) => void;
  const fresh = { totalRemaining: 42, availableUnreserved: 42 };
  current.aiService.readCreditsBalance
    .mockReturnValueOnce(new Promise(resolve => { resolveBalance = resolve; }))
    .mockResolvedValueOnce(fresh);
  const pending = current.refreshCreditsBalance();
  current.chatExecutionBackend = 'codex';
  await current.replaceAgentSession();
  current.chatExecutionBackend = 'systemsculpt';
  await current.replaceAgentSession();
  resolveBalance({ totalRemaining: 70840, availableUnreserved: 70840 });
  await pending;
  await current.creditsFreshTail;

  expect(current.aiService.readCreditsBalance).toHaveBeenCalledTimes(2);
  expect(current.creditsBalance).toEqual(fresh);
  expect(current.workspace.setCreditsBalance).not.toHaveBeenCalledWith(expect.objectContaining({ totalRemaining: 70840 }));
  expect(current.workspace.setCreditsBalance).toHaveBeenLastCalledWith(fresh);
});

it.each([false, true])('clears the previous account balance and serializes a fresh read after a license change (failure=%s)', async (failure) => {
  const current = creditsView();
  const oldBalance = { totalRemaining: 12, availableUnreserved: 12 };
  const freshBalance = { totalRemaining: 42, availableUnreserved: 42 };
  let resolveOld!: (value: unknown) => void;
  let rejectOld!: (error: Error) => void;
  const requestedKeys: string[] = [];
  current.aiService.readCreditsBalance
    .mockImplementationOnce(async () => {
      requestedKeys.push(current.plugin.settings.licenseKey);
      return oldBalance;
    })
    .mockImplementationOnce(() => {
      requestedKeys.push(current.plugin.settings.licenseKey);
      return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    })
    .mockImplementationOnce(async () => {
      requestedKeys.push(current.plugin.settings.licenseKey);
      return freshBalance;
    });
  await current.refreshCreditsBalance();
  const oldRefresh = current.refreshCreditsBalance();

  current.plugin.settings.licenseKey = 'new-license';
  const newRefresh = current.refreshCreditsBalance({ reason: 'settings_update' });

  expect(current.creditsBalance).toBeNull();
  expect(current.workspace.setCreditsBalance).toHaveBeenLastCalledWith(null);
  expect(current.aiService.readCreditsBalance).toHaveBeenCalledTimes(2);
  if (failure) rejectOld(new Error('Old account request failed'));
  else resolveOld({ totalRemaining: 99, availableUnreserved: 99 });
  await Promise.all([oldRefresh, newRefresh]);

  expect(requestedKeys).toEqual(['test-license', 'test-license', 'new-license']);
  expect(current.creditsBalance).toEqual(freshBalance);
  expect(current.workspace.setCreditsBalance).not.toHaveBeenCalledWith(expect.objectContaining({ totalRemaining: 99 }));
  expect(current.workspace.setCreditsBalance).toHaveBeenLastCalledWith(freshBalance);
});
