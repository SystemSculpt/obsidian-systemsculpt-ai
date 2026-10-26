/** @jest-environment jsdom */
import { App } from 'obsidian';
import type { ChatMessage } from '../../../types';
import { LocalAgentChatSession } from '../../../services/codex/LocalAgentChatSession';
import { LocalAgentUsageLimitError, type LocalAgentId } from '../../../services/codex/LocalAgents';
import { AgentConversationRenderer } from '../AgentConversationRenderer';
import { presentAgentConversation } from '../AgentConversationPresentation';
import { ChatMarkdownSerializer } from '../storage/ChatMarkdownSerializer';

jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { os: jest.fn(async () => ({ homedir: () => '/home/test' })) } }));
jest.mock('../../../services/codex/CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn(() => ({ read: jest.fn(), write: jest.fn() })) }));
jest.mock('../../../services/codex/CodexExecutionSettings', () => ({ localAgentChatDirectory: jest.fn(async () => '/vault') }));

const input = { conversationId: 'conversation', turnId: 'user-turn', message: { id: 'user-turn', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Check my notes' }] } };
const PARTIAL = 'I checked the first note.';
const cases = (['claude', 'codex'] as LocalAgentId[]).flatMap(agent => [
  { agent, scenario: 'mid-answer failure', partial: true, error: new Error('Native process exited: "unexpected"\nDetails: résumé — <!-- SYSTEMSCULPT-MESSAGE-END -->'), retry: true, detect: false, hosted: false },
  { agent, scenario: 'no-output sign-in failure', partial: false, error: new Error('Not signed in. Please log in.'), retry: true, detect: true, hosted: false },
  { agent, scenario: 'not installed', partial: false, error: new Error('Executable not found: ENOENT'), retry: false, detect: true, hosted: true },
  { agent, scenario: 'usage limit', partial: true, error: new LocalAgentUsageLimitError('Usage limit reached. Resets tomorrow.'), retry: false, detect: false, hosted: true },
  { agent, scenario: 'no-output usage limit', partial: false, error: new LocalAgentUsageLimitError('Usage limit reached. Resets tomorrow.'), retry: false, detect: false, hosted: true },
]);

function errorPresentation(parent: HTMLElement) {
  const error = parent.querySelector('.systemsculpt-agent-part.is-error');
  return {
    heading: error?.querySelector('.systemsculpt-agent-error-heading')?.textContent,
    message: error?.querySelector('.systemsculpt-agent-error-message')?.textContent,
    details: error?.querySelector('.systemsculpt-agent-error-details')?.textContent,
    actions: Array.from(error?.querySelectorAll('button') ?? []).map(button => ({ id: button.dataset.testid, text: button.textContent })),
  };
}

afterEach(() => { jest.clearAllMocks(); document.body.empty(); });

it.each(cases)('keeps $agent $scenario presentation and actions after saving and reopening', async ({ agent, partial, error, retry, detect, hosted }) => {
  const app = new App(), name = agent === 'claude' ? 'Claude Code' : 'Codex';
  const messages: ChatMessage[] = [{ role: 'user', content: 'Check my notes', message_id: input.turnId }];
  const session = new LocalAgentChatSession(app, agent, { persistAssistant: async message => { messages.push(message); } }, () => [], async (_turn, _signal, events) => {
    if (partial) events.text(PARTIAL);
    throw error;
  });
  const callbacks = { onRetryFailedTurn: jest.fn(), onDetectAgain: jest.fn(async () => true), onUseHosted: jest.fn() };
  const options = { app, sourcePath: () => '', backendName: () => name, ...callbacks,
    onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(), onCopyText: jest.fn() };
  const liveParent = document.body.createDiv(), restoredParent = document.body.createDiv();
  const live = new AgentConversationRenderer(liveParent, options), restored = new AgentConversationRenderer(restoredParent, options);
  live.load(); restored.load();
  try {
    const result = await session.start(input);
    expect(result.kind).toBe('failed');
    const snapshot = session.getSnapshot();
    await live.renderHistory(messages.slice(0, 1));
    await live.renderActive(snapshot, presentAgentConversation(snapshot, false));
    const presentation = errorPresentation(liveParent);
    expect(presentation.heading).toContain(name);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe(partial ? PARTIAL : '');

    const parsed = ChatMarkdownSerializer.readBack(messages);
    expect(parsed).not.toBeNull();
    expect(parsed![1]).toMatchObject({ terminalOutcome: 'failed', terminalFailureCode: snapshot.terminalError!.code, terminalRetryable: snapshot.terminalError!.retryable });
    await restored.renderHistory(parsed!);
    expect(restoredParent.querySelectorAll('.systemsculpt-agent-part.is-error')).toHaveLength(1);
    expect(errorPresentation(restoredParent)).toEqual(presentation);
    expect(restoredParent.querySelector('.systemsculpt-agent-error-report')).toBeNull();
    if (partial) expect(restoredParent.textContent).toContain(PARTIAL);
    const retryButton = restoredParent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.retry-failed"]');
    const detectButton = restoredParent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.detect-again"]');
    const hostedButton = restoredParent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.use-hosted"]');
    expect(Boolean(retryButton)).toBe(retry);
    expect(Boolean(detectButton)).toBe(detect);
    expect(Boolean(hostedButton)).toBe(hosted);
    if (retryButton) { retryButton.click(); expect(callbacks.onRetryFailedTurn).toHaveBeenCalledWith(input.turnId); }
    if (detectButton) { detectButton.click(); expect(callbacks.onDetectAgain).toHaveBeenCalledTimes(1); }
    if (hostedButton) { hostedButton.click(); expect(callbacks.onUseHosted).toHaveBeenCalledTimes(1); }
  } finally { live.unload(); restored.unload(); await session.detach(); }
});
