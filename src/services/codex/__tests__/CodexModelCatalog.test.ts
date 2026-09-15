import { readCodexCatalog } from '../CodexModelCatalog';
import { connectCodex } from '../CodexAppServer';
jest.mock('../CodexAppServer', () => ({ connectCodex: jest.fn() }));
it('reads bounded native pages and excludes hidden safety-helper models from the user selector', async () => {
  const request = jest.fn().mockResolvedValueOnce({ config: { approval_policy: 'never', sandbox_mode: 'danger-full-access' } }).mockResolvedValueOnce({ data: [
    { model: 'gpt-6-astra', displayName: 'Astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { model: 'platform-reviewer', hidden: true },
  ], nextCursor: 'next' }).mockResolvedValueOnce({ data: [{ model: 'other', supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null });
  const close = jest.fn(); (connectCodex as jest.Mock).mockResolvedValue({ request, close });
  const { models, permissions } = await readCodexCatalog('/vault', new AbortController().signal);
  expect(permissions).toBe('Never ask · Full access');
  expect(request).toHaveBeenNthCalledWith(1, 'config/read', { cwd: '/vault', includeLayers: false });
  expect(models.map(model => model.model)).toEqual(['gpt-6-astra', 'other']);
  expect(models[0]).toMatchObject({ efforts: ['high'], fastTier: 'priority' });
  expect(request).toHaveBeenNthCalledWith(3, 'model/list', { limit: 100, includeHidden: false, cursor: 'next' });
  expect(close).toHaveBeenCalled();
  request.mockResolvedValueOnce({ config: { approval_policy: 'untrusted', sandbox_mode: 'read-only' } });
  const refreshed = await readCodexCatalog('/other-workspace', new AbortController().signal);
  expect(refreshed.permissions).toBe('Ask for untrusted actions · Read only');
  expect(request).toHaveBeenLastCalledWith('config/read', { cwd: '/other-workspace', includeLayers: false });
  expect(refreshed.models).toEqual(models);
});
