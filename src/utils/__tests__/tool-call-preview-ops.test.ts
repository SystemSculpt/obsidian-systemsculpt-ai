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
    const tc = createTC('1', 'mcp-filesystem_create_folders', { paths: ['A', 'B', 'A', 'B', 'C'] });
    const preview = prepareOperationsPreview(tc);
    expect(preview?.type).toBe('create_folders');
    expect(preview && 'items' in preview ? preview.items.length : 0).toBe(3);
    const names = (preview as any).items.map((x: any) => x.path).sort();
    expect(names).toEqual(['A', 'B', 'C']);
  });

  test('renderOperationsInlinePreview groups create_folders into one line with comma separation', async () => {
    const host = document.createElement('div');
    const tc = createTC('2', 'mcp-filesystem_create_folders', { paths: ['projects/personal', 'business', 'notes/knowledge'] });
    await renderOperationsInlinePreview(host, tc);
    const li = host.querySelector<HTMLLIElement>('.systemsculpt-inline-ops li');
    expect(li).toBeTruthy();
    // Expect label
    expect(li!.textContent?.startsWith('Create folders:')).toBe(true);
    const codes = Array.from(li!.querySelectorAll('code')).map(c => ({ txt: c.textContent, title: c.getAttribute('title') }));
    expect(codes.map(c => c.txt)).toEqual(['personal', 'business', 'knowledge']);
    expect(codes.map(c => c.title)).toEqual(['projects/personal', 'business', 'notes/knowledge']);
    // Expect comma separators as text nodes between codes
    const text = li!.textContent || '';
    expect(text).toContain('Create folders: personal, business, knowledge');
  });

  test('renderOperationsInlinePreview groups trash into one line', async () => {
    const host = document.createElement('div');
    const tc = createTC('3', 'mcp-filesystem_trash', { paths: ['a.md', 'b.md', 'a.md'] });
    await renderOperationsInlinePreview(host, tc);
    const li = host.querySelector<HTMLLIElement>('.systemsculpt-inline-ops li');
    expect(li).toBeTruthy();
    const text = li!.textContent || '';
    expect(text).toBe('Trash: a.md, b.md');
  });

  test('renderOperationsInlinePreview groups move pairs into one line with arrow and FULL paths', async () => {
    const host = document.createElement('div');
    const tc = createTC('4', 'mcp-filesystem_move', { items: [
      { source: 'docs/old/a.md', destination: 'docs/new/a.md' },
      { source: 'notes/x.txt', destination: 'archive/x.txt' },
    ]});
    await renderOperationsInlinePreview(host, tc);
    const li = host.querySelector<HTMLLIElement>('.systemsculpt-inline-ops li');
    expect(li).toBeTruthy();
    const text = li!.textContent || '';
    expect(text).toBe('Move: docs/old/a.md → docs/new/a.md, notes/x.txt → archive/x.txt');
    const codes = Array.from(li!.querySelectorAll('code'));
    // titles mirror full paths in order: src1, dst1, src2, dst2
    expect(codes.map(c => c.getAttribute('title'))).toEqual([
      'docs/old/a.md', 'docs/new/a.md', 'notes/x.txt', 'archive/x.txt'
    ]);
  });
});
