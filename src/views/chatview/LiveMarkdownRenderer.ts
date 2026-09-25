import { Component } from "obsidian";
import {
  createSurfaceElement,
  getSurfaceOwnerWindow,
} from "../../core/ui/surface";

const DEFAULT_STREAM_RENDER_INTERVAL_MS = 48;
const TEXT_NODE_FILTER = 4;
const OPAQUE_MARKDOWN_SELECTOR = [
  ".callout",
  ".internal-embed",
  ".markdown-embed",
  "[class*=\"block-language-\"]",
  "audio",
  "canvas",
  "iframe",
  "video",
].join(",");
const LEASED_STREAM_MARKDOWN_SELECTOR = [
  OPAQUE_MARKDOWN_SELECTOR,
  "a",
  "button",
  "img",
  "input",
  "select",
  "textarea",
].join(",");
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM_LINE = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const PARTIAL_LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)]?)$/;

type SelectionPoint = Readonly<{
  node: Node;
  nodeOffset: number;
  textOffset: number;
}>;

type PreservedSelection = Readonly<{
  anchor: SelectionPoint;
  focus: SelectionPoint;
}>;

type PreservedFocus = Readonly<{
  element: HTMLElement;
  path: readonly number[];
  tagName: string;
  focusKey?: string;
  id?: string;
}>;

type PreservedCopyState = Readonly<{
  element: HTMLButtonElement;
  children: readonly Node[];
  copied: boolean;
  failed: boolean;
  ariaLabel: string | null;
  copyAttempt?: string;
}>;

type PreservedDomState = Readonly<{
  selection: PreservedSelection | null;
  focus: PreservedFocus | null;
  scroll: readonly Readonly<{
    element: HTMLElement;
    top: number;
    left: number;
  }>[];
  details: readonly Readonly<{
    element: HTMLDetailsElement;
    open: boolean;
  }>[];
  callouts: readonly Readonly<{
    element: HTMLElement;
    collapsed: boolean;
    expanded: string | null;
  }>[];
  copies: readonly PreservedCopyState[];
}>;

/**
 * The trailing run of a target's child nodes that one commit may replace.
 * Nodes up to and including `after` belong to settled Markdown blocks and are
 * never touched while the rest of the message streams.
 */
type DomRegion = Readonly<{
  root: HTMLElement;
  after: Node | null;
}>;

type RenderWaiter = Readonly<{
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

type RenderOutcome =
  | Readonly<{ status: "committed" }>
  | Readonly<{
      status: "failed";
      error: unknown;
      revision: number | null;
    }>
  | Readonly<{ status: "stale"; retry?: boolean }>;

type RenderedMarkdownBlock = Readonly<{
  signature: string;
  leased: boolean;
  nodeName: string;
  nodeType: number;
}>;

type PlainBlockRange = Readonly<{
  incomingEnd: number;
  previousEnd: number;
  start: number;
}>;

/**
 * Markdown blocks that can no longer change while the message streams. They
 * are parsed and mounted once; only the open tail after them is re-rendered.
 */
type SettledMarkdown = {
  markdown: string;
  anchor: Node | null;
  leases: Component[];
};

/*
 * `tailStart` is where the re-rendered open region begins. Zero renders the
 * whole message, which is the only shape a final render may take. Blocks in
 * [settleStart, tailStart) became complete since the last commit and are
 * parsed once on their own before joining the settled prefix.
 */
type RenderPlan = Readonly<{
  markdown: string;
  resetSettled: boolean;
  settleStart: number;
  tailStart: number;
}>;

type LiveMarkdownState = {
  target: HTMLElement;
  markdown: string;
  revision: number;
  committedRevision: number;
  committedMarkdown: string | null;
  committedFinal: boolean;
  /** Block signatures of the committed open region only. */
  committedBlocks: readonly RenderedMarkdownBlock[];
  committedTail: string | null;
  committedTailStart: number;
  /** Lease for the nodes of the committed open region. */
  lease: Component | null;
  settled: SettledMarkdown;
  failedRevision: number | null;
  lastFinishedAt: number;
  lastRenderDurationMs: number;
  timer: number | null;
  inFlight: Promise<RenderOutcome> | null;
  renderImmediatelyAfterFlight: boolean;
  finalRevision: number | null;
  fallbackVisible: boolean;
  disposed: boolean;
  waiters: RenderWaiter[];
};

export type LiveMarkdownRendererOptions = Readonly<{
  render: (
    markdown: string,
    staging: HTMLElement,
    component: Component,
  ) => Promise<void>;
  beginDomCommit?: (target: HTMLElement) => (() => void) | undefined;
  throttleMs?: number;
  now?: () => number;
}>;

type ElementConstructor<T extends Element> = Readonly<{
  prototype: T;
}>;

type DomRealmWindow = Window & Readonly<{
  CSS?: typeof CSS;
  Element: typeof Element;
  HTMLDetailsElement: typeof HTMLDetailsElement;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
}>;

function getDomRealm(node: Node): DomRealmWindow {
  return getSurfaceOwnerWindow(node) as DomRealmWindow;
}

function isDomInstance<T extends Element>(
  node: Node,
  constructor: ElementConstructor<T>,
): node is T {
  const obsidianNode = node as Node & {
    instanceOf?: (candidate: ElementConstructor<T>) => boolean;
  };
  return typeof obsidianNode.instanceOf === "function"
    ? obsidianNode.instanceOf(constructor)
    : Object.prototype.isPrototypeOf.call(constructor.prototype, node);
}

function countOccurrences(line: string, token: string): number {
  let count = 0;
  for (
    let index = line.indexOf(token);
    index !== -1;
    index = line.indexOf(token, index + token.length)
  ) count += 1;
  return count;
}

/**
 * Returns the offset where the last streamed Markdown block that may still
 * change begins, scanning from a previous boundary. Everything before it is a
 * run of complete top-level blocks: a blank line ends them, the next line
 * starts at column zero, and no fence, math block, comment, or loose list
 * spans the boundary. Unknown shapes keep more text in the open tail, which
 * costs time but never changes what is shown. The final render always parses
 * the whole message, so reference links and footnotes resolve on settlement.
 */
export function stableMarkdownBoundary(markdown: string, start = 0): number {
  let boundary = start;
  let fence: Readonly<{ char: string; length: number }> | null = null;
  let math = false;
  let obsidianComment = false;
  let htmlComment = false;
  let blockHasListItem = false;
  let blankAfterContent = false;
  let sawContent = false;
  let lineStart = start;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const complete = newline !== -1;
    const line = markdown.slice(lineStart, complete ? newline : markdown.length);
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (
        close
        && close[1][0] === fence.char
        && close[1].length >= fence.length
      ) fence = null;
    } else if (math) {
      if (countOccurrences(line, "$$") % 2 === 1) math = false;
    } else if (obsidianComment) {
      if (countOccurrences(line, "%%") % 2 === 1) obsidianComment = false;
    } else if (htmlComment) {
      if (line.includes("-->")) htmlComment = false;
    } else if (line.trim().length === 0) {
      blankAfterContent = sawContent;
    } else {
      const listItem = LIST_ITEM_LINE.test(line)
        || (!complete && PARTIAL_LIST_MARKER.test(line));
      if (
        blankAfterContent
        && !/^[ \t]/.test(line)
        && !(listItem && blockHasListItem)
      ) {
        boundary = lineStart;
        blockHasListItem = false;
      }
      blankAfterContent = false;
      sawContent = true;
      if (listItem) blockHasListItem = true;
      const open = FENCE_OPEN.exec(line);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { char: open[1][0], length: open[1].length };
      } else if (countOccurrences(line, "$$") % 2 === 1) {
        math = true;
      } else if (countOccurrences(line, "%%") % 2 === 1) {
        obsidianComment = true;
      } else if (
        line.lastIndexOf("<!--") > line.lastIndexOf("-->")
      ) {
        htmlComment = true;
      }
    }
    if (!complete) break;
    lineStart = newline + 1;
  }
  return boundary;
}

