/** @jest-environment node */
import { TFile, TFolder } from 'obsidian';
import { FileOperations } from '../tools/FileOperations';
import { planFileWrite } from '../fileMutationPlan';
import { prepareWriteEditPreview, prepareWriteEditPreviews } from '../../../views/chatview/ToolCallPreview';
import { createEmptyStudioProject, serializeStudioProject } from '../../../studio/schema';
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

function vaultHarness(indexed: Record<string, string> = {}, hidden: Record<string, string> = {}) {
  const content = new Map(Object.entries(indexed));
  const adapterContent = new Map(Object.entries(hidden));
  const files = new Map(Object.keys(indexed).map(path => [path, new TFile({ path })]));
  const folders = new Map<string, TFolder>();
  const writes: Array<{ path: string; content: string }> = [];
  const adapter = {
    exists: jest.fn(async (path: string) => adapterContent.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => {
      const value = adapterContent.get(path);
      if (value === undefined) throw new Error(`Not found: ${path}`);
      return value;
    }),
    write: jest.fn(async (path: string, value: string) => { adapterContent.set(path, value); writes.push({ path, content: value }); }),
    mkdir: jest.fn(async (path: string) => { folders.set(path, new TFolder({ path })); }),
  };
  const vault = {
    adapter,
    getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? folders.get(path) ?? null),
    read: jest.fn(async (file: TFile) => content.get(file.path)!),
    modify: jest.fn(async (file: TFile, value: string) => { content.set(file.path, value); writes.push({ path: file.path, content: value }); }),
    process: jest.fn(async (file: TFile, transform: (current: string) => string) => {
      const value = transform(content.get(file.path)!);
      content.set(file.path, value);
      writes.push({ path: file.path, content: value });
    }),
    create: jest.fn(async (path: string, value: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      const file = new TFile({ path });
      files.set(path, file); content.set(path, value); writes.push({ path, content: value });
      return file;
    }),
  };
  const app = { vault };
  return { app, vault, adapter, adapterContent, content, folders, writes, operations: new FileOperations(app as never, ['/']) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const hiddenPath = '.systemsculpt/capture/log.md';

describe('hosted mutation preparation parity and serialization', () => {
  it.each(['overwrite', 'append', 'edit'] as const)('reads adapter-only before-content for %s previews and execution', async mode => {
    const h = vaultHarness({}, { [hiddenPath]: 'BEFORE\r\n' });
    const edit = { path: hiddenPath, edits: [{ oldText: 'BEFORE', newText: 'AFTER' }] };
    const write = { path: hiddenPath, content: 'AFTER', ifExists: mode === 'edit' ? undefined : mode };
    const params = mode === 'edit' ? edit : write;
    const preview = await prepareWriteEditPreview(h.app as never, call(mode === 'edit' ? 'edit' : 'write', params));
    expect(preview).toMatchObject({ path: hiddenPath, oldContent: mode === 'edit' ? 'BEFORE\n' : 'BEFORE\r\n', status: 'changed' });
    expect(preview?.isNewFile).not.toBe(true);
    if (mode === 'edit') await h.operations.editFile(edit);
    else await h.operations.writeFile(write);
    expect(h.writes).toEqual([{ path: hiddenPath, content: preview?.newContent }]);
    expect(h.vault.read).not.toHaveBeenCalled();
  });

  it.each(['skip', 'error'] as const)('does not mistake adapter-only existing files for creation under %s', async ifExists => {
    const h = vaultHarness({}, { [hiddenPath]: 'BEFORE' });
    const params = { path: hiddenPath, content: 'AFTER', ifExists };
    const preview = await prepareWriteEditPreview(h.app as never, call('write', params));
    expect(preview).toMatchObject({ oldContent: 'BEFORE', newContent: 'BEFORE', status: ifExists === 'skip' ? 'identical' : 'unavailable' });
    expect(preview?.isNewFile).not.toBe(true);
    if (ifExists === 'error') await expect(h.operations.writeFile(params)).rejects.toThrow('File already exists');
    else await h.operations.writeFile(params);
    expect(h.writes).toEqual([]);
  });

  it('resolves portable collisions to the same new destination without reading an unrelated safe-name file', async () => {
    const h = vaultHarness({ 'a b.md': 'unrelated' });
    const params = { path: 'a:b.md', content: 'new note', createDirs: false };
    const preview = await prepareWriteEditPreview(h.app as never, call('write', params));
    expect(preview).toMatchObject({ path: 'a b 1.md', oldContent: '', newContent: 'new note', isNewFile: true });
    const result = await h.operations.writeFile(params);
    expect(result).toMatchObject({ path: preview?.path, requestedPath: 'a:b.md' });
    expect(h.writes).toEqual([{ path: 'a b 1.md', content: preview?.newContent }]);
    expect(h.content.get('a b.md')).toBe('unrelated');
    expect(h.vault.read).not.toHaveBeenCalled();
  });

  it('uses Folder Notes aliases only for edits, never as a write destination', async () => {
    const h = vaultHarness({ 'Projects/Projects.md': 'folder note' });
    h.folders.set('Projects', new TFolder({ path: 'Projects' }));
    const write = { path: 'Projects.md', content: 'exact new note', createDirs: false };
    const edit = { path: 'Projects.md', edits: [{ oldText: 'folder note', newText: 'edited folder note' }] };
    const writePreview = await prepareWriteEditPreview(h.app as never, call('write', write));
    const editPreview = await prepareWriteEditPreview(h.app as never, call('edit', edit));
    expect(writePreview).toMatchObject({ path: 'Projects.md', oldContent: '', isNewFile: true });
    expect(editPreview).toMatchObject({ path: 'Projects/Projects.md', oldContent: 'folder note', newContent: 'edited folder note' });
    await h.operations.editFile(edit);
    await h.operations.writeFile(write);
    expect(h.writes).toEqual([
      { path: editPreview?.path, content: editPreview?.newContent },
      { path: writePreview?.path, content: writePreview?.newContent },
    ]);
  });

  it.each(['append', 'edit', 'multi_edit'] as const)('serializes a concurrent %s behind an adapter append across instances sharing an adapter', async secondMode => {
    const h = vaultHarness({}, { [hiddenPath]: 'seed' });
    const entered = deferred(), release = deferred();
    const persist = h.adapter.write.getMockImplementation()!;
    h.adapter.write.mockImplementationOnce(async (path, value) => { entered.resolve(); await release.promise; await persist(path, value); });
    const first = h.operations.writeFile({ path: hiddenPath, content: 'A', ifExists: 'append', createDirs: false });
    await entered.promise;
    const secondInstance = new FileOperations({ vault: { ...h.vault } } as never, ['/']);
    const edit = { path: hiddenPath, edits: [{ oldText: 'A', newText: 'B' }] };
    const second = secondMode === 'append'
      ? secondInstance.writeFile({ path: hiddenPath, content: 'B', ifExists: 'append', createDirs: false })
      : secondMode === 'edit' ? secondInstance.editFile(edit) : secondInstance.multiEditFiles({ files: [edit] });
    // Give a broken read-before-write implementation time to read stale bytes.
    await new Promise<void>(done => setImmediate(done));
    const readsWhileBlocked = h.adapter.read.mock.calls.length;
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(readsWhileBlocked).toBe(1);
    expect(h.adapterContent.get(hiddenPath)).toBe(secondMode === 'append' ? 'seedAB' : 'seedB');
    if (secondMode === 'multi_edit') expect(results[1]).toMatchObject({ success: true, appliedFiles: 1 });
    expect(h.writes).toHaveLength(2);
  });

  it('releases the mutation queue after a rejected preparation', async () => {
    const h = vaultHarness({}, { [hiddenPath]: 'seed' });
    const failed = h.operations.editFile({ path: hiddenPath, edits: [{ oldText: 'missing', newText: 'bad' }] });
    const following = h.operations.writeFile({ path: hiddenPath, content: 'A', ifExists: 'append', createDirs: false });
    await expect(failed).rejects.toThrow('Edit produced no changes');
    await following;
    expect(h.adapterContent.get(hiddenPath)).toBe('seedA');
  });

  it.each(['strict mismatch', 'invalid entry'] as const)('rejects the entire batch preview and execution after one %s', async failure => {
    const h = vaultHarness({ 'A.md': 'A', 'B.md': 'B' });
    const params = { files: [
      { path: 'A.md', edits: [{ oldText: 'A', newText: 'changed A' }] },
      { path: 'B.md', edits: failure === 'invalid entry' ? [] : [{ oldText: 'missing', newText: 'changed B' }] },
    ] };
    const previews = await prepareWriteEditPreviews(h.app as never, call('multi_edit', params));
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({ oldContent: 'A', newContent: 'A', appliedCount: 0, status: 'unavailable', notice: 'Not applied because another file failed preflight.' });
    expect(previews.every(preview => preview.newContent === preview.oldContent && preview.appliedCount === 0)).toBe(true);
    expect(previews.every(preview => preview.diff.stats.additions === 0 && preview.diff.stats.deletions === 0)).toBe(true);
    expect(await h.operations.multiEditFiles(params)).toMatchObject({ success: false, appliedFiles: 0, preflightFailed: true });
    expect(h.writes).toEqual([]);
  });

  it('rejects duplicate resolved Folder Notes targets before a batch can partially commit', async () => {
    const h = vaultHarness({ 'Projects/Projects.md': 'before' });
    h.folders.set('Projects', new TFolder({ path: 'Projects' }));
    const params = { files: ['Projects.md', 'Projects/Projects.md'].map(path => ({ path, edits: [{ oldText: 'before', newText: 'after' }] })) };
    const previews = await prepareWriteEditPreviews(h.app as never, call('multi_edit', params));
    expect(previews.every(preview => preview.status === 'unavailable')).toBe(true);
    expect(await h.operations.multiEditFiles(params)).toMatchObject({ success: false, appliedFiles: 0, preflightFailed: true });
    expect(h.writes).toEqual([]);
  });

  it.each(['write', 'edit', 'multi_edit'] as const)('admits Bases YAML before showing or executing %s changes', async mode => {
    const path = 'Views/Projects.base';
    const h = vaultHarness({ [path]: 'views: []' });
    const invalid = 'views: [unterminated';
    const edit = { path, edits: [{ oldText: 'views: []', newText: invalid }] };
    const params = mode === 'write' ? { path, content: invalid } : mode === 'edit' ? edit : { files: [edit] };
    const previews = await prepareWriteEditPreviews(h.app as never, call(mode, params));
    expect(previews[0]).toMatchObject({ status: 'unavailable', oldContent: 'views: []', newContent: 'views: []', notice: expect.stringContaining('Invalid Obsidian Bases YAML') });
    if (mode === 'write') await expect(h.operations.writeFile({ path, content: invalid })).rejects.toMatchObject({ code: 'BASE_YAML_INVALID' });
    else if (mode === 'edit') await expect(h.operations.editFile(edit)).rejects.toMatchObject({ code: 'BASE_YAML_INVALID' });
    else expect(await h.operations.multiEditFiles({ files: [edit] })).toMatchObject({ preflightFailed: true, appliedFiles: 0 });
    expect(h.writes).toEqual([]);
  });

  it.each(['write', 'edit', 'multi_edit'] as const)('rejects Studio-owned identity changes in both %s preview and execution', async mode => {
    const path = 'SystemSculpt/Studio/Agent canvas.systemsculpt';
    const original = serializeStudioProject(createEmptyStudioProject({ name: 'Agent canvas',
      policyPath: `${path}-assets/policy/grants.json`, minPluginVersion: '6.0.2', maxRuns: 100, maxArtifactsMb: 1024 }));
    const id = JSON.parse(original).id as string;
    const modified = original.replace(id, `${id}-changed`);
    const h = vaultHarness({ [path]: original });
    const edit = { path, edits: [{ oldText: id, newText: `${id}-changed` }] };
    const params = mode === 'write' ? { path, content: modified } : mode === 'edit' ? edit : { files: [edit] };
    const previews = await prepareWriteEditPreviews(h.app as never, call(mode, params));
    expect(previews[0]).toMatchObject({ status: 'unavailable', oldContent: original, newContent: original, notice: expect.stringContaining('The project identity is Studio-owned') });
    if (mode === 'write') await expect(h.operations.writeFile({ path, content: modified })).rejects.toThrow('The project identity is Studio-owned');
    else if (mode === 'edit') await expect(h.operations.editFile(edit)).rejects.toThrow('The project identity is Studio-owned');
    else expect(await h.operations.multiEditFiles({ files: [edit] })).toMatchObject({ preflightFailed: true, appliedFiles: 0 });
    expect(h.writes).toEqual([]);
  });

  it.each(['write', 'edit', 'multi_edit'] as const)('rejects malformed Studio envelopes before previewing or executing %s', async mode => {
    const path = 'SystemSculpt/Studio/Agent canvas.systemsculpt';
    const original = serializeStudioProject(createEmptyStudioProject({ name: 'Agent canvas',
      policyPath: `${path}-assets/policy/grants.json`, minPluginVersion: '6.0.2', maxRuns: 100, maxArtifactsMb: 1024 }));
    const modified = original.replace('"canvas":', '"invalidCanvas":');
    const h = vaultHarness({ [path]: original });
    const edit = { path, edits: [{ oldText: '"canvas":', newText: '"invalidCanvas":' }] };
    const params = mode === 'write' ? { path, content: modified } : mode === 'edit' ? edit : { files: [edit] };
    const previews = await prepareWriteEditPreviews(h.app as never, call(mode, params));
    expect(previews[0]).toMatchObject({ status: 'unavailable', oldContent: original, newContent: original,
      notice: expect.stringContaining('Studio project edit rejected before write') });
    if (mode === 'write') await expect(h.operations.writeFile({ path, content: modified })).rejects.toThrow('Studio project edit rejected before write');
    else if (mode === 'edit') await expect(h.operations.editFile(edit)).rejects.toThrow('Studio project edit rejected before write');
    else expect(await h.operations.multiEditFiles({ files: [edit] })).toMatchObject({ preflightFailed: true, appliedFiles: 0 });
    expect(h.writes).toEqual([]);
  });

  it.each([
    { path: 'Project.systemsculpt', existing: true, content: '{', error: 'Studio project edit rejected before write' },
    { path: 'Project.systemsculpt', existing: false, content: '{}', error: 'Create this project in Studio once' },
    { path: 'Project.systemsculpt', existing: true, content: '{}', ifExists: 'append' as const, error: 'cannot be appended to' },
    { path: '.systemsculpt/studio/state.json', existing: false, content: '{}', error: 'private project files' },
    { path: 'Project.systemsculpt.identity.json', existing: false, content: '{}', error: 'private project files' },
  ])('rejects impossible Studio write previews for $path ($error)', async ({ path, existing, content, ifExists, error }) => {
    const h = vaultHarness(existing ? { [path]: '{}' } : {});
    const params = { path, content, ifExists };
    const preview = await prepareWriteEditPreview(h.app as never, call('write', params));
    expect(preview).toMatchObject({ status: 'unavailable', notice: expect.stringContaining(error) });
    expect(preview?.newContent).toBe(preview?.oldContent);
    expect(preview?.isNewFile).not.toBe(true);
    await expect(h.operations.writeFile(params)).rejects.toThrow(error);
    expect(h.writes).toEqual([]);
  });
});
