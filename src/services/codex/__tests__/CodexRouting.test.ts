import { StudioApiExecutionAdapter } from '../../../studio/StudioApiExecutionAdapter';
import { runLocalCodex } from '../LocalCodexClient';
import { codexNode } from '../../../studio/nodes/codexNode';
jest.mock('../LocalCodexClient', () => ({ runLocalCodex: jest.fn() }));
jest.mock('../CodexExecutionSettings', () => ({ codexOptionsFromSettings: () => ({ model: 'gpt-6-astra', effort: 'high', serviceTier: 'default' }), codexVaultDirectory: () => '/vault', usesLocalCodex: (settings: any) => settings?.textExecutionBackend === 'codex' }));

it('routes selected Studio text generation to Codex with no managed request or managed operation receipt', async () => {
  const generateText = jest.fn(() => { throw new Error('Managed text must not run'); });
  const plugin = { app: { vault: { adapter: {}, getName: () => 'test' } }, settings: { textExecutionBackend: 'codex' },
    getManagedCapabilityGraph: () => ({ admission: {}, transport: {} }), getManagedCapabilityClient: () => ({ generateText }) };
  (runLocalCodex as jest.Mock).mockResolvedValue({ text: 'native answer', threadId: 'native-thread', status: 'completed' });
  const result = await new StudioApiExecutionAdapter(plugin as never).generateText({ runId: 'r', nodeId: 'n', projectPath: 'test.systemsculpt', signal: new AbortController().signal, buildPayload: () => ({ prompt: 'Question', systemPrompt: 'Be concise' }) });
  expect(result).toEqual({ text: 'native answer' }); expect(generateText).not.toHaveBeenCalled();
  expect(runLocalCodex).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Be concise\n\nQuestion', workingDirectory: '/vault' }), expect.any(AbortSignal), expect.any(Object));
});
it('executes a Codex task card with its prompt, task input and connected context', async () => {
  const codex = jest.fn(async () => ({ threadId: 'native', turnId: 'turn', text: 'done', status: 'completed' }));
  const result = await codexNode.execute({ node: { config: { prompt: 'Investigate', workingDirectory: '/repo', input: { ticket: 'BLA-1' } } }, services: { codex }, inputs: { context: { observation: 'new' } }, signal: new AbortController().signal, log: jest.fn() } as never);
  expect(codex.mock.calls[0][0]).toMatchObject({ prompt: expect.stringContaining('BLA-1'), workingDirectory: '/repo' });
  expect(result.outputs.json).toMatchObject({ threadId: 'native' });
});
