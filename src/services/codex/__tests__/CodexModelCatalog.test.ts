import { readCodexCatalog } from '../CodexModelCatalog';
import { connectCodex } from '../CodexAppServer';
jest.mock('../CodexAppServer', () => ({ connectCodex: jest.fn() }));
let now = Date.now();
beforeEach(() => { jest.clearAllMocks(); now += 120_000; jest.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => jest.restoreAllMocks());
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
it('shares simultaneous catalog reads without letting one picker cancel the others', async () => {
  let resolveConfig!: (value: unknown) => void;
  const request = jest.fn((method: string) => method === 'config/read'
    ? new Promise(resolve => { resolveConfig = resolve; })
    : Promise.resolve({ data: [] }));
  const close = jest.fn(); jest.mocked(connectCodex).mockResolvedValue({ request, close });
  const firstController = new AbortController(), secondController = new AbortController();
  const first = readCodexCatalog('/shared-workspace', firstController.signal);
  const second = readCodexCatalog('/shared-workspace', secondController.signal);
  await Promise.resolve();
  const sharedSignal = jest.mocked(connectCodex).mock.calls[0][1];
  expect(connectCodex).toHaveBeenCalledTimes(1);
  firstController.abort(); await expect(first).rejects.toThrow('canceled');
  expect(sharedSignal.aborted).toBe(false);
  resolveConfig({ config: { approval_policy: 'untrusted', sandbox_mode: 'read-only' } });
  await expect(second).resolves.toMatchObject({ permissions: 'Ask for untrusted actions · Read only' });
  expect(close).toHaveBeenCalledTimes(1);
});
it('refreshes native permissions on a later same-workspace read while reusing only model data', async () => {
  let approval = 'never';
  const request = jest.fn(async (method: string) => method === 'config/read'
    ? { config: { approval_policy: approval, sandbox_mode: 'read-only' } }
    : { data: [{ model: 'test-model', supportedReasoningEfforts: [] }] });
  jest.mocked(connectCodex).mockResolvedValue({ request, close: jest.fn() });
  await expect(readCodexCatalog('/changing-config', new AbortController().signal)).resolves.toMatchObject({ permissions: 'Never ask · Read only' });
  approval = 'untrusted';
  await expect(readCodexCatalog('/changing-config', new AbortController().signal)).resolves.toMatchObject({ permissions: 'Ask for untrusted actions · Read only' });
  expect(connectCodex).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1);
});
it('closes abandoned catalog reads and starts a fresh request for a later picker', async () => {
  jest.mocked(connectCodex).mockImplementation((_cwd, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Native transport canceled.')), { once: true });
  }));
  const controller = new AbortController(), first = readCodexCatalog('/abandoned', controller.signal);
  const sharedSignal = jest.mocked(connectCodex).mock.calls[0][1];
  controller.abort(); await expect(first).rejects.toThrow('canceled'); expect(sharedSignal.aborted).toBe(true);
  const secondController = new AbortController(), second = readCodexCatalog('/abandoned', secondController.signal);
  expect(connectCodex).toHaveBeenCalledTimes(2); secondController.abort(); await expect(second).rejects.toThrow('canceled');
});
