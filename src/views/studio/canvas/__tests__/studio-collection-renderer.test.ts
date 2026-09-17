/** @jest-environment jsdom */
import { renderStudioCollection } from "../StudioCollectionRenderer";
import type { StudioNodeInstance } from "../../../../studio/types";

function fixture(): StudioNodeInstance {
  return { id: 'board', kind: 'studio.collection', title: 'Board', version: '1', position: { x: 0, y: 0 }, config: {
    value: { observedAt: '2026-09-07T01:00:00Z', items: Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: `Task ${i}`, status: 'Todo', owner: 'Michael', url: 'https://example.com/task' })) },
    groupFields: { Status: 'status', Owner: 'owner' }, groupBy: 'status',
  } };
}
describe('Studio collection board', () => {
  it('lazily expands linked resources with bounded pages and safe links', () => {
    const node = fixture();
    node.config.value = { items: [{ id: 'one', title: 'Ticket', status: 'Todo', resources: Array.from({ length: 12 }, (_, i) => ({ title: `PR ${i}`, role: 'implementation', url: i === 0 ? 'javascript:alert(1)' : `https://github.com/a/b/pull/${i}` })) }] };
    const root = document.createElement('div'); renderStudioCollection(root, { node, outputs: {}, onChange: jest.fn() });
    expect(root.querySelectorAll('details a')).toHaveLength(0);
    const details = root.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'));
    expect(details.querySelectorAll('li')).toHaveLength(10); expect(details.querySelectorAll('a')).toHaveLength(9);
    details.querySelector('button')!.click(); expect(details.querySelectorAll('li')).toHaveLength(12);
    expect(root.innerHTML).not.toContain('javascript:');
  });
  it('bounds initial cards, exposes more, searches, and preserves grouping as presentation configuration', () => {
    const root = document.createElement('div'), node = fixture(), onChange = jest.fn();
    renderStudioCollection(root, { node, outputs: {}, onChange });
    expect(root.querySelectorAll('[data-collection-id]')).toHaveLength(25);
    expect(root.querySelector('[data-collection-id="0"]')?.textContent).toBe('Task 0');
    (root.querySelector('button') as HTMLButtonElement).click();
    expect(root.querySelectorAll('[data-collection-id]')).toHaveLength(30);
    const search = root.querySelector('input[type=search]') as HTMLInputElement;
    search.value = 'Task 29'; search.dispatchEvent(new Event('input'));
    expect(root.querySelectorAll('[data-collection-id]')).toHaveLength(1);
    const group = root.querySelector('select')!; group.value = 'owner'; group.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-collection-group]')?.getAttribute('data-collection-group')).toBe('Michael');
    expect(onChange).toHaveBeenCalledWith('groupBy', 'owner');
    expect(root.querySelector('a')?.getAttribute('rel')).toContain('noopener');
  });
  it('shows a newer synchronized config instead of an obsolete run output', () => {
    const root = document.createElement('div');
    renderStudioCollection(root, { node: fixture(), outputs: { json: { observedAt: '2026-09-06T00:00:00Z', items: [] } }, onChange: jest.fn() });
    expect(root.querySelectorAll('[data-collection-id]')).toHaveLength(25);
  });
});

describe('live source collection updates', () => {
  afterEach(() => jest.useRealTimers());
  it('preserves the query, expanded details and scroll across source updates within one project', () => {
    const node = fixture();
    node.config.value = { items: [{ id: 'one', title: 'Ticket', status: 'Todo', description: '<script>unsafe()</script>', comments: [{ body: 'Current evidence', author: 'Owner' }] }] };
    const root = document.createElement('div');
    const teardown = renderStudioCollection(root, { node, outputs: {}, scope: 'live-preservation', onChange: jest.fn() });
    const search = root.querySelector('input[type=search]') as HTMLInputElement;
    search.value = 'Ticket'; search.dispatchEvent(new Event('input'));
    const details = root.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'));
    (root.querySelector('.ss-studio-collection-columns') as HTMLElement).scrollLeft = 70;
    teardown(); root.replaceChildren();
    const next = renderStudioCollection(root, { node, outputs: {}, scope: 'live-preservation', onChange: jest.fn() });
    expect((root.querySelector('input[type=search]') as HTMLInputElement).value).toBe('Ticket');
    expect(root.querySelector('details')!.open).toBe(true);
    expect(root.textContent).toContain('Current evidence');
    expect(root.querySelector('script')).toBeNull();
    expect((root.querySelector('.ss-studio-collection-columns') as HTMLElement).scrollLeft).toBe(70);
    next(); root.replaceChildren();
    const other = renderStudioCollection(root, { node, outputs: {}, scope: 'different-project', onChange: jest.fn() });
    expect((root.querySelector('input[type=search]') as HTMLInputElement).value).toBe(''); other();
  });
  it('ages a disconnected source without rerendering and disposes its timer', () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    const node = fixture();
    node.config.value = { items: [{ id: 'one', title: 'Retained row' }], source: { schema: 'studio.source.v1', mode: 'automatic', observedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), maxAgeSeconds: 30 } };
    const root = document.createElement('div');
    const cleanup = renderStudioCollection(root, { node, outputs: {}, onChange: jest.fn() });
    expect(root.querySelector('[data-source-status]')?.getAttribute('data-source-status')).toBe('current');
    jest.advanceTimersByTime(60000);
    expect(root.querySelector('[data-source-status]')?.getAttribute('data-source-status')).toBe('stale');
    expect(root.textContent).toContain('Retained row');
    cleanup(); expect(jest.getTimerCount()).toBe(0);
  });
});
