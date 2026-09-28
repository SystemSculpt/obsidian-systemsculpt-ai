import { readStudioCollection, readCollectionField, collectionLink } from "../StudioCollection";
import { collectionNode } from "../nodes/collectionNode";

const config = { itemsPath: 'issues', groupBy: 'state.name', showClosed: false,
  columnOrder: { 'state.name': ['Todo', 'In Progress', 'Done'] } };
const item = (id: string, name = 'Todo', type = 'unstarted') => ({ id, title: `Ticket ${id}`, identifier: `ENG-${id}`, state: { name, type }, milestone: { name: 'Coverage' } });

describe('Studio collections', () => {
  it('recomputes category membership and counts from each complete snapshot', () => {
    const first = readStudioCollection({ issues: [item('1'), item('2')] }, config);
    expect(first.groups.find(g => g.name === 'Todo')?.items).toHaveLength(2);
    const next = readStudioCollection({ issues: [item('1', 'In Progress', 'started'), item('2', 'Done', 'completed'), item('3')] }, config);
    expect(next.total).toBe(3); expect(next.open).toBe(2);
    expect(next.groups.find(g => g.name === 'Todo')?.items.map(i => i.id)).toEqual(['3']);
    expect(next.groups.find(g => g.name === 'In Progress')?.items.map(i => i.id)).toEqual(['1']);
    expect(next.groups.find(g => g.name === 'Done')).toEqual({ name: 'Done', total: 1, items: [] });
    expect(readStudioCollection({ issues: [item('2', 'Done', 'completed')] }, config, { showClosed: true }).groups[2].items).toHaveLength(1);
  });
  it('groups by any configured field and searches without changing source records', () => {
    const data = { issues: [item('1'), item('2')] };
    const before = JSON.stringify(data);
    expect(readStudioCollection(data, config, { groupBy: 'milestone.name', query: 'ENG-2' }).groups[0].items.map(i => i.id)).toEqual(['2']);
    expect(JSON.stringify(data)).toBe(before);
  });
  it('rejects malformed collections, duplicates, unsafe paths, links, and excessive fanout', () => {
    expect(() => readStudioCollection({ issues: [item('1'), item('1')] }, config)).toThrow(/unique/);
    expect(() => readStudioCollection({ issues: {} }, config)).toThrow(/array/);
    expect(() => readStudioCollection({ issues: Array.from({ length: 5001 }, (_, i) => item(String(i))) }, config)).toThrow(/5000/);
    expect(readCollectionField({}, '__proto__.polluted')).toBeUndefined();
    expect(collectionLink('javascript:alert(1)')).toBeNull();
    expect(collectionLink('https://user:pass@example.com')).toBeNull();
    expect(collectionLink('https://linear.app/blaxel/issue/ENG-1')).toBe('https://linear.app/blaxel/issue/ENG-1');
  });
  it('passes the same validated JSON downstream and requests no host capabilities', async () => {
    const data = { issues: [item('1')] };
    const result = await collectionNode.execute({ inputs: { json: data }, node: { config } } as any);
    expect(result.outputs.json).toEqual(data);
    expect(collectionNode.requiredHostCapabilities).toEqual([]);
  });
});

it('passes the current source snapshot downstream even when its upstream run output is stale', async () => {
  const value = { items: [{ id: 'current', title: 'Latest' }], source: { schema: 'studio.source.v1' } };
  const result = await collectionNode.execute({ inputs: { json: { items: [] } }, node: { config: { value } } } as any);
  expect(result.outputs.json).toBe(value);
});
