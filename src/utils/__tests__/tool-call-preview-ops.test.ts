/**
 * @jest-environment jsdom
 */

import type { ToolCall } from '../../types/toolCalls';
import { prepareOperationsPreview, renderOperationsInlinePreview } from '../toolCallPreview';

const createTC = (id: string, name: string, args: any = {}): ToolCall => ({
  id,
  messageId: 'm',
  request: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  state: 'pending',
  timestamp: Date.now(),
} as any);

describe('Operations preview (grouping + dedup)', () => {
  test('prepareOperationsPreview de-duplicates create_folders paths', () => {
    const tc = createTC('1', 'create_folders', { paths: ['A', 'B', 'A', 'B', 'C'] });
    const preview = prepareOperationsPreview(tc);
    expect(preview?.type).toBe('create_folders');
    expect(preview && 'items' in preview ? preview.items.length : 0).toBe(3);
    const names = (preview as any).items.map((x: any) => x.path).sort();
    expect(names).toEqual(['A', 'B', 'C']);
  });

  test('renderOperationsInlinePreview groups create_folders into one line with comma separation', async () => {
    const host = document.createElement('div');
    const tc = createTC('2', 'create_folders', { paths: ['projects/personal', 'business', 'notes/knowledge'] });
    await renderOperationsInlinePreview(host, tc);
    const li = host.querySelector<HTMLLIElement>('.systemsculpt-inline-ops li');
    expect(li).toBeTruthy();
    // Expect label
    expect(li!.textContent?.startsWith('Create folders:')).toBe(true);
    const codes = Array.from(li!.querySelectorAll('code'));
    expect(codes.map(c => c.textContent)).toEqual(['projects/personal', 'business', 'notes/knowledge']);
    expect(codes.every(c => !c.hasAttribute('title'))).toBe(true);
    // Expect comma separators as text nodes between codes
    const text = li!.textContent || '';
    expect(text).toContain('Create folders: projects/personal, business, notes/knowledge');
  });

  test('renderOperationsInlinePreview distinguishes same-name folders without tooltips', async () => {
    const host = document.createElement('div');
    const tc = createTC('same-name-folders', 'create_folders', {
      paths: ['projects/personal', 'archive/personal'],
    });

    await renderOperationsInlinePreview(host, tc);

    const codes = Array.from(host.querySelectorAll<HTMLElement>('.systemsculpt-inline-ops code'));
    expect(codes.map(c => c.textContent)).toEqual(['projects/personal', 'archive/personal']);
    expect(codes.every(c => !c.hasAttribute('title'))).toBe(true);
  });

  test('renderOperationsInlinePreview groups trash into one line', async () => {
    const host = document.createElement('div');
    const tc = createTC('3', 'trash', { paths: ['a.md', 'b.md', 'a.md'] });
    await renderOperationsInlinePreview(host, tc);
    const li = host.querySelector<HTMLLIElement>('.systemsculpt-inline-ops li');
    expect(li).toBeTruthy();
    const text = li!.textContent || '';
    expect(text).toBe('Trash: a.md, b.md');
  });

  test('renderOperationsInlinePreview groups move pairs into one line with arrow and FULL paths', async () => {
    const host = document.createElement('div');
    const tc = createTC('4', 'move', { items: [
      { source: 'docs/old/a.md', destination: 'docs/new/a.md' },
      { source: 'notes/x.txt', destination: 'archive/x.txt' },
    ]});
    await renderOperationsInlinePreview(host, tc);
    const li = host.querySelector<HTMLLIElement>('.systemsculpt-inline-ops li');
    expect(li).toBeTruthy();
    const text = li!.textContent || '';
    expect(text).toBe('Move: docs/old/a.md → docs/new/a.md, notes/x.txt → archive/x.txt');
    const codes = Array.from(li!.querySelectorAll('code'));
    expect(codes.every(c => !c.hasAttribute('title'))).toBe(true);
  });

  test('renders every preview node in the host document for Obsidian popouts', async () => {
    const popoutDocument = document.implementation.createHTMLDocument('Obsidian popout');
    const host = popoutDocument.createElement('div');
    const tc = createTC('5', 'trash', { paths: ['a.md', 'b.md'] });

    await renderOperationsInlinePreview(host, tc);

    const preview = host.querySelector('.systemsculpt-inline-ops');
    expect(preview?.ownerDocument).toBe(popoutDocument);
    expect(Array.from(preview?.childNodes ?? []).every((node) => node.ownerDocument === popoutDocument)).toBe(true);
    expect(Array.from(host.querySelectorAll('*')).every((node) => node.ownerDocument === popoutDocument)).toBe(true);
  });
});
