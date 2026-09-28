import {
  cancelSurfaceAnimationFrame,
  createSurfaceSvgElement,
  getSurfaceOwnerDocument,
  getSurfaceOwnerWindow,
  requestSurfaceAnimationFrame,
} from "../../core/ui/surface/SurfaceDomContext";

/**
 * Studio DOM ownership seam.
 *
 * Obsidian can move a leaf into a popout window. Every listener, timer, focus
 * lookup, and created SVG node must therefore follow the mounted Studio DOM
 * instead of the plugin's primary global window.
 */
export function getStudioOwnerDocument(host: Node): Document {
  return getSurfaceOwnerDocument(host);
}

export function getStudioOwnerWindow(host: Node): Window {
  return getSurfaceOwnerWindow(host);
}

export function createStudioSvgElement<K extends keyof SVGElementTagNameMap>(
  host: Node,
  tagName: K
): SVGElementTagNameMap[K] {
  return createSurfaceSvgElement(getStudioOwnerDocument(host), tagName);
}

export function requestStudioAnimationFrame(
  host: Node,
  callback: FrameRequestCallback
): number {
  return requestSurfaceAnimationFrame(host, callback);
}

export function cancelStudioAnimationFrame(host: Node, handle: number): void {
  cancelSurfaceAnimationFrame(host, handle);
}
