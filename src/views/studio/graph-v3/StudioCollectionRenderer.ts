import { readStudioCollection, readCollectionField, collectionLink } from "../../../studio/StudioCollection";
import { describeCollectionAge, readStudioCollectionSource, selectStudioCollectionData } from '../../../studio/StudioCollectionSource';
import type { StudioJsonValue, StudioNodeInstance, StudioNodeOutputMap } from "../../../studio/types";
import { isRecord } from "../../../studio/utils";
import { createStudioAction } from "../StudioAction";

type ViewState = { query: string; expanded: Set<string>; pages: Map<string, number>; scrollLeft: number; columnScroll: Map<string, number> };
const states = new WeakMap<Document, Map<string, ViewState>>();
type Options = { node: StudioNodeInstance; outputs: StudioNodeOutputMap; scope?: string; onChange: (key: string, value: StudioJsonValue) => void };
export function renderStudioCollection(root: HTMLElement, { node, outputs, scope = '', onChange }: Options): () => void {
  const board = root.createDiv({ cls: 'ss-studio-collection' });
  const config = node.config;
  const data = selectStudioCollectionData(config, outputs);
  const managed = readCollectionField(data, 'source.schema') === 'studio.source.v1';
  let documentStates = scope ? states.get(root.ownerDocument) : undefined;
  if (!documentStates) { documentStates = new Map(); if (scope) states.set(root.ownerDocument, documentStates); }
  const stateKey = `${scope}:${node.id}`;
  const state: ViewState = documentStates.get(stateKey) || { query: '', expanded: new Set(), pages: new Map(), scrollLeft: 0, columnScroll: new Map() };
  documentStates.delete(stateKey); documentStates.set(stateKey, state);
  while (documentStates.size > 100) documentStates.delete(documentStates.keys().next().value);
  const controls = board.createDiv({ cls: 'ss-studio-collection-controls' });
  const group = controls.createEl('select', { attr: { 'aria-label': 'Group collection by', "data-testid": `studio.collection.group.${node.id}` } });
  const fields = isRecord(config.groupFields) ? config.groupFields : { Status: 'status' };
  for (const [label, field] of Object.entries(fields).slice(0, 30)) if (typeof field === 'string') group.createEl('option', { text: label, value: field });
  if (!Array.from(group.options).some(option => option.value === String(config.groupBy || 'status'))) group.createEl('option', { text: String(config.groupBy || 'status'), value: String(config.groupBy || 'status') });
  group.value = String(config.groupBy || 'status');
  const search = controls.createEl('input', { type: 'search', attr: { 'aria-label': 'Search collection', placeholder: 'Search items…', "data-testid": `studio.collection.search.${node.id}` } });
  search.type = 'search';
  search.value = state.query;
  const label = controls.createEl('label');
  const closed = label.createEl('input', { type: 'checkbox', attr: { "data-testid": `studio.collection.closed.${node.id}` } });
  closed.type = 'checkbox';
  closed.checked = config.showClosed !== false;
  label.appendText(' Show closed');
  const metadata = board.createDiv({ cls: 'ss-studio-collection-metadata' });
  const summary = metadata.createDiv({ cls: 'ss-studio-collection-summary', attr: { 'aria-live': 'polite' } });
  const sourceStatus = metadata.createDiv({ cls: 'ss-studio-collection-source', attr: { 'aria-live': 'polite', 'data-testid': `studio.collection.source.${node.id}` } });
  const sourceMessage = board.createDiv({ cls: 'ss-studio-collection-source-message' });
  const sourceUrl = collectionLink(readCollectionField(data, 'source.url'));
  if (sourceUrl) controls.createEl('a', { text: 'Open source', href: sourceUrl, attr: { target: '_blank', rel: 'noopener noreferrer' } });
  const columns = board.createDiv({ cls: 'ss-studio-collection-columns' });
  const rememberExpanded = (key: string, details: HTMLDetailsElement) => {
    details.open = state.expanded.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) state.expanded.add(key); else state.expanded.delete(key);
      while (state.expanded.size > 100) state.expanded.delete(state.expanded.values().next().value);
    });
  };
  function updateSourceStatus(): void {
    const source = readStudioCollectionSource(data, config);
    sourceStatus.hidden = !managed && !source.observedAt;
    sourceStatus.dataset.sourceStatus = source.status;
    const labels = { current: 'Current', stale: 'Stale', unavailable: 'Refresh unavailable', partial: 'Partial refresh', unknown: 'Freshness unknown', snapshot: 'Saved snapshot' };
    sourceStatus.setText(`${labels[source.status]}${source.observedAt ? ` · ${describeCollectionAge(source.observedAt)}` : ''}`);
    sourceStatus.title = `${source.label}${source.automatic ? ' · Automatic updates' : ''}\nObserved: ${source.observedAt || 'unknown'}\nChecked: ${source.checkedAt || 'unknown'}`;
    sourceMessage.setText(source.message);
    sourceMessage.hidden = !source.message;
  }
  function renderColumns(): void {
    columns.empty();
    try {
      const collection = readStudioCollection(data, config, { groupBy: group.value, showClosed: closed.checked, query: search.value });
      summary.setText(`${collection.open} open · ${collection.total} total`);
      const validGroups = new Set(collection.groups.map(column => column.name));
      for (const key of state.pages.keys()) if (!validGroups.has(key)) state.pages.delete(key);
      for (const key of state.columnScroll.keys()) if (!validGroups.has(key)) state.columnScroll.delete(key);
      for (const column of collection.groups) {
        const lane = columns.createDiv({ cls: 'ss-studio-collection-column', attr: { 'data-collection-group': column.name } });
        const heading = lane.createEl('h4');
        heading.createSpan({ text: column.name });
        heading.createSpan({ cls: 'ss-studio-collection-count', text: `${column.items.length}${column.items.length !== column.total ? ` / ${column.total}` : ''}` });
        const list = lane.createDiv({ cls: 'ss-studio-collection-cards' });
        let shown = 0;
        const showMore = (count = 25) => {
          const end = Math.min(shown + count, column.items.length);
          for (; shown < end; shown++) {
            const item = column.items[shown];
            const card = list.createEl('article', { cls: 'ss-studio-collection-card', attr: { 'data-collection-id': item.id } });
            if (item.url) card.createEl('a', { cls: item.subtitle ? 'ss-studio-collection-identifier' : 'ss-studio-collection-title', text: item.subtitle || item.title, href: item.url, attr: { target: '_blank', rel: 'noopener noreferrer', "data-testid": `studio.collection.item.${node.id}.${item.id}` } });
            else card.createEl('strong', { cls: item.subtitle ? 'ss-studio-collection-identifier' : 'ss-studio-collection-title', text: item.subtitle || item.title });
            if (item.subtitle && item.subtitle !== item.title) card.createEl('p', { cls: 'ss-studio-collection-title', text: item.title });
            if (item.parent) card.createEl('small', { text: `Parent: ${item.parent}` });
            if (item.observedAt) card.createEl('small', { text: `Evidence ${describeCollectionAge(item.observedAt)}`, attr: { title: item.observedAt } });
            if (item.description || item.comments?.length || item.moreComments) {
              const details = card.createEl('details', { cls: 'ss-studio-collection-context', attr: { 'data-testid': `studio.collection.details.${node.id}.${item.id}` } });
              details.createEl('summary', { text: `Details${item.comments?.length ? ` · ${item.comments.length} recent comment${item.comments.length === 1 ? '' : 's'}` : ''}` });
              let loaded = false;
              const expand = () => {
                if (!details.open || loaded) return;
                loaded = true;
                if (item.updatedAt) details.createEl('small', { text: `Updated ${item.updatedAt}` });
                if (item.description) details.createEl('p', { text: item.description });
                for (const comment of item.comments || []) {
                  const row = details.createEl('article');
                  row.createEl('strong', { text: comment.author || 'Comment' });
                  row.createEl('small', { text: comment.updatedAt });
                  row.createEl('p', { text: comment.body });
                  if (comment.url) row.createEl('a', { text: 'Open comment', href: comment.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
                }
                if ((item.moreComments || item.detailsTruncated) && item.url) details.createEl('a', { text: 'Read the full discussion in the source', href: item.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
              };
              rememberExpanded(`details:${item.id}`, details); details.addEventListener('toggle', expand); expand();
            }
            if (item.resources?.length) {
              const resources = item.resources;
              const details = card.createEl('details', { cls: 'ss-studio-collection-resources' });
              details.createEl('summary', { text: `${resources.length} linked resource${resources.length === 1 ? '' : 's'}` });
              let expanded = false;
              const expand = () => {
                if (!details.open || expanded) return;
                expanded = true;
                const links = details.createEl('ul');
                let linked = 0;
                const next = () => {
                  const end = Math.min(linked + 10, resources.length);
                  for (; linked < end; linked++) {
                    const resource = resources[linked];
                    const row = links.createEl('li');
                    if (resource.url) row.createEl('a', { text: resource.title || resource.url, href: resource.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
                    else row.createSpan({ text: resource.title || 'Open attachment in the source ticket' });
                    if (resource.role) row.createEl('small', { text: resource.role });
                  }
                };
                next();
                if (linked < resources.length) {
                  const more = createStudioAction(details, { label: 'More links', testId: `studio.collection.links.more.${node.id}.${item.id}`, onSelect: () => { next(); if (linked >= resources.length) more.remove(); } });
                }
              };
              rememberExpanded(`resources:${item.id}`, details); details.addEventListener('toggle', expand); expand();
            }
          }
        };
        showMore(state.pages.get(column.name) || 25);
        list.scrollTop = state.columnScroll.get(column.name) || 0;
        if (!column.items.length) list.createEl('p', { text: 'No matching items', cls: 'ss-studio-muted' });
        if (shown < column.items.length) {
          const more = createStudioAction(lane, { label: 'Show more', testId: `studio.collection.more.${node.id}.${column.name}`, onSelect: () => { showMore(); state.pages.set(column.name, shown); if (shown >= column.items.length) more.remove(); } });
        }
      }
    } catch (error) { summary.setText(error instanceof Error ? error.message : 'Collection data is invalid.'); }
  }
  group.addEventListener('change', () => { renderColumns(); onChange('groupBy', group.value); });
  closed.addEventListener('change', () => { renderColumns(); onChange('showClosed', closed.checked); });
  search.addEventListener('input', () => { state.query = search.value; renderColumns(); });
  renderColumns();
  columns.scrollLeft = state.scrollLeft;
  updateSourceStatus();
  const owner = root.ownerDocument.defaultView;
  const timer = managed ? owner?.setInterval(updateSourceStatus, 30000) : undefined;
  return () => {
    if (timer !== undefined) owner?.clearInterval(timer);
    state.query = search.value; state.scrollLeft = columns.scrollLeft;
    columns.querySelectorAll<HTMLElement>('[data-collection-group]').forEach(column => {
      state.columnScroll.set(column.dataset.collectionGroup || '', column.querySelector('.ss-studio-collection-cards')?.scrollTop || 0);
    });
  };
}