function regionStart(region: DomRegion): ChildNode | null {
  return region.after ? region.after.nextSibling : region.root.firstChild;
}

function regionNodes(region: DomRegion): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (let node = regionStart(region); node; node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}

function regionOffset(region: DomRegion): number {
  return region.after
    ? Array.prototype.indexOf.call(region.root.childNodes, region.after) + 1
    : 0;
}

function regionContains(region: DomRegion, node: Node): boolean {
  if (!region.after) return region.root.contains(node);
  let top: Node | null = node;
  while (top && top.parentNode !== region.root) top = top.parentNode;
  return Boolean(
    top
    && top !== region.after
    && region.after.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

function regionQueryAll<T extends Element>(
  region: DomRegion,
  selector: string,
): T[] {
  if (!region.after) {
    return Array.from(region.root.querySelectorAll<T>(selector));
  }
  const matches: T[] = [];
  for (const node of regionNodes(region)) {
    if (!isDomInstance(node, getDomRealm(node).Element)) continue;
    if (node.matches(selector)) matches.push(node as unknown as T);
    matches.push(...Array.from(node.querySelectorAll<T>(selector)));
  }
  return matches;
}

function regionQuery<T extends Element>(
  region: DomRegion,
  selector: string,
): T | null {
  if (!region.after) return region.root.querySelector<T>(selector);
  for (const node of regionNodes(region)) {
    if (!isDomInstance(node, getDomRealm(node).Element)) continue;
    if (node.matches(selector)) return node as unknown as T;
    const match = node.querySelector<T>(selector);
    if (match) return match;
  }
  return null;
}

function pointOffset(
  region: DomRegion,
  node: Node,
  offset: number,
): number | null {
  try {
    const range = region.root.ownerDocument.createRange();
    range.selectNodeContents(region.root);
    if (region.after) range.setStartAfter(region.after);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function captureSelection(region: DomRegion): PreservedSelection | null {
  const root = region.root;
  const selection = root.ownerDocument.getSelection();
  if (
    !selection?.anchorNode
    || !selection.focusNode
    || !root.contains(selection.anchorNode)
    || !root.contains(selection.focusNode)
  ) {
    return null;
  }
  const anchor = pointOffset(region, selection.anchorNode, selection.anchorOffset);
  const focus = pointOffset(region, selection.focusNode, selection.focusOffset);
  return anchor === null || focus === null
    ? null
    : {
        anchor: {
          node: selection.anchorNode,
          nodeOffset: selection.anchorOffset,
          textOffset: anchor,
        },
        focus: {
          node: selection.focusNode,
          nodeOffset: selection.focusOffset,
          textOffset: focus,
        },
      };
}

function textPoint(
  region: DomRegion,
  requestedOffset: number,
): Readonly<{ node: Node; offset: number }> {
  let remaining = Math.max(0, requestedOffset);
  let lastText: Text | null = null;
  for (const top of regionNodes(region)) {
    const walker = region.root.ownerDocument.createTreeWalker(top, TEXT_NODE_FILTER);
    for (
      let current: Node | null = top.nodeType === Node.TEXT_NODE ? top : walker.nextNode();
      current;
      current = walker.nextNode()
    ) {
      const text = current as Text;
      lastText = text;
      if (remaining <= text.data.length) {
        return { node: text, offset: remaining };
      }
      remaining -= text.data.length;
    }
  }
  if (lastText) return { node: lastText, offset: lastText.data.length };
  return { node: region.root, offset: regionOffset(region) };
}

function restoreSelection(
  region: DomRegion,
  preserved: PreservedSelection | null,
): void {
  if (!preserved) return;
  const root = region.root;
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const restorePoint = (
    point: SelectionPoint,
  ): Readonly<{ node: Node; offset: number }> => {
    if (point.node.isConnected && root.contains(point.node)) {
      const maximumOffset = point.node.nodeType === Node.TEXT_NODE
        ? point.node.nodeValue?.length ?? 0
        : point.node.childNodes.length;
      return {
        node: point.node,
        offset: Math.min(point.nodeOffset, maximumOffset),
      };
    }
    return textPoint(region, point.textOffset);
  };
  const anchor = restorePoint(preserved.anchor);
  const focus = restorePoint(preserved.focus);
  try {
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        focus.node,
        focus.offset,
      );
      return;
    }
    const range = root.ownerDocument.createRange();
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(focus.node, focus.offset);
    selection.addRange(range);
  } catch {
    selection.removeAllRanges();
  }
}

function childPath(region: DomRegion, target: HTMLElement): number[] {
  const path: number[] = [];
  let current: Node | null = target;
  while (current && current !== region.root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  if (current !== region.root || path.length === 0) return [];
  path[0] -= regionOffset(region);
  return path;
}

function nodeAtPath(region: DomRegion, path: readonly number[]): Node | null {
  let current: Node = region.root;
  for (const [depth, index] of path.entries()) {
    const next: Node | undefined = current.childNodes[
      depth === 0 ? index + regionOffset(region) : index
    ];
    if (!next) return null;
    current = next;
  }
  return current;
}

function captureFocus(region: DomRegion): PreservedFocus | null {
  const root = region.root;
  const active = root.ownerDocument.activeElement;
  if (
    !active
    || !isDomInstance(active, getDomRealm(root).HTMLElement)
    || !regionContains(region, active)
  ) {
    return null;
  }
  return {
    element: active,
    path: childPath(region, active),
    tagName: active.tagName,
    ...(active.dataset.focusKey ? { focusKey: active.dataset.focusKey } : {}),
    ...(active.id ? { id: active.id } : {}),
  };
}

function escapeAttribute(value: string, css: typeof CSS | undefined): string {
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function restoreFocus(region: DomRegion, preserved: PreservedFocus | null): void {
  if (!preserved) return;
  const root = region.root;
  if (preserved.element.isConnected && root.contains(preserved.element)) return;
  const byFocusKey = preserved.focusKey
    ? regionQuery<HTMLElement>(
        region,
        `[data-focus-key="${escapeAttribute(
          preserved.focusKey,
          getDomRealm(root).CSS,
        )}"]`,
      )
    : null;
  const byId = !byFocusKey && preserved.id
    ? regionQuery<HTMLElement>(
        region,
        `#${escapeAttribute(preserved.id, getDomRealm(root).CSS)}`,
      )
    : null;
  const byPath = preserved.path.length > 0
    ? nodeAtPath(region, preserved.path)
    : null;
  const candidate = byFocusKey
    ?? byId
    ?? (
      byPath
        && isDomInstance(byPath, getDomRealm(root).HTMLElement)
        && byPath.tagName === preserved.tagName
        ? byPath
        : null
    );
  if (!candidate) return;
  try {
    candidate.focus({ preventScroll: true });
  } catch {
    candidate.focus();
  }
}

function captureDomState(region: DomRegion): PreservedDomState {
  return {
    selection: captureSelection(region),
    focus: captureFocus(region),
    scroll: regionQueryAll<HTMLElement>(
      region,
      "pre, .callout, .markdown-embed-content",
    ).map((element) => ({
      element,
      top: element.scrollTop,
      left: element.scrollLeft,
    })),
    details: regionQueryAll<HTMLDetailsElement>(region, "details")
      .map((element) => ({ element, open: element.open })),
    callouts: regionQueryAll<HTMLElement>(region, ".callout")
      .map((element) => ({
        element,
        collapsed: element.classList.contains("is-collapsed"),
        expanded: element.querySelector<HTMLElement>(".callout-title")
          ?.getAttribute("aria-expanded") ?? null,
      })),
    copies: regionQueryAll<HTMLButtonElement>(
      region,
      ".systemsculpt-agent-code-copy",
    ).map((element) => ({
      element,
      children: Array.from(element.childNodes, (child) => child.cloneNode(true)),
      copied: element.classList.contains("is-copied"),
      failed: element.classList.contains("is-copy-failed"),
      ariaLabel: element.getAttribute("aria-label"),
      ...(element.dataset.copyAttempt
        ? { copyAttempt: element.dataset.copyAttempt }
        : {}),
    })),
  };
}

function restoreDomState(region: DomRegion, state: PreservedDomState): void {
  const root = region.root;
  const scrolling = regionQueryAll<HTMLElement>(
    region,
    "pre, .callout, .markdown-embed-content",
  );
  state.scroll.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : scrolling[index];
    if (!target) return;
    target.scrollTop = entry.top;
    target.scrollLeft = entry.left;
  });

  const details = regionQueryAll<HTMLDetailsElement>(region, "details");
  state.details.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : details[index];
    if (target) target.open = entry.open;
  });

  const callouts = regionQueryAll<HTMLElement>(region, ".callout");
  state.callouts.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : callouts[index];
    if (!target) return;
    target.classList.toggle("is-collapsed", entry.collapsed);
    const title = target.querySelector<HTMLElement>(".callout-title");
    if (title && entry.expanded !== null) {
      title.setAttribute("aria-expanded", entry.expanded);
    }
  });

  const copies = regionQueryAll<HTMLButtonElement>(
    region,
    ".systemsculpt-agent-code-copy",
  );
  state.copies.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : copies[index];
    if (!target || target === entry.element) return;
    target.classList.toggle("is-copied", entry.copied);
    target.classList.toggle("is-copy-failed", entry.failed);
    if (entry.copied || entry.failed) {
      target.replaceChildren(...entry.children.map((child) => child.cloneNode(true)));
    }
    if (entry.ariaLabel === null) target.removeAttribute("aria-label");
    else target.setAttribute("aria-label", entry.ariaLabel);
    if (entry.copyAttempt) target.dataset.copyAttempt = entry.copyAttempt;
  });

  restoreFocus(region, state.focus);
  restoreSelection(region, state.selection);
}

