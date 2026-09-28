export interface SurfaceDomContext {
  host: HTMLElement;
  document: Document;
  window: Window;
}

type ObsidianElementFactory = {
  createEl?: <K extends keyof HTMLElementTagNameMap>(tagName: K) => HTMLElementTagNameMap[K];
  createFragment?: () => DocumentFragment;
};

type NativeDocumentElementFactory = {
  createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
  ): HTMLElementTagNameMap[K];
};

function getObsidianElementFactory(ownerDocument: Document): ObsidianElementFactory | null {
  return (ownerDocument as Document & { win?: ObsidianElementFactory }).win
    ?? (ownerDocument.defaultView)
    ?? null;
}

/** Creates an element in the supplied surface realm, including plain test documents. */
export function createSurfaceElement<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  const factory = getObsidianElementFactory(ownerDocument);
  if (typeof factory?.createEl === "function") {
    return factory.createEl(tagName);
  }
  const nativeDocument: NativeDocumentElementFactory = ownerDocument;
  return nativeDocument.createElement(tagName);
}

/** Creates a fragment in the supplied surface realm. */
export function createSurfaceFragment(ownerDocument: Document): DocumentFragment {
  const factory = getObsidianElementFactory(ownerDocument);
  if (typeof factory?.createFragment === "function") {
    return factory.createFragment();
  }
  const createDocumentFragment = ownerDocument.createDocumentFragment.bind(ownerDocument);
  return createDocumentFragment();
}

/** Creates an SVG element in the supplied surface realm without appending it. */
export function createSurfaceSvgElement<K extends keyof SVGElementTagNameMap>(
  ownerDocument: Document,
  tagName: K,
): SVGElementTagNameMap[K] {
  const createElementNS = ownerDocument.createElementNS.bind(ownerDocument);
  return createElementNS("http://www.w3.org/2000/svg", tagName);
}

/** Resolves DOM ownership from the mounted surface, including Obsidian popouts. */
export function getSurfaceOwnerDocument(host: Node): Document {
  if (host.ownerDocument) return host.ownerDocument;
  if (host.nodeType === 9) return host as Document;
  throw new Error("UI surface host is not attached to a document.");
}

/** Resolves the Window that owns a mounted UI surface. */
export function getSurfaceOwnerWindow(host: Node): Window {
  const ownerDocument = getSurfaceOwnerDocument(host);
  if (ownerDocument.defaultView) return ownerDocument.defaultView;
  // Detached implementation-created documents occur in unit tests. Live
  // Obsidian surface documents always have a defaultView.
  return window;
}

/** Captures one stable host/document/window tuple for a surface lifecycle. */
export function resolveSurfaceDomContext(configuredHost?: HTMLElement): SurfaceDomContext {
  const activeDocument = typeof window !== "undefined" ? window.activeDocument : undefined;
  const host = configuredHost ?? activeDocument?.body ?? document.body;
  return {
    host,
    document: getSurfaceOwnerDocument(host),
    window: getSurfaceOwnerWindow(host),
  };
}

export function requestSurfaceAnimationFrame(
  host: Node,
  callback: FrameRequestCallback,
): number {
  const ownerWindow = getSurfaceOwnerWindow(host);
  if (typeof ownerWindow.requestAnimationFrame === "function") {
    return ownerWindow.requestAnimationFrame(callback);
  }
  return ownerWindow.setTimeout(() => callback(Date.now()), 16);
}

export function cancelSurfaceAnimationFrame(host: Node, handle: number): void {
  const ownerWindow = getSurfaceOwnerWindow(host);
  if (typeof ownerWindow.cancelAnimationFrame === "function") {
    ownerWindow.cancelAnimationFrame(handle);
  } else {
    ownerWindow.clearTimeout(handle);
  }
}
