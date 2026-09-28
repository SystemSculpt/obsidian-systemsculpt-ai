/** @jest-environment jsdom */
import { renderStudioOrchestrator } from '../StudioOrchestratorRenderer';
import { hasHostCapability } from '../../../../platform/hostCapabilities';
import { createStudioWorkflow } from '../../../../services/codex/StudioWorkflow';
jest.mock('../../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));
jest.mock('../StudioRunDetailModal', () => ({ StudioRunDetailModal: jest.fn(() => ({ open: jest.fn() })) }));
function fixture() {
  const record = { id: 'root', nodeId: 'center', title: 'Orchestrator', status: 'running', currentActivity: 'Planning', workflow: createStudioWorkflow('Verify a local branch') };
  let listener!: (id: string) => void;
  const runs: any = { list: () => [record], get: () => record, canControl: () => true, hasRequest: () => false, subscribe: (fn: any) => { listener = fn; return jest.fn(); }, load: async () => {}, startWorkflow: jest.fn(async () => record), send: jest.fn(async () => ({ status: 'delivered' })), stop: jest.fn() };
  const root = document.createElement('div');
  const dispose = renderStudioOrchestrator(root, { runs, projectId: 'p', projectPath: 'p.systemsculpt', centerId: 'center', execution: () => () => {} });
  return { root, runs, record, update: () => listener('p'), dispose };
}
afterEach(() => { jest.mocked(hasHostCapability).mockReturnValue(true); document.body.replaceChildren(); });
it('launches only on explicit submission and keeps follow-up drafts during plan changes', async () => {
  const { root, runs, record, update, dispose } = fixture();
  expect(runs.startWorkflow).not.toHaveBeenCalled();
  const prompt = root.querySelector<HTMLTextAreaElement>('[data-testid="studio.workflow.prompt"]')!;
  prompt.value = 'Find a benchmark; stop at a local branch'; root.querySelector<HTMLButtonElement>('[data-testid="studio.workflow.start"]')!.click();
  await Promise.resolve(); expect(runs.startWorkflow).toHaveBeenCalledWith('p.systemsculpt', 'center', prompt.value || 'Find a benchmark; stop at a local branch');
  document.body.appendChild(root);
  const followup = root.querySelector<HTMLTextAreaElement>('[aria-label="Steer this workflow"]')!; followup.value = 'Use this fixture'; followup.focus();
  record.workflow.steps = [{ id: 'read', title: 'Read fixture', status: 'running', detail: 'Evidence', dependsOn: [] }]; update();
  expect(root.textContent).toContain('Read fixture'); expect(document.activeElement).toBe(followup); expect(root.querySelector('[aria-label="Steer this workflow"]')).toBe(followup); expect(followup.value).toBe('Use this fixture');
  root.querySelector<HTMLButtonElement>('[data-testid="studio.workflow.send"]')!.click(); await Promise.resolve();
  expect(runs.send).toHaveBeenCalledWith('root', 'Use this fixture'); dispose();
});
it('shows saved plans on mobile without a desktop launch control', () => {
  jest.mocked(hasHostCapability).mockReturnValue(false); const { root, dispose } = fixture();
  expect(root.querySelector('[data-testid="studio.workflow.prompt"]')).toBeNull();
  expect(root.querySelector('[data-testid="studio.workflow.start"]')).toBeNull();
  expect(root.textContent).toContain('Verify a local branch'); dispose();
});