function compatibleNode(current: Node, incoming: Node): boolean {
  if (current.nodeType !== incoming.nodeType) return false;
  if (current.nodeType === Node.TEXT_NODE) return true;
  if (
    !isDomInstance(current, getDomRealm(current).Element)
    || !isDomInstance(incoming, getDomRealm(incoming).Element)
  ) {
    return current.nodeName === incoming.nodeName;
  }
  if (current.tagName !== incoming.tagName) return false;
  return current.matches(".systemsculpt-agent-code-copy")
    === incoming.matches(".systemsculpt-agent-code-copy");
}

function nodeContainsLeasedMarkdown(node: Node): boolean {
  if (!isDomInstance(node, getDomRealm(node).Element)) return false;
  return node.matches(LEASED_STREAM_MARKDOWN_SELECTOR)
    || node.querySelector(LEASED_STREAM_MARKDOWN_SELECTOR) !== null;
}

function renderedMarkdownBlock(node: Node): RenderedMarkdownBlock {
  const signature = isDomInstance(node, getDomRealm(node).Element)
    ? node.outerHTML
    : `${node.nodeType}:${node.nodeName}:${node.nodeValue ?? ""}`;
  return {
    signature,
    leased: nodeContainsLeasedMarkdown(node),
    nodeName: node.nodeName,
    nodeType: node.nodeType,
  };
}

