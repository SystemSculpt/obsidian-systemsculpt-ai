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
  html: string;
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
  | Readonly<{ status: "stale" }>;

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

type LiveMarkdownState = {
  target: HTMLElement;
  markdown: string;
  revision: number;
  committedRevision: number;
  committedMarkdown: string | null;
  committedFinal: boolean;
  committedBlocks: readonly RenderedMarkdownBlock[];
  lease: Component | null;
  failedRevision: number | null;
  lastStartedAt: number;
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
    : constructor.prototype.isPrototypeOf(node);
}

function pointOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function captureSelection(root: HTMLElement): PreservedSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection?.anchorNode
    || !selection.focusNode
    || !root.contains(selection.anchorNode)
    || !root.contains(selection.focusNode)
  ) {
    return null;
  }
  const anchor = pointOffset(root, selection.anchorNode, selection.anchorOffset);
  const focus = pointOffset(root, selection.focusNode, selection.focusOffset);
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
  root: HTMLElement,
  requestedOffset: number,
): Readonly<{ node: Node; offset: number }> {
  const walker = root.ownerDocument.createTreeWalker(root, TEXT_NODE_FILTER);
  let remaining = Math.max(0, requestedOffset);
  let lastText: Text | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    lastText = text;
    if (remaining <= text.data.length) {
      return { node: text, offset: remaining };
    }
    remaining -= text.data.length;
  }
  if (lastText) return { node: lastText, offset: lastText.data.length };
  return { node: root, offset: 0 };
}

