/** @jest-environment jsdom */
import { renderStudioRunCollection, StudioRunDetailModal } from '../StudioRunCollectionRenderer';
import type { StudioAgentRun } from '../../../../services/codex/StudioAgentRunStore';
import { runCollectionPorts } from '../../../../studio/nodes/runCollectionNode';
import { isStudioVisualOnlyNodeKind } from '../../../../studio/StudioNodeKinds';

it('shows distinct instances, keeps their DOM stable during activity, opens details and unsubscribes', async () => {
  const records = ['one','two'].map(id => ({ id, title: 'Worker', nodeId: 'worker', status: 'running', createdAt: new Date().toISOString(), currentActivity: 'Starting', messages: [] })) as unknown as StudioAgentRun[];
  let listener!: (project: string) => void; const unsubscribe = jest.fn();
  const runs = { app: {}, list: () => records, load: async () => {}, hasOlder: () => false, subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe; } } as any;
  const open = jest.spyOn(StudioRunDetailModal.prototype, 'open').mockImplementation(() => {});
  const root = document.createElement('div');
  const dispose = renderStudioRunCollection(root, { runs, projectId: 'p', projectPath: 'p.systemsculpt' }); await Promise.resolve();
  expect(root.querySelectorAll('[data-run-id]')).toHaveLength(2);
  const card = root.querySelector('[data-run-id="one"]')!;
  records[0].currentActivity = 'Running tests'; listener('p');
  expect(root.querySelector('[data-run-id="one"]')).toBe(card); expect(card.textContent).toContain('Running tests');
  card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); expect(open).toHaveBeenCalledTimes(1);
  const input = root.querySelector('input')!; input.value = 'two'; input.dispatchEvent(new Event('input'));
  expect(root.querySelectorAll('[data-run-id]')).toHaveLength(1);
  dispose(); expect(unsubscribe).toHaveBeenCalled(); open.mockRestore();
});
it('offers older runs only while more remain on disk', async () => {
  const records = [{ id: 'new', title: 'Worker', nodeId: 'worker', status: 'completed', createdAt: new Date().toISOString(), currentActivity: 'Done', messages: [] }] as unknown as StudioAgentRun[];
  let listener!: (project: string) => void; let more = true;
  const loadOlder = jest.fn(async () => { records.push({ ...records[0], id: 'old' }); more = false; listener('p'); });
  const runs = { app: {}, list: () => records, load: async () => {}, hasOlder: () => more, loadOlder, subscribe: (callback: typeof listener) => { listener = callback; return () => {}; } } as any;
  const root = document.createElement('div');
  const dispose = renderStudioRunCollection(root, { runs, projectId: 'p', projectPath: 'p.systemsculpt' }); await Promise.resolve();

  const older = root.querySelector<HTMLElement>('[data-testid="studio.run.older"]');
  expect(older).not.toBeNull();
  older!.click(); await Promise.resolve(); await Promise.resolve();

  expect(loadOlder).toHaveBeenCalledWith('p.systemsculpt', 'p');
  expect(root.querySelectorAll('[data-run-id]')).toHaveLength(2);
  expect(root.querySelector('[data-testid="studio.run.older"]')).toBeNull();
  dispose();
});
it('declares bounded observation ports on a visual-only collection', () => {
  expect(isStudioVisualOnlyNodeKind('studio.run_collection')).toBe(true);
  expect(runCollectionPorts(['worker', 'worker', '../bad', 'scout'])).toEqual([{ id: 'worker', type: 'json', required: false }, { id: 'scout', type: 'json', required: false }]);
});