function renderedMarkdownBlocks(root: HTMLElement): readonly RenderedMarkdownBlock[] {
  return Array.from(root.childNodes, renderedMarkdownBlock);
}

function sameRenderedBlock(
  left: RenderedMarkdownBlock,
  right: RenderedMarkdownBlock,
): boolean {
  return left.nodeType === right.nodeType
    && left.nodeName === right.nodeName
    && left.signature === right.signature;
}

function stableBlockMatchesLiveNode(
  block: RenderedMarkdownBlock,
  node: Node | undefined,
): boolean {
  return Boolean(
    node
    && node.nodeType === block.nodeType
    && node.nodeName === block.nodeName
    && (!block.leased || nodeContainsLeasedMarkdown(node)),
  );
}

function plainBlockRange(
  region: DomRegion,
  previousMarkdown: string | null,
  markdown: string,
  previous: readonly RenderedMarkdownBlock[],
  incoming: readonly RenderedMarkdownBlock[],
  hasRetainedLease: boolean,
): PlainBlockRange | null {
  if (
    !hasRetainedLease
    || previousMarkdown === null
    || !markdown.startsWith(previousMarkdown)
  ) return null;
  const live = regionNodes(region);
  if (live.length !== previous.length) return null;

  let start = 0;
  while (
    start < previous.length
    && start < incoming.length
    && sameRenderedBlock(previous[start], incoming[start])
  ) start += 1;

  let previousEnd = previous.length;
  let incomingEnd = incoming.length;
  while (
    previousEnd > start
    && incomingEnd > start
    && sameRenderedBlock(previous[previousEnd - 1], incoming[incomingEnd - 1])
  ) {
    previousEnd -= 1;
    incomingEnd -= 1;
  }

  const stableBlocks = [
    ...previous.slice(0, start),
    ...previous.slice(previousEnd),
  ];
  if (!stableBlocks.some((block) => block.leased)) return null;
  if (
    previous.slice(start, previousEnd).some((block) => block.leased)
    || incoming.slice(start, incomingEnd).some((block) => block.leased)
  ) return null;

  for (let index = 0; index < start; index += 1) {
    if (!stableBlockMatchesLiveNode(previous[index], live[index])) return null;
  }
  for (let offset = 0; offset < previous.length - previousEnd; offset += 1) {
    const previousIndex = previousEnd + offset;
    if (!stableBlockMatchesLiveNode(previous[previousIndex], live[previousIndex])) return null;
  }
  return { start, previousEnd, incomingEnd };
}

