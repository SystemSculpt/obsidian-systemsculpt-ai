/** @jest-environment jsdom */
import { mountCodexExecutionControls } from '../CodexExecutionControls';
import { readCodexCatalog } from '../CodexModelCatalog';
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true), getHostOperatingSystem: () => 'macOS' }));
jest.mock('../LocalAgentDetection', () => ({ detectLocalAgents: jest.fn(async () => ({ preferred: 'claude' })) }));
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
  expect(parent.querySelector('.ss-codex-permissions')?.textContent).toBe('Codex settings · Never ask · Full access');
  expect(model.disabled).toBe(false); expect(model.value).toBe('gpt-6-astra');
  expect([...thinking.options].map(option => option.value)).toEqual(['high', 'xhigh']);
  speed.value = 'priority'; speed.dispatchEvent(new Event('change')); await flush();
  expect(settings.codexServiceTier).toBe('priority'); expect(speed.title).toContain('more of your Codex allowance');
  expect((parent.querySelector('.ss-codex-controls-status') as HTMLElement).hidden).toBe(true);
  thinking.value = 'xhigh'; thinking.dispatchEvent(new Event('change')); await flush(); expect(settings.codexThinkingLevel).toBe('xhigh');
  model.value = 'other'; model.dispatchEvent(new Event('change')); await flush();
  expect(settings).toEqual({ codexModel: 'other', codexThinkingLevel: 'low', codexServiceTier: 'default' });
  expect([...speed.options].find(option => option.textContent === 'Fast (unavailable)')?.disabled).toBe(true);
  dispose(); expect(offref).toHaveBeenCalled(); expect(parent.children).toHaveLength(0); parent.remove();
});

it('re-detects from settings without changing an explicit choice', async () => {
  const parent = document.createElement('div'); document.body.append(parent);
  const settings = { textExecutionBackend: 'claude', textExecutionBackendExplicit: true, claudePermissionMode: 'auto' };
  const updateSettings = jest.fn();
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  const dispose = mountCodexExecutionControls(parent, plugin as never, {});
  // Chat switches backends from its run line; the summary row is gone.
  expect(parent.querySelector('[data-testid="chat.execution.summary"]')).toBeNull();
  expect((parent.querySelector('.ss-codex-controls') as HTMLElement).hidden).toBe(false);
  (parent.querySelector('[data-testid="chat.execution.detect"]') as HTMLButtonElement).click();
  expect(parent.textContent).toContain('Finding Claude Code or Codex…');
  await flush();
  expect(parent.textContent).toContain('Detected: Claude Code. Your choice is unchanged.');
  expect(updateSettings).not.toHaveBeenCalled();
  dispose(); parent.remove();
});

it('saves a provider switch from settings as the explicit default', async () => {
  const parent = document.createElement('div');
  const settings = { textExecutionBackend: 'systemsculpt', codexModel: 'gpt-6-astra' };
  const updateSettings = jest.fn(async patch => { Object.assign(settings, patch); });
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  const dispose = mountCodexExecutionControls(parent, plugin as never, {});
  const provider = parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement;
  provider.value = 'codex'; provider.dispatchEvent(new Event('change')); await flush();
  expect(updateSettings).toHaveBeenCalledWith({ textExecutionBackend: 'codex', textExecutionBackendExplicit: true });
  expect(provider.value).toBe('codex'); dispose();
});

