import { resolveStudioEntry } from '../StudioEntry';
import { writeStudioDocumentAtomically } from '../document/StudioDocumentAtomicWrite';

jest.mock('../../platform/hostCapabilities', () => ({ hasHostCapability: () => false }));

function fixture() {
  const graph = JSON.stringify({ schema: 'studio.project.v2', id: 'same-project', canvas: { nodes: [] } });
  const entry = JSON.stringify({ schema: 'studio.entry.v1', id: 'same-project', projection: 'Benchmarks.studio/views/graph.systemsculpt' });
  const files = new Map([['Benchmarks.systemsculpt', entry], ['Benchmarks.studio/views/graph.systemsculpt', graph]]);
  const adapter = { read: jest.fn(async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; }),
    process: jest.fn(async (path: string, change: (raw: string) => string) => { files.set(path, change(files.get(path)!)); }),
  };
  return { graph, entry, files, adapter };
}
describe('directory Studio entries', () => {
  it('opens the same project and atomically saves its linked canvas while keeping the small entry', async () => {
    const f = fixture();
    expect(await resolveStudioEntry(f.adapter, 'Benchmarks.systemsculpt')).toEqual({ path: 'Benchmarks.studio/views/graph.systemsculpt', raw: f.graph, entryRaw: f.entry });
    const entry = await resolveStudioEntry(f.adapter, 'Benchmarks.systemsculpt');
    const changed = f.graph.replace('"nodes":[]', '"nodes":[{"id":"new"}]');
    expect(await writeStudioDocumentAtomically(f.adapter as any, entry.path, entry.raw, changed)).toBe(true);
    expect(f.files.get('Benchmarks.systemsculpt')).toBe(f.entry);
    expect((await resolveStudioEntry(f.adapter, 'Benchmarks.systemsculpt')).raw).toBe(changed);
    expect(await writeStudioDocumentAtomically(f.adapter as any, entry.path, f.graph, '{}')).toBe(false);
    expect(f.files.get('Benchmarks.studio/views/graph.systemsculpt')).toBe(changed);
  });
  it('rejects traversal and mismatched identities without replacing either file', async () => {
    const f = fixture();
    f.files.set('Benchmarks.systemsculpt', JSON.stringify({ schema: 'studio.entry.v1', id: 'same-project', projection: '../Other.systemsculpt' }));
    await expect(resolveStudioEntry(f.adapter, 'Benchmarks.systemsculpt')).rejects.toThrow('adjacent');
    f.files.set('Benchmarks.systemsculpt', f.entry.replace('same-project','different'));
    await expect(resolveStudioEntry(f.adapter, 'Benchmarks.systemsculpt')).rejects.toThrow('identities');
    expect(f.files.get('Benchmarks.studio/views/graph.systemsculpt')).toBe(f.graph);
  });
  it('keeps legacy single-file content byte-for-byte', async () => {
    const f = fixture(); f.files.set('Legacy.systemsculpt', f.graph);
    expect(await resolveStudioEntry(f.adapter, 'Legacy.systemsculpt')).toEqual({ path: 'Legacy.systemsculpt', raw: f.graph });
  });
});
