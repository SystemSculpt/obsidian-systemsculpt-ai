/** @jest-environment jsdom */
import { mountCodexExecutionControls } from '../CodexExecutionControls';
import { readCodexCatalog } from '../CodexModelCatalog';
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));
jest.mock('../CodexModelCatalog', () => ({ readCodexCatalog: jest.fn() }));
jest.mock('../CodexExecutionSettings', () => ({ ...jest.requireActual('../CodexExecutionSettings'), codexVaultDirectory: () => '/vault' }));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
it('shows native models, model-specific thinking and Normal/Fast, and saves the next-turn choices', async () => {
  const parent = document.createElement('div'); document.body.append(parent);
  const settings = { codexModel: 'gpt-6-astra', codexThinkingLevel: 'high', codexServiceTier: 'default' };
  const updateSettings = jest.fn(async patch => { Object.assign(settings, patch); });
  const offref = jest.fn();
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref } }, getSettingsManager: () => ({ updateSettings }) };
  (readCodexCatalog as jest.Mock).mockResolvedValue({ permissions: 'Never ask · Full access', models: [
    { model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['high', 'xhigh'], defaultEffort: 'high', fastTier: 'priority' },
    { model: 'other', name: 'Other model', efforts: ['low'], defaultEffort: 'low' },
  ] });
  const dispose = mountCodexExecutionControls(parent, plugin as never); await flush();
  const model = parent.querySelector('[data-testid="codex.execution.model"]') as HTMLSelectElement;
  const thinking = parent.querySelector('[data-testid="codex.execution.thinking"]') as HTMLSelectElement;
  const speed = parent.querySelector('[data-testid="codex.execution.speed"]') as HTMLSelectElement;
  expect(parent.classList.contains('ss-native-codex-composer')).toBe(true);
  expect(parent.querySelector('.ss-codex-permissions')?.textContent).toBe('Permissions · Never ask · Full access');
  expect(model.disabled).toBe(false); expect(model.value).toBe('gpt-6-astra');
  expect([...thinking.options].map(option => option.value)).toEqual(['high', 'xhigh']);
  speed.value = 'priority'; speed.dispatchEvent(new Event('change')); await flush();
  expect(settings.codexServiceTier).toBe('priority'); expect(speed.title).toContain('more of your Codex allowance');
  expect((parent.querySelector('.ss-codex-controls-status') as HTMLElement).hidden).toBe(true);
  thinking.value = 'xhigh'; thinking.dispatchEvent(new Event('change')); await flush(); expect(settings.codexThinkingLevel).toBe('xhigh');
  model.value = 'other'; model.dispatchEvent(new Event('change')); await flush();
  expect(settings).toEqual({ codexModel: 'other', codexThinkingLevel: 'low', codexServiceTier: 'default' });
  expect([...speed.options].find(option => option.textContent === 'Fast (unavailable)')?.disabled).toBe(true);
  dispose(); expect(parent.classList.contains('ss-native-codex-composer')).toBe(false); expect(offref).toHaveBeenCalled(); expect(parent.children).toHaveLength(0); parent.remove();
});

it('saves a provider switch before opening a new tab and leaves this chat on its original provider', async () => {
  const parent = document.createElement('div');
  const settings = { textExecutionBackend: 'systemsculpt', codexModel: 'gpt-6-astra' };
  const updateSettings = jest.fn(async patch => { Object.assign(settings, patch); });
  const onProviderChange = jest.fn(async () => { expect(settings.textExecutionBackend).toBe('codex'); });
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  const dispose = mountCodexExecutionControls(parent, plugin as never, { backend: 'systemsculpt', onProviderChange });
  const provider = parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement;
  provider.value = 'codex'; provider.dispatchEvent(new Event('change')); await flush();
  expect(onProviderChange).toHaveBeenCalledTimes(1); expect(provider.value).toBe('systemsculpt');
  expect(parent.textContent).not.toContain('keeps this tab'); dispose();
});

it('shows portable API controls without starting Codex on a mobile host', async () => {
  const { hasHostCapability } = jest.requireMock('../../../platform/hostCapabilities');
  hasHostCapability.mockReturnValue(false);
  const parent = document.createElement('div');
  const settings = { textExecutionBackend: 'codex' };
  const updateSettings = jest.fn();
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  (readCodexCatalog as jest.Mock).mockClear();
  const dispose = mountCodexExecutionControls(parent, plugin as never, { backend: 'systemsculpt' }); await flush();
  const provider = parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement;
  expect(provider.value).toBe('systemsculpt'); expect(provider.options[1].disabled).toBe(true);
  expect(parent.querySelector('[data-testid="codex.execution.model"]')?.parentElement?.hidden).toBe(true);
  expect(readCodexCatalog).not.toHaveBeenCalled(); expect(updateSettings).not.toHaveBeenCalled();
  expect(settings.textExecutionBackend).toBe('codex'); dispose(); hasHostCapability.mockReturnValue(true);
});

it('lets the user reconnect after a native catalog error and restores saved choices after remount', async () => {
  const parent = document.createElement('div');
  const settings = { codexModel: 'gpt-6-astra', codexThinkingLevel: 'high', codexServiceTier: 'priority' };
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings: jest.fn() }) };
  (readCodexCatalog as jest.Mock).mockRejectedValueOnce(new Error('Codex is not signed in')).mockResolvedValue({ permissions: 'Never ask · Full access', models: [{ model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['high'], defaultEffort: 'high', fastTier: 'priority' }] });
  let dispose = mountCodexExecutionControls(parent, plugin as never); await flush();
  const retry = parent.querySelector('button')!; expect(retry.hidden).toBe(false); retry.click(); await flush();
  expect(retry.hidden).toBe(true); expect((parent.querySelector('[data-testid="codex.execution.speed"]') as HTMLSelectElement).value).toBe('priority');
  dispose(); dispose = mountCodexExecutionControls(parent, plugin as never); await flush();
  expect((parent.querySelector('[data-testid="codex.execution.speed"]') as HTMLSelectElement).value).toBe('priority'); dispose();
});