function syncAttributes(current: Element, incoming: Element): void {
  const realm = getDomRealm(current);
  const details = isDomInstance(current, realm.HTMLDetailsElement)
    ? current
    : null;
  const detailsOpen = details?.open;
  const calloutCollapsed = current.classList.contains("callout")
    ? current.classList.contains("is-collapsed")
    : undefined;
  const calloutExpanded = current.classList.contains("callout-title")
    ? current.getAttribute("aria-expanded")
    : null;
  const input = isDomInstance(current, realm.HTMLInputElement)
    ? current
    : null;
  const checked = input?.checked;

  for (const attribute of Array.from(current.attributes)) {
    if (!incoming.hasAttribute(attribute.name)) {
      current.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(incoming.attributes)) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }

  if (details && detailsOpen !== undefined) details.open = detailsOpen;
  if (calloutCollapsed !== undefined) {
    current.classList.toggle("is-collapsed", calloutCollapsed);
  }
  if (calloutExpanded !== null) {
    current.setAttribute("aria-expanded", calloutExpanded);
  }
  if (input && checked !== undefined) input.checked = checked;
}

function reconcileCompatibleTree(current: Node, incoming: Node): void {
  if (current.nodeType === Node.TEXT_NODE && incoming.nodeType === Node.TEXT_NODE) {
    const text = incoming.nodeValue ?? "";
    if (current.nodeValue !== text) current.nodeValue = text;
    return;
  }
  if (
    !isDomInstance(current, getDomRealm(current).Element)
    || !isDomInstance(incoming, getDomRealm(incoming).Element)
  ) {
    return;
  }
  if (
    current.matches(".systemsculpt-agent-code-copy")
    && incoming.matches(".systemsculpt-agent-code-copy")
  ) {
    return;
  }
  syncAttributes(current, incoming);
  reconcileChildNodes(current, Array.from(current.childNodes), incoming);
}

/*
 * The current nodes always run to the end of their parent, so appended
 * incoming nodes land after them.
 */
function reconcileChildNodes(
  currentParent: Node,
  current: readonly ChildNode[],
  incomingParent: Node,
): void {
  const incoming = Array.from(incomingParent.childNodes);
  for (let index = 0; index < current.length || index < incoming.length; index += 1) {
    const currentNode = current[index];
    const incomingNode = incoming[index];
    if (!currentNode && incomingNode) {
      currentParent.appendChild(incomingNode);
    } else if (currentNode && !incomingNode) {
      currentNode.remove();
    } else if (currentNode && incomingNode) {
      if (currentNode.isEqualNode(incomingNode)) continue;
      if (compatibleNode(currentNode, incomingNode)) {
        reconcileCompatibleTree(currentNode, incomingNode);
      } else {
        currentNode.replaceWith(incomingNode);
      }
    }
  }
}

function reconcilePlainBlockRange(
  region: DomRegion,
  staging: HTMLElement,
  range: PlainBlockRange,
): void {
  const preserved = captureDomState(region);
  const current = regionNodes(region);
  const currentRange = current.slice(range.start, range.previousEnd);
  const incomingRange = Array.from(staging.childNodes)
    .slice(range.start, range.incomingEnd)
    .map((node) => node.cloneNode(true));
  const suffixAnchor = current[range.previousEnd] ?? null;
  for (
    let index = 0;
    index < currentRange.length || index < incomingRange.length;
    index += 1
  ) {
    const currentNode = currentRange[index];
    const incomingNode = incomingRange[index];
    if (!currentNode && incomingNode) {
      region.root.insertBefore(incomingNode, suffixAnchor);
    } else if (currentNode && !incomingNode) {
      currentNode.remove();
    } else if (currentNode && incomingNode) {
      if (currentNode.isEqualNode(incomingNode)) continue;
      if (compatibleNode(currentNode, incomingNode)) {
        reconcileCompatibleTree(currentNode, incomingNode);
      } else {
        currentNode.replaceWith(incomingNode);
      }
    }
  }
  restoreDomState(region, preserved);
}

function reconcileRegion(region: DomRegion, staging: HTMLElement): void {
  const preserved = captureDomState(region);
  reconcileChildNodes(region.root, regionNodes(region), staging);
  restoreDomState(region, preserved);
}

/**
 * Applies a detached Markdown render without remounting stable nodes.
 * Compatible changed blocks are updated in place so text nodes,
 * selection, focus and code controls remain stable during ordinary deltas.
 */
export function reconcileLiveMarkdownDom(
  target: HTMLElement,
  staging: HTMLElement,
): void {
  reconcileRegion({ root: target, after: null }, staging);
}

function replaceRegion(
  region: DomRegion,
  ...stagings: readonly HTMLElement[]
): void {
  const preserved = captureDomState(region);
  for (const node of regionNodes(region)) node.parentNode?.removeChild(node);
  for (const staging of stagings) {
    region.root.append(...Array.from(staging.childNodes));
  }
  restoreDomState(region, preserved);
}

function cloneRenderedMarkdownDom(...stagings: readonly HTMLElement[]): HTMLElement {
  const clone = createSurfaceElement(stagings[0].ownerDocument, "div");
  for (const staging of stagings) {
    clone.append(...Array.from(staging.childNodes, (node) => node.cloneNode(true)));
  }
  return clone;
}

function hasLeasedMarkdown(staging: HTMLElement): boolean {
  return staging.querySelector(LEASED_STREAM_MARKDOWN_SELECTOR) !== null;
}

function emptySettledMarkdown(): SettledMarkdown {
  return { markdown: "", anchor: null, leases: [] };
}

/**
 * Coalesces token snapshots into detached Obsidian Markdown renders. Streaming
 * updates never await the parser. Blocks that can no longer change are parsed
 * and mounted once; later frames re-render only the open tail after them, so
 * the work for one streamed message stays linear in its length. Settlement
 * reuses an exact committed whole-message render or parses the newest
 * snapshot in full.
 */
