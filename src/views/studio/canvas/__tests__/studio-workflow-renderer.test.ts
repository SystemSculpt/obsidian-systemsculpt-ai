/** @jest-environment jsdom */
import { renderNodeHeader } from '../StudioGraphNodeCardSections';
import { renderStudioWorkflow } from '../StudioWorkflowRenderer';
import { workflowNode } from '../../../../studio/nodes/workflowNode';
import type { StudioNodeInstance } from '../../../../studio/types';

it('keeps saved workflow content readable without exposing execution or changing the definition', async () => {
  const node: StudioNodeInstance = { id: 'flow', kind: 'studio.workflow', version: '1.0.0', title: 'Saved work', position: { x: 0, y: 0 }, config: { description: 'Preserved objective', lastRunId: 'saved-run', pendingRequest: { requestId: 'old-request' } } };
  const before = JSON.stringify(node);
  const root = document.createElement('div'), onRunNode = jest.fn();
  const dispose = renderStudioWorkflow(root, { node });
  expect(root.textContent).toContain('Preserved objective');
  expect(root.textContent).toContain('Retired workflow note');
  expect(root.textContent).toContain('removed execution integration');
  expect(root.textContent).toContain('source toggle');
  expect(root.querySelector('[role="status"]')).not.toBeNull();
  expect(root.querySelector('button')).toBeNull();
  renderNodeHeader({ nodeEl: root, node, interactionLocked: false, onNodeTitleInput: jest.fn(), onRunNode,
    onCopyTextGenerationPromptBundle: jest.fn(), onToggleTextGenerationOutputLock: jest.fn(), onRemoveNode: jest.fn() });
  expect(root.querySelector('[data-testid="studio.node.run"]')).toBeNull();
  expect(onRunNode).not.toHaveBeenCalled();
  await expect(workflowNode.execute({ node } as any)).resolves.toEqual({ outputs: {} });
  dispose();
  expect(JSON.stringify(node)).toBe(before);
});
