export type PreservedDomSelection = Readonly<{
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}>;

export type PreservedDetailsState = readonly Readonly<{
  element: HTMLDetailsElement;
  open: boolean;
}>[];

/** Read from the initiating document, including Obsidian pop-out windows. */
export function focusedElementWithin(root: HTMLElement): HTMLElement | null {
  const active = root.ownerDocument.activeElement;
  return active?.nodeType === 1 && root.contains(active) ? active as HTMLElement : null;
}

/** Match data, not a CSS selector: focus keys need no escaping or interpolation. */
export function findFocusKey(root: HTMLElement, key: string): HTMLElement | null {
  if (root.dataset.focusKey === key) return root;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-focus-key]"))
    .find((candidate) => candidate.dataset.focusKey === key) ?? null;
}

export function captureDomSelection(root: HTMLElement): PreservedDomSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.focusNode
    || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

/** Restore exact retained nodes; callers remap replaced Markdown points first. */
export function restoreDomSelection(selection: PreservedDomSelection | null): void {
  if (!selection || !selection.anchorNode.isConnected || !selection.focusNode.isConnected) return;
  const document = selection.anchorNode.ownerDocument;
  const current = document?.getSelection();
  if (!document || !current) return;
  const maximumOffset = (node: Node): number => node.nodeType === Node.TEXT_NODE
    ? node.nodeValue?.length ?? 0
    : node.childNodes.length;
  const anchorOffset = Math.min(selection.anchorOffset, maximumOffset(selection.anchorNode));
  const focusOffset = Math.min(selection.focusOffset, maximumOffset(selection.focusNode));
  try {
    current.removeAllRanges();
    if (typeof current.setBaseAndExtent === "function") {
      current.setBaseAndExtent(selection.anchorNode, anchorOffset, selection.focusNode, focusOffset);
      return;
    }
    const range = document.createRange();
    range.setStart(selection.anchorNode, anchorOffset);
    range.setEnd(selection.focusNode, focusOffset);
    current.addRange(range);
  } catch {
    current.removeAllRanges();
  }
}

export function captureDetailsState(elements: Iterable<HTMLDetailsElement>): PreservedDetailsState {
  return Array.from(elements, (element) => ({ element, open: element.open }));
}

export function restoreDetailsState(
  root: HTMLElement,
  state: PreservedDetailsState,
  replacements: readonly HTMLDetailsElement[],
  onRestore?: (element: HTMLDetailsElement, open: boolean) => void,
): void {
  state.forEach((entry, index) => {
    const target = entry.element.isConnected && root.contains(entry.element)
      ? entry.element
      : replacements[index];
    if (!target) return;
    target.open = entry.open;
    onRestore?.(target, entry.open);
  });
}