function restoreSelection(
  root: HTMLElement,
  preserved: PreservedSelection | null,
): void {
  if (!preserved) return;
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
    return textPoint(root, point.textOffset);
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

function childPath(root: HTMLElement, target: HTMLElement): number[] {
  const path: number[] = [];
  let current: Node | null = target;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return current === root ? path : [];
}

function nodeAtPath(root: HTMLElement, path: readonly number[]): Node | null {
  let current: Node = root;
  for (const index of path) {
    const next: Node | undefined = current.childNodes[index];
    if (!next) return null;
    current = next;
  }
  return current;
}

function captureFocus(root: HTMLElement): PreservedFocus | null {
  const active = root.ownerDocument.activeElement;
  if (
    !active
    || !isDomInstance(active, getDomRealm(root).HTMLElement)
    || !root.contains(active)
  ) {
    return null;
  }
  return {
    element: active,
    path: childPath(root, active),
    tagName: active.tagName,
    ...(active.dataset.focusKey ? { focusKey: active.dataset.focusKey } : {}),
    ...(active.id ? { id: active.id } : {}),
  };
}

function escapeAttribute(value: string, css: typeof CSS | undefined): string {
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function restoreFocus(root: HTMLElement, preserved: PreservedFocus | null): void {
  if (!preserved) return;
  if (preserved.element.isConnected && root.contains(preserved.element)) return;
  const byFocusKey = preserved.focusKey
    ? root.querySelector<HTMLElement>(
        `[data-focus-key="${escapeAttribute(
          preserved.focusKey,
          getDomRealm(root).CSS,
        )}"]`,
      )
    : null;
  const byId = !byFocusKey && preserved.id
    ? root.querySelector<HTMLElement>(
        `#${escapeAttribute(preserved.id, getDomRealm(root).CSS)}`,
      )
    : null;
  const byPath = nodeAtPath(root, preserved.path);
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

function captureDomState(root: HTMLElement): PreservedDomState {
  return {
    selection: captureSelection(root),
    focus: captureFocus(root),
    scroll: Array.from(root.querySelectorAll<HTMLElement>(
      "pre, .callout, .markdown-embed-content",
    )).map((element) => ({
      element,
      top: element.scrollTop,
      left: element.scrollLeft,
    })),
    details: Array.from(root.querySelectorAll<HTMLDetailsElement>("details"))
      .map((element) => ({ element, open: element.open })),
    callouts: Array.from(root.querySelectorAll<HTMLElement>(".callout"))
      .map((element) => ({
        element,
        collapsed: element.classList.contains("is-collapsed"),
        expanded: element.querySelector<HTMLElement>(".callout-title")
          ?.getAttribute("aria-expanded") ?? null,
      })),
    copies: Array.from(root.querySelectorAll<HTMLButtonElement>(
      ".systemsculpt-agent-code-copy",
    )).map((element) => ({
      element,
      html: element.innerHTML,
      copied: element.classList.contains("is-copied"),
      failed: element.classList.contains("is-copy-failed"),
      ariaLabel: element.getAttribute("aria-label"),
      ...(element.dataset.copyAttempt
        ? { copyAttempt: element.dataset.copyAttempt }
        : {}),
    })),
  };
}

function restoreDomState(root: HTMLElement, state: PreservedDomState): void {
  const scrolling = root.querySelectorAll<HTMLElement>(
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

  const details = root.querySelectorAll<HTMLDetailsElement>("details");
  state.details.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : details[index];
    if (target) target.open = entry.open;
  });

  const callouts = root.querySelectorAll<HTMLElement>(".callout");
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

  const copies = root.querySelectorAll<HTMLButtonElement>(
    ".systemsculpt-agent-code-copy",
  );
  state.copies.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : copies[index];
    if (!target || target === entry.element) return;
    target.classList.toggle("is-copied", entry.copied);
    target.classList.toggle("is-copy-failed", entry.failed);
    if (entry.copied || entry.failed) target.innerHTML = entry.html;
    if (entry.ariaLabel === null) target.removeAttribute("aria-label");
    else target.setAttribute("aria-label", entry.ariaLabel);
    if (entry.copyAttempt) target.dataset.copyAttempt = entry.copyAttempt;
  });

  restoreFocus(root, state.focus);
  restoreSelection(root, state.selection);
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
  target: HTMLElement,
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
    || target.childNodes.length !== previous.length
  ) return null;

  let start = 0;
  while (
    start < previous.length
    && start < incoming.length
    && sameRenderedBlock(previous[start]!, incoming[start]!)
  ) start += 1;

  let previousEnd = previous.length;
  let incomingEnd = incoming.length;
  while (
    previousEnd > start
    && incomingEnd > start
    && sameRenderedBlock(previous[previousEnd - 1]!, incoming[incomingEnd - 1]!)
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

  const live = Array.from(target.childNodes);
  for (let index = 0; index < start; index += 1) {
    if (!stableBlockMatchesLiveNode(previous[index]!, live[index])) return null;
  }
  for (let offset = 0; offset < previous.length - previousEnd; offset += 1) {
    const previousIndex = previousEnd + offset;
    if (!stableBlockMatchesLiveNode(previous[previousIndex]!, live[previousIndex])) return null;
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
  reconcileChildNodes(current, incoming);
}

function reconcileChildNodes(currentParent: Node, incomingParent: Node): void {
  const current = Array.from(currentParent.childNodes);
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
  target: HTMLElement,
  staging: HTMLElement,
  range: PlainBlockRange,
): void {
  const preserved = captureDomState(target);
  const current = Array.from(target.childNodes);
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
      target.insertBefore(incomingNode, suffixAnchor);
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
  restoreDomState(target, preserved);
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
  const preserved = captureDomState(target);
  reconcileChildNodes(target, staging);
  restoreDomState(target, preserved);
}

function replaceLiveMarkdownDom(
  target: HTMLElement,
  staging: HTMLElement,
): void {
  const preserved = captureDomState(target);
  target.replaceChildren(...Array.from(staging.childNodes));
  restoreDomState(target, preserved);
}

function cloneRenderedMarkdownDom(staging: HTMLElement): HTMLElement {
  const clone = createSurfaceElement(staging.ownerDocument, "div");
  clone.append(...Array.from(staging.childNodes, (node) => node.cloneNode(true)));
  return clone;
}

/**
 * Coalesces token snapshots into detached Obsidian Markdown renders. Streaming
 * updates never await the parser. Settlement reuses an exact committed render
 * or waits for the newest snapshot.
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
        lease: null,
        failedRevision: null,
        lastStartedAt: Number.NEGATIVE_INFINITY,
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
      replaceLiveMarkdownDom(state.target, staging);
      this.disposeLease(previousLease);
      state.target.classList.add("is-live-markdown-fallback");
      state.committedFinal = false;
      state.committedBlocks = [];
      state.fallbackVisible = true;
    });
  }

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
    const elapsed = this.now() - state.lastStartedAt;
    const delay = Number.isFinite(elapsed)
      ? Math.max(0, this.throttleMs - elapsed)
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

  private async startRender(state: LiveMarkdownState): Promise<void> {
    if (state.disposed || state.inFlight) return;
    const revision = state.revision;
    const markdown = state.markdown;
    state.lastStartedAt = this.now();
    const task = (async (): Promise<RenderOutcome> => {
      const staging = createSurfaceElement(state.target.ownerDocument, "div");
      const lease = this.addChild(new Component());
      let retainedLease = false;
      try {
        await this.options.render(markdown, staging, lease);
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
        const hasLeasedContent = staging.querySelector(
          LEASED_STREAM_MARKDOWN_SELECTOR,
        ) !== null;
        // A settle request can arrive while an identical streaming parse is
        // already in flight. Promote that parse to the final install instead
        // of scheduling the same Markdown twice.
        const installFinalRender = exactLatestMarkdown
          && state.finalRevision !== null;
        // Final renders install the full tree and never compare block
        // signatures again. Avoid retaining a serialized copy of rich HTML.
        const blocks = !installFinalRender && (hasLeasedContent || state.lease !== null)
          ? renderedMarkdownBlocks(staging)
          : [];
        const plainRange = installFinalRender
          ? null
          : plainBlockRange(
            state.target,
            state.committedMarkdown,
            markdown,
            state.committedBlocks,
            blocks,
            state.lease !== null,
          );
        this.commitDom(state.target, () => {
          if (plainRange) {
            // An append-only plain range can update around unchanged rich
            // blocks. Their connected nodes keep the lease that created them;
            // this detached render and its duplicate rich nodes are discarded.
            reconcilePlainBlockRange(state.target, staging, plainRange);
          } else if (installFinalRender || hasLeasedContent) {
            const previousLease = state.lease;
            // Final renders always install their actual staging tree. Known
            // changed interactive ranges do the same, so callbacks cannot keep
            // render-local state from an older snapshot.
            replaceLiveMarkdownDom(state.target, staging);
            state.lease = lease;
            retainedLease = true;
            this.disposeLease(previousLease);
          } else {
            // Plain streamed Markdown stays stable through in-place
            // reconciliation. Its detached render lease is not retained.
            reconcileLiveMarkdownDom(
              state.target,
              cloneRenderedMarkdownDom(staging),
            );
            const previousLease = state.lease;
            state.lease = null;
            this.disposeLease(previousLease);
          }
          state.target.classList.remove("is-live-markdown-fallback");
          state.fallbackVisible = false;
          state.committedMarkdown = markdown;
          state.committedRevision = installFinalRender
            ? state.revision
            : revision;
          state.committedFinal = installFinalRender;
          state.committedBlocks = blocks;
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
      }
    })();
    state.inFlight = task;
    const outcome = await task;
    if (state.inFlight === task) state.inFlight = null;
    if (state.disposed) return;
    if (outcome.status === "committed") {
      this.resolveWaiters(state);
    } else if (outcome.status === "failed" && outcome.revision !== null) {
      this.rejectWaiters(state, outcome.revision, outcome.error);
    }

    const hasNewerRevision = revision < state.revision
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

  private reuseCommittedMarkdown(
    state: LiveMarkdownState,
    requireFinal: boolean,
  ): boolean {
    if (
      state.fallbackVisible
      || state.committedMarkdown !== state.markdown
    ) return false;
    if (requireFinal && !state.committedFinal) {
      if (state.inFlight || !state.lease) return false;
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

  private disposeLease(lease: Component | null): void {
    if (!lease) return;
    try {
      lease.unload();
    } finally {
      this.removeChild(lease);
    }
  }
}
