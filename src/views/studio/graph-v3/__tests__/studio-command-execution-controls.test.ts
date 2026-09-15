/** @jest-environment jsdom */
import { renderStudioCommandExecution } from '../StudioCommandExecutionControls';
import { readCodexCatalog } from '../../../../services/codex/CodexModelCatalog';
import { hasHostCapability } from '../../../../platform/hostCapabilities';
jest.mock('../../../../services/codex/CodexModelCatalog', () => ({ readCodexCatalog: jest.fn() }));
jest.mock('../../../../services/codex/CodexExecutionSettings', () => ({ ...jest.requireActual('../../../../services/codex/CodexExecutionSettings'), codexVaultDirectory: () => '/vault' }));
jest.mock('../../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));
const models = [{ model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['high', 'xhigh'], defaultEffort: 'high', fastTier: 'priority' }, { model: 'test-model', name: 'Test model', efforts: ['low', 'medium'], defaultEffort: 'medium' }];
beforeEach(() => { jest.mocked(hasHostCapability).mockReturnValue(true); jest.mocked(readCodexCatalog).mockReset().mockResolvedValue({ models, permissions: '' }); });
async function fixture(value?: unknown) {
  const root = document.createElement('div'), onChange = jest.fn();
  const dispose = renderStudioCommandExecution(root, { value, app: {} as any, onChange });
  await Promise.resolve(); await Promise.resolve();
  return { root, onChange, dispose, model: root.querySelectorAll('select')[0], effort: root.querySelectorAll('select')[1] };
}
it('uses native models, saves compatible reasoning atomically and never offers a fast control', async () => {
  const f = await fixture(); expect(f.model.value).toBe('gpt-6-astra'); expect(f.effort.value).toBe('high');
  expect(f.root.querySelectorAll('select')).toHaveLength(2); expect(f.root.textContent).toContain('Standard'); expect(f.root.textContent).not.toMatch(/Fast|Priority/);
  f.model.value = 'test-model'; f.model.dispatchEvent(new Event('change'));
  expect(f.onChange).toHaveBeenLastCalledWith({ model: 'test-model', effort: 'medium' });
  f.effort.value = 'low'; f.effort.dispatchEvent(new Event('change'));
  expect(f.onChange).toHaveBeenLastCalledWith({ model: 'test-model', effort: 'low' }); f.dispose();
});
it('shows saved settings on mobile without connecting', async () => {
  jest.mocked(hasHostCapability).mockReturnValue(false); const f = await fixture();
  expect(f.model.disabled).toBe(true); expect(f.effort.disabled).toBe(true); expect(readCodexCatalog).not.toHaveBeenCalled(); f.dispose();
});
it('preserves an unavailable saved model and permits selecting an available one', async () => {
  const f = await fixture({ model: 'unavailable', effort: 'high' }); expect(f.model.value).toBe('unavailable'); expect(f.root.textContent).toContain('unavailable'); expect(f.onChange).not.toHaveBeenCalled(); f.dispose();
});
it('offers retry after catalog failure and ignores late resolution after teardown', async () => {
  jest.mocked(readCodexCatalog).mockRejectedValueOnce(new Error('Disconnected'));
  const f = await fixture(); expect(f.root.textContent).toContain('Disconnected'); f.root.querySelector<HTMLButtonElement>('button')!.click();
  await Promise.resolve(); await Promise.resolve(); expect(f.model.disabled).toBe(false); f.dispose();
  let resolve!: (value: any) => void;
  jest.mocked(readCodexCatalog).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const g = await fixture(); g.dispose(); resolve({ models, permissions: '' }); await Promise.resolve(); expect(g.model.disabled).toBe(true);
});