export class LiveMarkdownRenderer extends Component {
  private readonly states = new Map<HTMLElement, LiveMarkdownState>();
  private readonly throttleMs: number;
  private readonly now: () => number;
  private domCommitDepth = 0;
  private finishDomCommit: (() => void) | undefined;
  private acceptingRequests = true;

  constructor(private readonly options: LiveMarkdownRendererOptions) {
    super();
    this.throttleMs = Math.max(
      0,
      options.throttleMs ?? DEFAULT_STREAM_RENDER_INTERVAL_MS,
    );
    this.now = options.now ?? Date.now;
  }

  public override onload(): void {
    this.acceptingRequests = true;
  }

  public stream(target: HTMLElement, markdown: string): void {
    if (!this.acceptingRequests) return;
    const state = this.request(target, markdown, false);
    if (this.reuseCommittedMarkdown(state, false)) {
      this.cancelTimer(state);
      this.resolveWaiters(state);
      return;
    }
    this.schedule(state, false);
  }

  public settle(target: HTMLElement, markdown: string): Promise<void> {
    if (!this.acceptingRequests) return Promise.resolve();
    const state = this.request(target, markdown, true);
    if (this.reuseCommittedMarkdown(state, true)) {
      this.cancelTimer(state);
      this.resolveWaiters(state);
      return Promise.resolve();
    }
    const completion = this.waitForRevision(state, state.revision);
    this.schedule(state, true);
    return completion;
  }

  public flush(target: HTMLElement): Promise<void> {
    if (!this.acceptingRequests) return Promise.resolve();
    const state = this.states.get(target);
    if (!state || state.disposed || state.committedRevision >= state.revision) {
      return Promise.resolve();
    }
    const completion = this.waitForRevision(state, state.revision);
    this.schedule(state, true);
    return completion;
  }

  public forget(target: HTMLElement): void {
    for (const [candidate, state] of this.states) {
      if (candidate !== target && !target.contains(candidate)) continue;
      state.disposed = true;
      this.cancelTimer(state);
      this.disposeLease(state.lease);
      state.lease = null;
      this.disposeSettled(state);
      state.waiters.splice(0).forEach((waiter) => waiter.resolve());
      this.states.delete(candidate);
    }
  }

  public clear(): void {
    for (const target of Array.from(this.states.keys())) this.forget(target);
  }

  public override onunload(): void {
    this.acceptingRequests = false;
    this.clear();
  }

  private request(
    target: HTMLElement,
    markdown: string,
    final: boolean,
  ): LiveMarkdownState {
    let state = this.states.get(target);
    if (!state) {
      state = {
        target,
        markdown,
        revision: 0,
        committedRevision: 0,
        committedMarkdown: null,
        committedFinal: false,
        committedBlocks: [],
        committedTail: null,
        committedTailStart: 0,
        lease: null,
        settled: emptySettledMarkdown(),
        failedRevision: null,
        lastFinishedAt: Number.NEGATIVE_INFINITY,
        lastRenderDurationMs: 0,
        timer: null,
        inFlight: null,
        renderImmediatelyAfterFlight: false,
        finalRevision: null,
        fallbackVisible: false,
        disposed: false,
        waiters: [],
      };
      this.states.set(target, state);
    }
    state.markdown = markdown;
    state.revision += 1;
    state.failedRevision = null;
    state.finalRevision = final ? state.revision : null;
    return state;
  }

  private showFinalFallback(
    state: LiveMarkdownState,
    markdown: string,
  ): void {
    const staging = createSurfaceElement(state.target.ownerDocument, "div");
    const fallback = state.target.ownerDocument.createTextNode(markdown);
    staging.append(fallback);
    this.commitDom(state.target, () => {
      const previousLease = state.lease;
      state.lease = null;
      replaceRegion({ root: state.target, after: null }, staging);
      this.disposeLease(previousLease);
      this.disposeSettled(state);
      state.target.classList.add("is-live-markdown-fallback");
      state.committedFinal = false;
      state.committedBlocks = [];
      state.committedTail = null;
      state.fallbackVisible = true;
    });
  }

  /*
   * The interval runs from the end of the previous parse and stretches to its
   * duration, so slow renders leave the main thread idle at least half the
   * time instead of running back to back.
   */
  private schedule(state: LiveMarkdownState, immediate: boolean): void {
    if (state.disposed) return;
    if (state.inFlight) {
      state.renderImmediatelyAfterFlight ||= immediate;
      return;
    }
    if (immediate) {
      this.cancelTimer(state);
      void this.startRender(state);
      return;
    }
    if (state.timer !== null || state.failedRevision === state.revision) return;
    const elapsed = this.now() - state.lastFinishedAt;
    const interval = Math.max(this.throttleMs, state.lastRenderDurationMs);
    const delay = Number.isFinite(elapsed)
      ? Math.max(0, interval - elapsed)
      : 0;
    if (delay === 0) {
      void this.startRender(state);
      return;
    }
    const ownerWindow = getSurfaceOwnerWindow(state.target);
    state.timer = ownerWindow.setTimeout(() => {
      state.timer = null;
      void this.startRender(state);
    }, delay);
  }

