import { StudioApiExecutionAdapter } from '../../../studio/StudioApiExecutionAdapter';
import { runLocalCodex, type CodexRequest, type CodexResult } from '../LocalCodexClient';
import { codexNode } from '../../../studio/nodes/codexNode';
import { runLocalClaude } from '../../claude/LocalClaudeClient';
jest.mock('../LocalCodexClient', () => ({ runLocalCodex: jest.fn() }));
jest.mock('../CodexExecutionSettings', () => ({ codexOptionsFromSettings: () => ({ model: 'gpt-6-astra', effort: 'high', serviceTier: 'default' }), codexVaultDirectory: () => '/vault', localTextAgent: (settings: any) => ['codex', 'claude'].includes(settings?.textExecutionBackend) ? settings.textExecutionBackend : null }));
jest.mock('../../claude/LocalClaudeClient', () => ({ runLocalClaude: jest.fn(), claudeOptionsFromSettings: () => ({ model: '', permissionMode: 'default' }) }));

it('routes selected Studio text generation to Codex with no managed request or managed operation receipt', async () => {
  const generateText = jest.fn(() => { throw new Error('Managed text must not run'); });
  const plugin = { app: { vault: { adapter: {}, getName: () => 'test' } }, settings: { textExecutionBackend: 'codex' },
    getManagedCapabilityGraph: () => ({ admission: {}, transport: {}, textGeneration: { generate: generateText } }) };
  (runLocalCodex as jest.Mock).mockResolvedValue({ text: 'native answer', threadId: 'native-thread', status: 'completed' });
  const result = await new StudioApiExecutionAdapter(plugin as never).generateText({ runId: 'r', nodeId: 'n', projectPath: 'test.systemsculpt', signal: new AbortController().signal, buildPayload: () => ({ prompt: 'Question', systemPrompt: 'Be concise' }) });
  expect(result).toEqual({ text: 'native answer' }); expect(generateText).not.toHaveBeenCalled();
  expect(runLocalCodex).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Be concise\n\nQuestion', workingDirectory: '/vault' }), expect.any(AbortSignal), expect.any(Object));
});
it('executes a Codex task card with its prompt, task input and connected context', async () => {
  const codex = jest.fn(async (_input: CodexRequest, _signal: AbortSignal, _log: (text: string) => void): Promise<CodexResult> => ({ threadId: 'native', turnId: 'turn', text: 'done', status: 'completed' }));
  const result = await codexNode.execute({ node: { config: { prompt: 'Investigate', workingDirectory: '/repo', input: { ticket: 'BLA-1' } } }, services: { codex }, inputs: { context: { observation: 'new' } }, signal: new AbortController().signal, log: jest.fn() } as never);
  expect(codex.mock.calls[0][0]).toMatchObject({ prompt: expect.stringContaining('BLA-1'), workingDirectory: '/repo' });
  expect(result.outputs.json).toMatchObject({ threadId: 'native' });
});
it('routes selected Studio text generation to Claude Code with no managed request', async () => {
  (runLocalCodex as jest.Mock).mockClear();
  const generateText = jest.fn(() => { throw new Error('Managed text must not run'); });
  const plugin = { app: { vault: { adapter: {}, getName: () => 'test' } }, settings: { textExecutionBackend: 'claude' },
    getManagedCapabilityGraph: () => ({ admission: {}, transport: {}, textGeneration: { generate: generateText } }) };
  (runLocalClaude as jest.Mock).mockResolvedValue({ text: 'claude answer', sessionId: 'session-1234' });
  const result = await new StudioApiExecutionAdapter(plugin as never).generateText({ runId: 'r', nodeId: 'n', projectPath: 'test.systemsculpt', signal: new AbortController().signal, buildPayload: () => ({ prompt: 'Question', systemPrompt: 'Be concise' }) });
  expect(result).toEqual({ text: 'claude answer' }); expect(generateText).not.toHaveBeenCalled(); expect(runLocalCodex).not.toHaveBeenCalled();
  expect(runLocalClaude).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Be concise\n\nQuestion', workingDirectory: '/vault', permissionMode: 'default' }), expect.any(AbortSignal), expect.objectContaining({ permission: expect.any(Function) }));
});
