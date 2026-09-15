import type { StudioJsonValue } from "./types";
import { isRecord } from "./utils";

export type StudioCollectionResource = { title: string; url: string | null; role: string };
export type StudioCollectionComment = { id: string; body: string; author: string; updatedAt: string; url: string | null };
export type StudioCollectionItem = { id: string; title: string; subtitle: string; url: string | null; parent: string; closed: boolean; group: string; resources?: StudioCollectionResource[]; updatedAt?: string; observedAt?: string; description?: string; comments?: StudioCollectionComment[]; moreComments?: boolean; detailsTruncated?: boolean };
export type StudioCollection = { total: number; open: number; observedAt: string; groups: { name: string; total: number; items: StudioCollectionItem[] }[] };
const MAX_ITEMS = 5000;
const MAX_GROUPS = 100;

/** Read own JSON fields only; paths never evaluate code or traverse prototypes. */
export function readCollectionField(value: unknown, path: string): unknown {
  let result = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (!isRecord(result) || ['__proto__', 'constructor', 'prototype'].includes(part) || !Object.prototype.hasOwnProperty.call(result, part)) return undefined;
    result = result[part];
  }
  return result;
}
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 2000) : ''; }
export function collectionLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function readStudioCollection(data: unknown, config: Record<string, StudioJsonValue>, options?: { groupBy?: string; showClosed?: boolean; query?: string }): StudioCollection {
  const records = readCollectionField(data, String(config.itemsPath || 'items'));
  if (!Array.isArray(records)) throw new Error('Collection data must contain an array at the configured items path.');
  if (records.length > MAX_ITEMS) throw new Error(`Collections support at most ${MAX_ITEMS} items. Narrow this view at its source.`);
  const groupBy = options?.groupBy || String(config.groupBy || 'status');
  const closedValues = new Set(String(config.closedValues || 'completed,canceled,duplicate').split(',').map(v => v.trim()));
  const groups = new Map<string, { name: string; total: number; items: StudioCollectionItem[] }>();
  const order = isRecord(config.columnOrder) ? config.columnOrder[groupBy] : undefined;
  if (Array.isArray(order)) {
    if (order.length > MAX_GROUPS) throw new Error('Collection column limit exceeded.');
    for (const value of order) if (typeof value === 'string') groups.set(value, { name: value, total: 0, items: [] });
  }
  const ids = new Set<string>();
  let open = 0;
  const query = options?.query?.trim().toLocaleLowerCase() || '';
  for (const record of records) {
    if (!isRecord(record)) throw new Error('Each collection item must be an object.');
    const id = text(readCollectionField(record, String(config.idField || 'id')));
    if (!id || ids.has(id)) throw new Error('Collection items need unique, non-empty IDs.');
    ids.add(id);
    const closed = closedValues.has(text(readCollectionField(record, String(config.closedField || 'state.type')))) || Boolean(record.archivedAt);
    if (!closed) open++;
    const item: StudioCollectionItem = {
      id, title: text(readCollectionField(record, String(config.titleField || 'title'))),
      subtitle: text(readCollectionField(record, String(config.subtitleField || 'identifier'))),
      url: collectionLink(readCollectionField(record, String(config.urlField || 'url'))),
      parent: text(readCollectionField(record, String(config.parentField || 'parent.identifier'))),
      closed, group: text(readCollectionField(record, groupBy)) || 'Unassigned',
    };
    const resources = readCollectionField(record, String(config.resourcesField || 'resources'));
    if (typeof record.updatedAt === 'string') item.updatedAt = text(record.updatedAt);
    if (typeof record.observedAt === 'string') item.observedAt = text(record.observedAt);
    const description = readCollectionField(record, String(config.descriptionField || 'description'));
    if (typeof description === 'string') {
      item.description = description.slice(0, 20000);
      item.detailsTruncated = description.length > 20000 || record.descriptionTruncated === true || record.detailsTruncated === true;
    }
    const comments = readCollectionField(record, String(config.commentsField || 'comments'));
    if (Array.isArray(comments)) {
      item.comments = comments.slice(0, 10).filter(isRecord).map(comment => ({
        id: text(comment.id), body: typeof comment.body === 'string' ? comment.body.slice(0, 4000) : '',
        author: text(isRecord(comment.author) ? comment.author.name : comment.author),
        updatedAt: text(comment.updatedAt), url: collectionLink(comment.url),
      }));
      item.moreComments = record.moreComments === true || comments.length > 10;
      item.detailsTruncated ||= comments.some(c => isRecord(c) && typeof c.body === 'string' && c.body.length > 4000) || record.commentsTruncated === true;
    }
    if (Array.isArray(resources)) {
      if (resources.length > 1000) throw new Error('An item exceeds 1,000 linked resources. Narrow this view at its source.');
      item.resources = resources.filter(isRecord).map(resource => ({
        title: text(resource.title), url: collectionLink(resource.url), role: text(resource.role).replace(/_/g, ' '),
      }));
    }
    let group = groups.get(item.group);
    if (!group) {
      if (groups.size >= MAX_GROUPS) throw new Error('Collection column limit exceeded. Choose a field with fewer values.');
      group = { name: item.group, total: 0, items: [] }; groups.set(item.group, group);
    }
    group.total++;
    if (!(options?.showClosed ?? config.showClosed !== false) && closed) continue;
    if (query && !`${item.title} ${item.subtitle} ${item.parent} ${item.description || ''} ${(item.resources || []).map(resource => `${resource.title} ${resource.role}`).join(' ')}`.toLocaleLowerCase().includes(query)) continue;
    group.items.push(item);
  }
  return { total: records.length, open, observedAt: text(readCollectionField(data, 'observedAt')), groups: [...groups.values()] };
}