  private planRender(state: LiveMarkdownState): RenderPlan {
    const markdown = state.markdown;
    const settled = state.settled;
    const whole = state.finalRevision === state.revision;
    const resetSettled = settled.markdown.length > 0 && (
      whole
      || !markdown.startsWith(settled.markdown)
      || (settled.anchor !== null && settled.anchor.parentNode !== state.target)
    );
    if (whole) return { markdown, resetSettled, settleStart: 0, tailStart: 0 };
    const settleStart = resetSettled ? 0 : settled.markdown.length;
    return {
      markdown,
      resetSettled,
      settleStart,
      tailStart: stableMarkdownBoundary(markdown, settleStart),
    };
  }

  private async startRender(state: LiveMarkdownState): Promise<void> {
    if (state.disposed || state.inFlight) return;
    const revision = state.revision;
    const plan = this.planRender(state);
    const markdown = plan.markdown;
    const startedAt = this.now();
    const task = (async (): Promise<RenderOutcome> => {
      const ownerDocument = state.target.ownerDocument;
      const settling = plan.tailStart > plan.settleStart
        ? {
            staging: createSurfaceElement(ownerDocument, "div"),
            lease: this.addChild(new Component()),
          }
        : null;
      const staging = createSurfaceElement(ownerDocument, "div");
      const lease = this.addChild(new Component());
      let retainedSettlingLease = false;
      let retainedLease = false;
      try {
        if (settling) {
          await this.options.render(
            markdown.slice(plan.settleStart, plan.tailStart),
            settling.staging,
            settling.lease,
          );
          if (state.disposed) return { status: "stale" };
        }
        const tail = markdown.slice(plan.tailStart);
        await this.options.render(tail, staging, lease);
        if (state.disposed) {
          return { status: "stale" };
        }
        if (revision < state.committedRevision) {
          return { status: "stale" };
        }
        const latestMarkdown = state.markdown;
        const exactLatestMarkdown = markdown === latestMarkdown;
        if (
          !exactLatestMarkdown
          && !latestMarkdown.startsWith(markdown)
        ) {
          return { status: "stale" };
        }
        const region: DomRegion = {
          root: state.target,
          after: plan.resetSettled ? null : state.settled.anchor,
        };
        if (region.after && region.after.parentNode !== state.target) {
          // Something outside this renderer rewrote the target. Parse the
          // whole message again rather than splice into unknown nodes.
          this.disposeSettled(state);
          state.committedTail = null;
          return { status: "stale", retry: true };
        }
        const hasLeasedContent = hasLeasedMarkdown(staging);
        if (settling) {
          const settlingLeased = hasLeasedMarkdown(settling.staging);
          const settledCount = settling.staging.childNodes.length;
          const blocks = hasLeasedContent ? renderedMarkdownBlocks(staging) : [];
          this.commitDom(state.target, () => {
            const previousLease = state.lease;
            const previousSettled = plan.resetSettled ? state.settled : null;
            if (!settlingLeased && !hasLeasedContent && previousLease === null) {
              // Plain blocks keep their mounted nodes: the newly complete
              // blocks usually match what the previous frame already showed.
              reconcileRegion(
                region,
                cloneRenderedMarkdownDom(settling.staging, staging),
              );
            } else {
              replaceRegion(region, settling.staging, staging);
            }
            let anchor = region.after;
            for (
              let index = 0, node = regionStart(region);
              index < settledCount && node;
              index += 1, node = node.nextSibling
            ) anchor = node;
            if (previousSettled) state.settled = emptySettledMarkdown();
            state.settled.markdown = markdown.slice(0, plan.tailStart);
            state.settled.anchor = anchor;
            if (settlingLeased) {
              state.settled.leases.push(settling.lease);
              retainedSettlingLease = true;
            }
            state.lease = hasLeasedContent ? lease : null;
            retainedLease = hasLeasedContent;
            this.disposeLease(previousLease);
            if (previousSettled) this.disposeLeases(previousSettled.leases);
            this.markCommitted(state, markdown, revision, false, blocks, tail, plan.tailStart);
          });
          return { status: "committed" };
        }
        // A settle request can arrive while an identical streaming parse is
        // already in flight. Promote that parse to the final install instead
        // of scheduling the same Markdown twice. Only a whole-message parse
        // can become final.
        const installFinalRender = exactLatestMarkdown
          && state.finalRevision !== null
          && plan.tailStart === 0;
        // Final renders install the full tree and never compare block
        // signatures again. Avoid retaining a serialized copy of rich HTML.
        const blocks = !installFinalRender && (hasLeasedContent || state.lease !== null)
          ? renderedMarkdownBlocks(staging)
          : [];
        const comparable = !plan.resetSettled
          && state.committedTailStart === plan.tailStart;
        const plainRange = installFinalRender
          ? null
          : plainBlockRange(
            region,
            comparable ? state.committedTail : null,
            tail,
            state.committedBlocks,
            blocks,
            state.lease !== null,
          );
        this.commitDom(state.target, () => {
          const previousSettled = plan.resetSettled ? state.settled : null;
          if (plainRange) {
            // An append-only plain range can update around unchanged rich
            // blocks. Their connected nodes keep the lease that created them;
            // this detached render and its duplicate rich nodes are discarded.
            reconcilePlainBlockRange(region, staging, plainRange);
          } else if (installFinalRender || hasLeasedContent) {
            const previousLease = state.lease;
            // Final renders always install their actual staging tree. Known
            // changed interactive ranges do the same, so callbacks cannot keep
            // render-local state from an older snapshot.
            replaceRegion(region, staging);
            state.lease = lease;
            retainedLease = true;
            this.disposeLease(previousLease);
          } else {
            // Plain streamed Markdown stays stable through in-place
            // reconciliation. Its detached render lease is not retained.
            reconcileRegion(region, cloneRenderedMarkdownDom(staging));
            const previousLease = state.lease;
            state.lease = null;
            this.disposeLease(previousLease);
          }
          if (previousSettled) {
            state.settled = emptySettledMarkdown();
            this.disposeLeases(previousSettled.leases);
          }
          this.markCommitted(
            state,
            markdown,
            installFinalRender ? state.revision : revision,
            installFinalRender,
            blocks,
            tail,
            plan.tailStart,
          );
        });
        return { status: "committed" };
      } catch (error) {
        let failedRevision: number | null = null;
        if (!state.disposed && markdown === state.markdown) {
          failedRevision = state.revision;
          state.failedRevision = failedRevision;
          if (state.finalRevision === failedRevision) {
            // A terminal parser or postprocessor failure must never leave an
            // older streamed revision looking like the final answer.
            this.showFinalFallback(state, markdown);
          }
        }
        return { status: "failed", error, revision: failedRevision };
      } finally {
        if (!retainedLease) this.disposeLease(lease);
        if (settling && !retainedSettlingLease) this.disposeLease(settling.lease);
      }
    })();
    state.inFlight = task;
    const outcome = await task;
    if (state.inFlight === task) state.inFlight = null;
    state.lastFinishedAt = this.now();
    state.lastRenderDurationMs = Math.max(0, state.lastFinishedAt - startedAt);
    if (state.disposed) return;
    if (outcome.status === "committed") {
      this.resolveWaiters(state);
    } else if (outcome.status === "failed" && outcome.revision !== null) {
      this.rejectWaiters(state, outcome.revision, outcome.error);
    }

    const hasNewerRevision = (
      revision < state.revision
      || (outcome.status === "stale" && outcome.retry === true)
    )
      && state.committedRevision < state.revision
      && state.failedRevision !== state.revision;
    const forceImmediate = state.renderImmediatelyAfterFlight
      || state.finalRevision !== null
      || outcome.status === "stale";
    state.renderImmediatelyAfterFlight = false;
    if (hasNewerRevision) {
      this.schedule(state, forceImmediate);
    }
  }

