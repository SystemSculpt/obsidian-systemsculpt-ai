import {createStudioCollaboration, changeStudioCollaboration, mergeStudioCollaboration, studioCollaborationEntities, serializeStudioCollaboration, loadStudioCollaboration} from '../StudioCollaborativeDocument';
const initial = {project: {name: 'Canvas'}, 'node:a': {id: 'a', value: 'hello world', x: 0, y: 0}};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
describe('single-file collaborative state', () => {
  it('merges concurrent typing into one value and survives a reopen', async () => {
    const root = await createStudioCollaboration('p', initial);
    const a = copy(initial), b = copy(initial);
    a['node:a'].value = 'hello wonderful world'; b['node:a'].value = 'hello world!';
    const left = changeStudioCollaboration(root, initial, a), right = changeStudioCollaboration(root, initial, b);
    const merged = mergeStudioCollaboration(left, right);
    expect(studioCollaborationEntities(merged)['node:a'].value).toBe('hello wonderful world!');
    expect(studioCollaborationEntities(mergeStudioCollaboration(right, left))).toEqual(studioCollaborationEntities(merged));
    expect(studioCollaborationEntities(await loadStudioCollaboration(serializeStudioCollaboration(merged), 'p'))).toEqual(studioCollaborationEntities(merged));
  });
  it('merges twenty independent agents', async () => {
    const root = await createStudioCollaboration('p', initial);
    let merged = root;
    for (let i = 0; i < 20; i++) {
      const next = {...copy(initial), [`node:${i}`]: {id: String(i), value: `agent ${i}`}};
      merged = mergeStudioCollaboration(merged, changeStudioCollaboration(root, initial, next));
    }
    expect(Object.keys(studioCollaborationEntities(merged))).toHaveLength(22);
  });
  it('does not resurrect deletions but permits deliberate restoration', async () => {
    const root = await createStudioCollaboration('p', initial);
    const edited = copy(initial); edited['node:a'].x = 10;
    const deleted = changeStudioCollaboration(root, initial, {project: initial.project});
    const merged = mergeStudioCollaboration(deleted, changeStudioCollaboration(root, initial, edited));
    expect(studioCollaborationEntities(merged)['node:a']).toBeUndefined();
    expect(() => changeStudioCollaboration(merged, {project: initial.project}, initial)).toThrow(/explicit/);
    const restored = changeStudioCollaboration(merged, {project: initial.project}, initial, {restoreDeletedEntities: true});
    expect(studioCollaborationEntities(restored)['node:a']).toEqual(initial['node:a']);
  });
  it('merges disjoint geometry and membership edits', async () => {
    const before = {...copy(initial), 'group:g': {nodes: {a: true}}};
    const root = await createStudioCollaboration('p', before);
    const left = {...copy(before), 'group:g': {nodes: {a: true, b: true}}}; left['node:a'].x = 5;
    const right = {...copy(before), 'group:g': {nodes: {a: true, c: true}}}; right['node:a'].y = 7;
    const result = studioCollaborationEntities(mergeStudioCollaboration(changeStudioCollaboration(root, before, left), changeStudioCollaboration(root, before, right)));
    expect(result['node:a']).toMatchObject({x: 5, y: 7});
    expect(result['group:g'].nodes).toEqual({a: true, b: true, c: true});
  });
});