it('shows portable API controls without starting Codex on a mobile host', async () => {
  const { hasHostCapability } = jest.requireMock('../../../platform/hostCapabilities');
  hasHostCapability.mockReturnValue(false);
  const parent = document.createElement('div');
  const settings = { textExecutionBackend: 'codex' };
  const updateSettings = jest.fn();
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  (readCodexCatalog as jest.Mock).mockClear();
  const dispose = mountCodexExecutionControls(parent, plugin as never, {}); await flush();
  const provider = parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement;
  expect(provider.value).toBe('systemsculpt'); expect(provider.options[1].disabled).toBe(true);
  expect(parent.querySelector('[data-testid="codex.execution.model"]')?.parentElement?.hidden).toBe(true);
  expect(readCodexCatalog).not.toHaveBeenCalled(); expect(updateSettings).not.toHaveBeenCalled();
  expect(settings.textExecutionBackend).toBe('codex'); dispose(); hasHostCapability.mockReturnValue(true);
});
it('keeps a provider-switch failure visible', async () => {
  const parent = document.createElement('div');
  const settings = { textExecutionBackend: 'systemsculpt' };
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings: jest.fn(async () => { throw new Error('Could not save settings'); }) }) };
  const dispose = mountCodexExecutionControls(parent, plugin as never, {});
  const provider = parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement;
  provider.value = 'codex'; provider.dispatchEvent(new Event('change')); await flush();
  expect(parent.querySelector('.ss-codex-controls-status')?.textContent).toBe('Could not save settings');
  expect(provider.value).toBe('systemsculpt'); dispose();
});
it('preserves independent field edits while earlier settings saves are queued', async () => {
  const parent = document.createElement('div');
  const settings = { codexModel: 'gpt-6-astra', codexThinkingLevel: 'high', codexServiceTier: 'default' };
  let finishFirst!: () => void;
  let tail = new Promise<void>(resolve => { finishFirst = resolve; });
  const updateSettings = jest.fn(patch => { tail = tail.then(() => { Object.assign(settings, patch); }); return tail; });
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  jest.mocked(readCodexCatalog).mockResolvedValue({ permissions: '', models: [{ model: 'gpt-6-astra', name: 'Astra', efforts: ['high', 'xhigh'], defaultEffort: 'high', fastTier: 'priority' }] });
  const dispose = mountCodexExecutionControls(parent, plugin as never); await flush();
  const effort = parent.querySelector('[data-testid="codex.execution.thinking"]') as HTMLSelectElement;
  const speed = parent.querySelector('[data-testid="codex.execution.speed"]') as HTMLSelectElement;
  effort.value = 'xhigh'; effort.dispatchEvent(new Event('change'));
  speed.value = 'priority'; speed.dispatchEvent(new Event('change'));
  expect(settings.codexThinkingLevel).toBe('high');
  expect(updateSettings.mock.calls.map(([patch]) => patch)).toEqual([{ codexThinkingLevel: 'xhigh' }, { codexServiceTier: 'priority' }]);
  finishFirst(); await tail; await flush();
  expect(settings).toEqual({ codexModel: 'gpt-6-astra', codexThinkingLevel: 'xhigh', codexServiceTier: 'priority' });
  expect(effort.value).toBe('xhigh'); expect(speed.value).toBe('priority'); dispose();
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

it('offers on-machine Claude Code with its own model and permission choices', async () => {
  const parent = document.createElement('div');
  const settings: Record<string, unknown> = { textExecutionBackend: 'claude', claudeModel: '', claudePermissionMode: 'auto' };
  const updateSettings = jest.fn(async patch => { Object.assign(settings, patch); });
  const plugin = { settings, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings }) };
  (readCodexCatalog as jest.Mock).mockClear();
  const dispose = mountCodexExecutionControls(parent, plugin as never, {}); await flush();
  const provider = parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement;
  expect([...provider.options].map(option => [option.value, option.textContent])).toEqual([['systemsculpt', 'SystemSculpt'], ['codex', 'Codex'], ['claude', 'Claude Code']]);
  expect(provider.value).toBe('claude'); expect(readCodexCatalog).not.toHaveBeenCalled();
  expect(parent.querySelector('[data-testid="codex.execution.model"]')?.parentElement?.hidden).toBe(true);
  const model = parent.querySelector('[data-testid="claude.execution.model"]') as HTMLSelectElement;
  const permissions = parent.querySelector('[data-testid="claude.execution.permissions"]') as HTMLSelectElement;
  expect(model.parentElement?.hidden).toBe(false); expect(permissions.value).toBe('auto');
  expect([...permissions.options].map(option => option.value)).toEqual(['auto', 'manual', 'acceptEdits', 'plan', 'settings']);
  model.value = 'opus'; model.dispatchEvent(new Event('change'));
  permissions.value = 'acceptEdits'; permissions.dispatchEvent(new Event('change')); await flush();
  expect(settings).toMatchObject({ claudeModel: 'opus', claudePermissionMode: 'acceptEdits' });
  dispose();
});
it('marks Claude Code desktop only and hides its options on a mobile host', async () => {
  const { hasHostCapability } = jest.requireMock('../../../platform/hostCapabilities');
  hasHostCapability.mockReturnValue(false);
  const parent = document.createElement('div');
  const plugin = { settings: { textExecutionBackend: 'claude' }, app: { workspace: { on: jest.fn(), offref: jest.fn() } }, getSettingsManager: () => ({ updateSettings: jest.fn() }) };
  const dispose = mountCodexExecutionControls(parent, plugin as never, {}); await flush();
  const claude = [...(parent.querySelector('[data-testid="codex.execution.provider"]') as HTMLSelectElement).options].find(option => option.value === 'claude')!;
  expect(claude.disabled).toBe(true); expect(claude.textContent).toBe('Claude Code · desktop only');
  expect(parent.querySelector('[data-testid="claude.execution.model"]')?.parentElement?.hidden).toBe(true);
  dispose(); hasHostCapability.mockReturnValue(true);
});
