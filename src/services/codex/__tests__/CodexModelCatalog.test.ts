import { readCodexCatalog } from '../CodexModelCatalog';
import { connectCodex } from '../CodexAppServer';
jest.mock('../CodexAppServer', () => ({ connectCodex: jest.fn() }));
let now = Date.now();
beforeEach(() => { jest.clearAllMocks(); now += 120_000; jest.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => jest.restoreAllMocks());
it('reads bounded native pages and excludes hidden safety-helper models from the user selector', async () => {
  const request = jest.fn().mockResolvedValueOnce({ config: { approval_policy: 'never', sandbox_mode: 'danger-full-access' } }).mockResolvedValueOnce({ data: [
    { model: 'gpt-6-astra', displayName: 'Astra', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { model: 'platform-reviewer', hidden: true },
  ], nextCursor: 'next' }).mockResolvedValueOnce({ data: [{ model: 'other', supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null });
  const close = jest.fn(); (connectCodex as jest.Mock).mockResolvedValue({ request, close, closed: Promise.resolve() });
  const { models, permissions } = await readCodexCatalog('/vault', new AbortController().signal);
  expect(permissions).toBe('Never ask · Full access');
  expect(request).toHaveBeenNthCalledWith(1, 'config/read', { cwd: '/vault', includeLayers: false });
  expect(models.map(model => model.model)).toEqual(['gpt-6-astra', 'other']);
  expect(models[0]).toMatchObject({ efforts: ['high'], fastTier: 'priority', isDefault: true });
  expect(models[1].isDefault).toBe(false);
  expect(request).toHaveBeenNthCalledWith(3, 'model/list', { limit: 100, includeHidden: false, cursor: 'next' });
  expect(close).toHaveBeenCalled();
  request.mockResolvedValueOnce({ config: { approval_policy: 'untrusted', sandbox_mode: 'read-only' } }).mockResolvedValueOnce({ data: [{ model: 'workspace-model' }] });
  const refreshed = await readCodexCatalog('/other-workspace', new AbortController().signal);
  expect(refreshed.permissions).toBe('Ask for untrusted actions · Read only');
  expect(request).toHaveBeenNthCalledWith(4, 'config/read', { cwd: '/other-workspace', includeLayers: false });
  expect(refreshed.models.map(model => model.model)).toEqual(['workspace-model']);
});
it('shares simultaneous catalog reads without letting one picker cancel the others', async () => {
  let resolveConfig!: (value: unknown) => void;
  const request = jest.fn((method: string) => method === 'config/read'
    ? new Promise(resolve => { resolveConfig = resolve; })
    : Promise.resolve({ data: [] }));
  const close = jest.fn(); jest.mocked(connectCodex).mockResolvedValue({ request, close, closed: Promise.resolve() });
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
it('shares the full display catalog until expiry and refreshes it explicitly on reconnect', async () => {
  let approval = 'never';
  const request = jest.fn(async (method: string) => method === 'config/read'
    ? { config: { approval_policy: approval, sandbox_mode: 'read-only' } }
    : { data: [{ model: 'test-model', supportedReasoningEfforts: [] }] });
  jest.mocked(connectCodex).mockResolvedValue({ request, close: jest.fn(), closed: Promise.resolve() });
  const read = (refresh = false) => readCodexCatalog('/changing-config', new AbortController().signal, refresh);
  await expect(read()).resolves.toMatchObject({ permissions: 'Never ask · Read only' });
  approval = 'untrusted';
  await expect(read()).resolves.toMatchObject({ permissions: 'Never ask · Read only' });
  expect(connectCodex).toHaveBeenCalledTimes(1);
  const refreshed = await Promise.all([read(true), read(true), read()]);
  expect(refreshed.every(catalog => catalog.permissions === 'Ask for untrusted actions · Read only')).toBe(true);
  expect(connectCodex).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2);
  jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  approval = 'never';
  await expect(read()).resolves.toMatchObject({ permissions: 'Never ask · Read only' });
  expect(connectCodex).toHaveBeenCalledTimes(3);
});
it('does not cache failures and rejects an already-canceled reader even with a warm cache', async () => {
  const request = jest.fn().mockRejectedValueOnce(new Error('Disconnected'))
    .mockResolvedValueOnce({ config: {} }).mockResolvedValueOnce({ data: [] });
  const close = jest.fn(); jest.mocked(connectCodex).mockResolvedValue({ request, close, closed: Promise.resolve() });
  await expect(readCodexCatalog('/retry', new AbortController().signal)).rejects.toThrow('Disconnected');
  await expect(readCodexCatalog('/retry', new AbortController().signal)).resolves.toMatchObject({ models: [] });
  const canceled = new AbortController(); canceled.abort();
  await expect(readCodexCatalog('/retry', canceled.signal)).rejects.toThrow('canceled');
  expect(connectCodex).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(2);
});
it('does not let an abandoned late result overwrite a newer catalog', async () => {
  let resolveModels!: (value: unknown) => void;
  const request = jest.fn().mockResolvedValueOnce({ config: {} })
    .mockImplementationOnce(() => new Promise(resolve => { resolveModels = resolve; }))
    .mockResolvedValueOnce({ config: {} }).mockResolvedValueOnce({ data: [{ model: 'new' }] });
  jest.mocked(connectCodex).mockResolvedValue({ request, close: jest.fn(), closed: Promise.resolve() });
  const controller = new AbortController(), old = readCodexCatalog('/late', controller.signal);
  await Promise.resolve(); await Promise.resolve();
  controller.abort(); await expect(old).rejects.toThrow('canceled');
  await readCodexCatalog('/late', new AbortController().signal);
  resolveModels({ data: [{ model: 'old' }] }); await Promise.resolve();
  const catalog = await readCodexCatalog('/late', new AbortController().signal);
  expect(catalog.models.map(model => model.model)).toEqual(['new']);
  expect(connectCodex).toHaveBeenCalledTimes(2);
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
