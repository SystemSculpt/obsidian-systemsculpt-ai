/** @jest-environment node */
import { TFile } from 'obsidian';
import { FileOperations } from '../tools/FileOperations';
import { planFileWrite } from '../fileMutationPlan';
import { prepareWriteEditPreview } from '../../../views/chatview/ToolCallPreview';
import type { ToolCall } from '../../../types/toolCalls';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', messageId: 'assistant-1', request: { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }, state: 'executing', timestamp: 1 };
}

function harness(original = 'BEFORE') {
  const file = new TFile({ path: 'Notes/Log.md' });
  const writes: string[] = [];
  const vault = {
    getAbstractFileByPath: jest.fn(() => file),
    read: jest.fn(async () => original),
    modify: jest.fn(async (_file: TFile, content: string) => { writes.push(content); }),
    process: jest.fn(async (_file: TFile, transform: (current: string) => string) => { writes.push(transform(original)); }),
  };
  const app = { vault };
  return { app, vault, writes, operations: new FileOperations(app as never, ['/']) };
}

describe('shared pure file mutation planning', () => {
  it.each(['overwrite', 'append', 'skip'] as const)('keeps preview and execution aligned for %s without normalizing write bytes', async ifExists => {
    const h = harness('BEFORE\r\n');
    const params = { path: 'Notes/Log.md', content: 'AFTER', ifExists, appendNewline: true };
    const preview = await prepareWriteEditPreview(h.app as never, call('write', params));
    await h.operations.writeFile(params);
    expect(preview?.oldContent).toBe('BEFORE\r\n');
    if (ifExists === 'skip') {
      expect(h.writes).toEqual([]);
      expect(preview?.newContent).toBe('BEFORE\r\n');
      expect(preview?.status).toBe('identical');
    } else expect(h.writes).toEqual([preview?.newContent]);
  });

  it('reports error-on-existing instead of previewing an overwrite', async () => {
    const h = harness();
    const params = { path: 'Notes/Log.md', content: 'AFTER', ifExists: 'error' as const };
    const preview = await prepareWriteEditPreview(h.app as never, call('write', params));
    expect(preview).toMatchObject({ status: 'unavailable', oldContent: 'BEFORE', newContent: 'BEFORE', notice: 'File already exists: Notes/Log.md' });
    await expect(h.operations.writeFile(params)).rejects.toThrow('File already exists: Notes/Log.md');
    expect(h.writes).toEqual([]);
  });

  it.each([undefined, true])('does not preview partial writes when strict is %s', async strict => {
    const h = harness();
    const params = { path: 'Notes/Log.md', edits: [{ oldText: 'BEFORE', newText: 'AFTER' }, { oldText: 'MISSING', newText: 'REPLACED' }], strict };
    const preview = await prepareWriteEditPreview(h.app as never, call('edit', params));
    expect(preview).toMatchObject({ status: 'unmatched', newContent: 'BEFORE', appliedCount: 0, requestedCount: 2, skipped: [{ index: 1, reason: 'Edit produced no changes' }] });
    await expect(h.operations.editFile(params)).rejects.toThrow('Edit produced no changes');
    expect(h.writes).toEqual([]);
  });

  it('shares partial application only when strict is explicitly false', async () => {
    const h = harness();
    const params = { path: 'Notes/Log.md', edits: [{ oldText: 'BEFORE', newText: 'AFTER' }, { oldText: 'MISSING', newText: 'REPLACED' }], strict: false };
    const preview = await prepareWriteEditPreview(h.app as never, call('edit', params));
    const result = await h.operations.editFile(params);
    expect(h.writes).toEqual([preview?.newContent]);
    expect(preview).toMatchObject({ status: 'changed', newContent: 'AFTER', appliedCount: result.appliedCount, skipped: result.skipped });
  });

  it('does not turn an existing-file read failure into an invented empty-before change', async () => {
    const h = harness();
    h.vault.read.mockRejectedValue(new Error('cannot read'));
    const params = { path: 'Notes/Log.md', content: 'AFTER', ifExists: 'append' as const };
    const preview = await prepareWriteEditPreview(h.app as never, call('write', params));
    expect(preview).toMatchObject({ status: 'unavailable', oldContent: '', newContent: '' });
    expect(preview?.isNewFile).not.toBe(true);
    await expect(h.operations.writeFile(params)).rejects.toThrow('cannot read');
    expect(h.writes).toEqual([]);
  });

  it('uses every write policy as creation when no file exists and requires append source bytes', () => {
    for (const ifExists of ['overwrite', 'append', 'skip', 'error']) {
      expect(planFileWrite({ path: 'new.md', exists: false, content: 'new', ifExists }))
        .toEqual({ disposition: 'write', modifiedContent: 'new' });
    }
    expect(() => planFileWrite({ path: 'existing.md', exists: true, content: 'new', ifExists: 'append' }))
      .toThrow('Append planning requires the current file content.');
  });
});