  private markCommitted(
    state: LiveMarkdownState,
    markdown: string,
    revision: number,
    final: boolean,
    blocks: readonly RenderedMarkdownBlock[],
    tail: string,
    tailStart: number,
  ): void {
    state.target.classList.remove("is-live-markdown-fallback");
    state.fallbackVisible = false;
    state.committedMarkdown = markdown;
    state.committedRevision = revision;
    state.committedFinal = final;
    state.committedBlocks = blocks;
    state.committedTail = tail;
    state.committedTailStart = tailStart;
  }

  private reuseCommittedMarkdown(
    state: LiveMarkdownState,
    requireFinal: boolean,
  ): boolean {
    if (
      state.fallbackVisible
      || state.committedMarkdown !== state.markdown
    ) return false;
    if (requireFinal && !state.committedFinal) {
      // Only a whole-message parse with its live lease can stand in for the
      // final render; settled streaming blocks were parsed out of context.
      if (
        state.inFlight
        || !state.lease
        || state.settled.markdown.length > 0
      ) return false;
      state.committedFinal = true;
    }
    if (state.target.classList.contains("is-live-markdown-fallback")) {
      this.commitDom(state.target, () => {
        state.target.classList.remove("is-live-markdown-fallback");
      });
    }
    state.committedRevision = state.revision;
    state.fallbackVisible = false;
    return true;
  }

  private commitDom<T>(target: HTMLElement, commit: () => T): T {
    if (!target.isConnected) return commit();
    const outermost = this.domCommitDepth === 0;
    if (outermost) this.finishDomCommit = this.options.beginDomCommit?.(target);
    this.domCommitDepth += 1;
    try {
      return commit();
    } finally {
      this.domCommitDepth = Math.max(0, this.domCommitDepth - 1);
      if (outermost) {
        const finish = this.finishDomCommit;
        this.finishDomCommit = undefined;
        finish?.();
      }
    }
  }

  private waitForRevision(
    state: LiveMarkdownState,
    revision: number,
  ): Promise<void> {
    if (state.committedRevision >= revision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      state.waiters.push({ revision, resolve, reject });
    });
  }

  private resolveWaiters(state: LiveMarkdownState): void {
    const pending: RenderWaiter[] = [];
    for (const waiter of state.waiters) {
      if (waiter.revision <= state.committedRevision) waiter.resolve();
      else pending.push(waiter);
    }
    state.waiters = pending;
  }

  private rejectWaiters(
    state: LiveMarkdownState,
    revision: number,
    error: unknown,
  ): void {
    const pending: RenderWaiter[] = [];
    for (const waiter of state.waiters) {
      if (waiter.revision <= revision) waiter.reject(error);
      else pending.push(waiter);
    }
    state.waiters = pending;
  }

  private cancelTimer(state: LiveMarkdownState): void {
    if (state.timer === null) return;
    const ownerWindow = getSurfaceOwnerWindow(state.target);
    ownerWindow.clearTimeout(state.timer);
    state.timer = null;
  }

  private disposeSettled(state: LiveMarkdownState): void {
    const settled = state.settled;
    state.settled = emptySettledMarkdown();
    this.disposeLeases(settled.leases);
  }

  private disposeLeases(leases: readonly Component[]): void {
    for (const lease of leases) this.disposeLease(lease);
  }

  private disposeLease(lease: Component | null): void {
    if (!lease) return;
    try {
      lease.unload();
    } finally {
      this.removeChild(lease);
    }
  }
}
