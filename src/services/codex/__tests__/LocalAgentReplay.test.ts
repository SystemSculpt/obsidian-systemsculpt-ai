import type { ChatMessage } from '../../../types';
import { ClaudeChatSession } from '../../claude/ClaudeChatSession';
import { runLocalClaude } from '../../claude/LocalClaudeClient';
import { CodexChatSession } from '../CodexChatSession';
import { runLocalCodex } from '../LocalCodexClient';
import { CodexThreadLocator } from '../CodexThreadLocator';
import { codexActivity } from '../CodexActivity';
import { createTextAttachmentPart } from '../../../chat/ChatAttachmentContent';
import { presentChatMessage } from '../../../views/chatview/ChatMessagePresentation';
import { ChatMarkdownSerializer } from '../../../views/chatview/storage/ChatMarkdownSerializer';
jest.mock('../../claude/LocalClaudeClient', () => {
  const runLocalClaude = jest.fn();
  return { runLocalClaude, claudeSessionPermissionUpdates: () => [], ClaudeChatTransport: jest.fn(() => ({ run: runLocalClaude, close: jest.fn() })) };
});
jest.mock('../LocalCodexClient', () => {
  const runLocalCodex = jest.fn();
  return { runLocalCodex, CodexChatTransport: jest.fn(() => ({ run: runLocalCodex, close: jest.fn() })) };
});
jest.mock('../CodexExecutionSettings', () => ({ localAgentChatDirectory: async () => '/vault' }));
jest.mock('../CodexThreadLocator', () => ({ CodexThreadLocator: jest.fn() }));

/** The prompt check in LocalAgentChatSession. */
const INPUT_LIMIT = 256_000;
const output = (turn: number) => `TOOL-OUTPUT-${turn} ${'file body '.repeat(1_500)}`;
const written = (turn: number) => `WRITTEN-INPUT-${turn} ${'new text '.repeat(500)}`;
type Agent = 'claude' | 'codex';
type Turn = (callbacks: any, turn: number) => Promise<string>;

const claudeTurn: Turn = async (callbacks, turn) => {
  callbacks.text(`Reading note ${turn}.`);
  callbacks.tool({ id: `read-${turn}`, name: 'Read', input: { file_path: `/vault/Notes/note-${turn}.md` }, state: 'running' });
  callbacks.tool({ id: `read-${turn}`, state: 'succeeded', output: output(turn) });
  callbacks.tool({ id: `write-${turn}`, name: 'Write', input: { file_path: `/vault/Notes/summary-${turn}.md`, content: written(turn) }, state: 'running' });
  callbacks.tool({ id: `write-${turn}`, state: 'succeeded', output: `File created successfully. ${output(turn)}` });
  return `Reading note ${turn}.\n\nSummary ${turn} is saved.`;
};
const codexTurn: Turn = async (callbacks, turn) => {
  callbacks.text(`Reading note ${turn}.`);
  const command = { type: 'commandExecution', id: `cat-${turn}`, command: `cat Notes/note-${turn}.md`, cwd: '/vault', aggregatedOutput: output(turn), exitCode: 0, status: 'completed' };
  callbacks.activity(codexActivity('item/completed', { item: command }), command);
  const change = { type: 'fileChange', id: `change-${turn}`, status: 'completed', changes: [{ path: `/vault/Notes/summary-${turn}.md`, kind: { type: 'add' }, diff: written(turn) }] };
  callbacks.activity(codexActivity('item/completed', { item: change }), change);
  return `Reading note ${turn}.\n\nSummary ${turn} is saved.`;
};

