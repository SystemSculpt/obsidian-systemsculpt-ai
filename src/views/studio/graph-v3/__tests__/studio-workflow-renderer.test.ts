/** @jest-environment jsdom */
import { renderNodeHeader } from '../StudioGraphNodeCardSections';
import { renderStudioWorkflow } from '../StudioWorkflowRenderer';
import { workflowNode } from '../../../../studio/nodes/workflowNode';
import type { StudioNodeInstance } from '../../../../studio/types';

it('keeps saved workflow content readable without exposing execution or changing the definition', async () => {
  const node: StudioNodeInstance = { id: 'flow', kind: 'studio.workflow', version: '1.0.0', title: 'Saved work', position: { x: 0, y: 0 }, config: { description: 'Preserved objective', lastRunId: 'saved-run', pendingRequest: { requestId: 'old-request' } } };
  const before = JSON.stringify(node);
  const root = document.createElement('div'), onChange = jest.fn(), onRunNode = jest.fn();
  const dispose = renderStudioWorkflow(root, { node, onChange });
  expect(root.textContent).toContain('Preserved objective');
  expect(root.textContent).toContain('removed execution integration');
  expect(root.querySelector('button')).toBeNull();
  renderNodeHeader({ nodeEl: root, node, interactionLocked: false, onNodeTitleInput: jest.fn(), onRunNode,
    onCopyTextGenerationPromptBundle: jest.fn(), onToggleTextGenerationOutputLock: jest.fn(), onRemoveNode: jest.fn() });
  const run = root.querySelector<HTMLButtonElement>('[data-testid="studio.node.run"]')!;
  expect(run.disabled).toBe(true);
  run.click(); expect(onRunNode).not.toHaveBeenCalled();
  await expect(workflowNode.execute({ node } as any)).rejects.toThrow('removed execution integration');
  dispose();
  expect(JSON.stringify(node)).toBe(before);
  expect(onChange).not.toHaveBeenCalled();
});
