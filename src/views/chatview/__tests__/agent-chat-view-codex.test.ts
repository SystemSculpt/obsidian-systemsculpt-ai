import { mountCodexExecutionControls } from "../../../services/codex/CodexExecutionControls";
jest.mock("../../../services/codex/CodexExecutionControls", () => ({ mountCodexExecutionControls: jest.fn(() => () => {}) }));
import { AgentChatView } from '../AgentChatView';
import { CodexChatSession } from '../../../services/codex/CodexChatSession';
import { AgentChatSession } from '../agent/ChatSession';

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