/** One chat as AgentChatView drives it: one native session, a saved transcript, and the fork prefix it hands over. */
function chat(agent: Agent, turn: Turn) {
  const threads = new Map<string, string>();
  (CodexThreadLocator as jest.Mock).mockImplementation(() => ({ read: async (id: string) => threads.get(id), write: async (id: string, thread: string) => { threads.set(id, thread); } }));
  const messages: ChatMessage[] = [];
  let prefix: readonly ChatMessage[] = [], forks = 0;
  const persistAssistant = async (message: ChatMessage) => { messages.push(message); };
  const session = agent === 'claude' ? new ClaudeChatSession({} as never, { persistAssistant }, () => prefix) : new CodexChatSession({} as never, { persistAssistant }, () => prefix);
  const native = (agent === 'claude' ? runLocalClaude : runLocalCodex) as jest.Mock;
  let run = turn;
  native.mockImplementation(async (input, _signal, callbacks) => {
    const thread = input.sessionId ?? input.threadId ?? `${agent}-thread-${threads.size + 1}`;
    await (callbacks.session ?? callbacks.thread)(thread);
    return { text: await run(callbacks, Number(/(\d+)\s*$/u.exec(input.prompt)?.[1] ?? 0)) };
  });
  const send = async (conversationId: string, id: string, text: string, onTurn: Turn = turn) => {
    run = onTurn;
    messages.push({ role: 'user', content: text, message_id: id });
    return session.start({ conversationId, turnId: id, message: { id, role: 'user', parts: [{ type: 'text', text }] } });
  };
  /** Retry and edits resend one user message into a new conversation, after the messages before it. */
  const resend = (index: number, text: string, history: readonly ChatMessage[] = messages) => {
    prefix = history.slice(0, index).map(message => ({ ...message }));
    session.disconnect();
    run = async () => 'Done.';
    const id = `resent_${++forks}`;
    return session.start({ conversationId: `forked_${forks}`, turnId: id, message: { id, role: 'user', parts: [{ type: 'text', text }] } });
  };
  const lastCall = () => native.mock.calls.at(-1)![0];
  return { session, messages, send, resend, lastCall };
}

beforeEach(() => jest.clearAllMocks());

it('replays a short chat as a readable transcript of what the person saw', async () => {
  const current = chat('claude', claudeTurn);
  const attached = createTextAttachmentPart('Projects/Launch plan.md', 'text/markdown', new TextEncoder().encode('ATTACHED-BODY: the plan'));
  await current.send('conversation_1', 'user_1', 'Summarize my launch plan.', async callbacks => {
    callbacks.text("I'll read it.");
    callbacks.tool({ id: 'read', name: 'Read', input: { file_path: '/vault/Projects/Launch plan.md' }, state: 'running' });
    callbacks.tool({ id: 'read', state: 'succeeded', output: 'ATTACHED-BODY: the plan' });
    callbacks.text("I'll read it.\n\nThe plan has three phases.");
    return "I'll read it.\n\nThe plan has three phases.";
  });
  Object.assign(current.messages[0], { content: [{ type: 'text', text: 'Summarize my launch plan.' }, attached],
    attachmentMetadata: [{ id: 'plan', name: 'Projects/Launch plan.md', mimeType: 'text/markdown', byteLength: 23, kind: 'text', contentPartIndex: 1 }] });
  await current.send('conversation_1', 'user_2', 'List the project folder.', async callbacks => {
    callbacks.tool({ id: 'find', name: 'Bash', input: { command: 'find Projects\n  -name "*.md"', description: 'List notes' }, state: 'running' });
    callbacks.tool({ id: 'find', state: 'failed', output: 'find: Projects: No such file or directory' });
    callbacks.tool({ id: 'glob', name: 'Glob', input: { pattern: 'Projects/**/*.md' }, state: 'running' });
    callbacks.tool({ id: 'glob', state: 'succeeded', output: 'Projects/Launch plan.md' });
    return 'Only the launch plan is there.';
  });
  await current.send('conversation_1', 'user_3', 'Draft the kickoff email.', async () => { throw new Error('Claude Code exited.'); });
  expect(current.session.getSnapshot().status).toBe('failed');

  await expect(current.resend(4, 'Draft the kickoff email.')).resolves.toMatchObject({ kind: 'completed' });
  expect(current.lastCall()).toMatchObject({ sessionId: undefined, prompt: [
    'Earlier messages in this chat, as the person saw them. Tool results are left out; use your tools again if you need them.',
    'User:\nSummarize my launch plan.\n\nAttached file: Projects/Launch plan.md',
    "Assistant:\nI'll read it.\n\n[Tool: Read /vault/Projects/Launch plan.md]\n\nThe plan has three phases.",
    'User:\nList the project folder.',
    'Assistant:\n[Tool: Bash find Projects -name "*.md" (failed)]\n[Tool: Glob Projects/**/*.md]\n\nOnly the launch plan is there.',
    'Current message:\nDraft the kickoff email.',
  ].join('\n\n') });
  for (const message of current.messages.slice(0, 3).filter(message => message.role === 'user')) {
    const shown = presentChatMessage(message);
    expect(current.lastCall().prompt).toContain(shown.markdown);
    for (const attachment of shown.attachments) expect(current.lastCall().prompt).toContain(attachment.label);
  }
  expect(current.lastCall().prompt).not.toContain('ATTACHED-BODY');
});

describe.each(['claude', 'codex'] as const)('a 40-turn %s chat with large tool outputs', agent => {
  async function longChat() {
    const current = chat(agent, agent === 'claude' ? claudeTurn : codexTurn);
    for (let turn = 1; turn < 40; turn++) await current.send('conversation_1', `user_${turn}`, `Question ${turn}`);
    await current.send('conversation_1', 'user_40', 'Question 40', async (callbacks, turn) => {
      await (agent === 'claude' ? claudeTurn : codexTurn)(callbacks, turn);
      throw new Error(`${agent} exited.`);
    });
    expect(current.session.getSnapshot().status).toBe('failed');
    expect(current.messages).toHaveLength(80);
    return current;
  }
  function expectReplay(prompt: string, turns: number, message: string) {
    expect(prompt.length).toBeLessThanOrEqual(INPUT_LIMIT);
    for (const toolData of ['TOOL-OUTPUT', 'WRITTEN-INPUT', 'file body', 'new text', 'aggregatedOutput', '"native"']) expect(prompt).not.toContain(toolData);
    for (let turn = 1; turn <= turns; turn++) {
      expect(prompt).toContain(`User:\nQuestion ${turn}\n\nAssistant:\nReading note ${turn}.\n\n${agent === 'claude'
        ? `[Tool: Read /vault/Notes/note-${turn}.md]\n[Tool: Write /vault/Notes/summary-${turn}.md]`
        : `[Tool: commandExecution cat Notes/note-${turn}.md]\n[Tool: fileChange /vault/Notes/summary-${turn}.md]`}\n\nSummary ${turn} is saved.\n\n`);
    }
    expect(prompt).not.toContain(`Question ${turns + 1}\n`);
    expect(prompt.endsWith(`\n\nCurrent message:\n${message}`)).toBe(true);
  }

  it('retries the failed last turn in a new native session with a transcript that holds no tool output', async () => {
    const current = await longChat();
    const before = current.messages.findIndex(message => message.message_id === 'user_40');
    // The replaced JSON replay could not retry this chat.
    expect(JSON.stringify(current.messages.slice(0, before)).length).toBeGreaterThan(INPUT_LIMIT);

    await expect(current.resend(before, 'Question 40')).resolves.toMatchObject({ kind: 'completed' });
    expect(current.lastCall()[agent === 'claude' ? 'sessionId' : 'threadId']).toBeUndefined();
    expectReplay(current.lastCall().prompt, 39, 'Question 40');
  });

  it('edits an earlier message, including after the chat is reopened from its note', async () => {
    const current = await longChat();
    const reopened = ChatMarkdownSerializer.readBack(current.messages);
    expect(reopened).toHaveLength(80);
    for (const history of [current.messages, reopened!]) {
      const before = history.findIndex(message => message.message_id === 'user_25');
      expect(JSON.stringify(history.slice(0, before)).length).toBeGreaterThan(INPUT_LIMIT);
      await expect(current.resend(before, 'Question 25, in one paragraph', history)).resolves.toMatchObject({ kind: 'completed' });
      expectReplay(current.lastCall().prompt, 24, 'Question 25, in one paragraph');
    }
  });
});
