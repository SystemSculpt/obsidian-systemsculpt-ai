import {
  isMobileLayout,
  resolveMobileLayoutDocument,
  type MobileLayoutOwner,
} from "./mobileLayout";

const HOST_MOBILE_NAV_SELECTOR = ".mobile-navbar-action";
const MOBILE_LAYOUT_CLASS = "ss-mobile-layout";
const MOBILE_NAV_VISIBLE_CLASS = "ss-mobile-navbar-visible";
const MOBILE_NAV_HIDDEN_CLASS = "ss-mobile-navbar-hidden";

const NAVBAR_VISIBILITY_ATTRIBUTES = ["aria-hidden", "class", "hidden", "style"];

type MobileHostLayoutController = {
  document: Document;
  /** Watches only body class changes, which toggle Obsidian's mobile emulation. */
  bodyObserver: MutationObserver | null;
  /** Installed only in a mobile layout: finds the navbar, then follows it. */
  navbarObserver: MutationObserver | null;
  trackedNavbar: HTMLElement | null;
  mobileActive: boolean;
  scheduledFrame: number | null;
  update: () => void;
  schedule: () => void;
  dispose: () => void;
};

export type MobileHostLayoutSnapshot = Readonly<{
  isMobile: boolean;
  navbarVisible: boolean;
  navbarTop: number | null;
  viewportBottom: number;
}>;

const controllers = new Map<Document, MobileHostLayoutController>();

function isOwnerElement(node: Node, ElementCtor: typeof Element): node is Element {
  const obsidianNode = node as Node & {
    instanceOf?: (constructor: typeof Element) => boolean;
  };
  return typeof obsidianNode.instanceOf === "function"
    ? obsidianNode.instanceOf(ElementCtor)
    : Object.prototype.isPrototypeOf.call(ElementCtor.prototype, node);
}

function readVisibleNavbar(document: Document): HTMLElement | null {
  const navbar = document.querySelector<HTMLElement>(HOST_MOBILE_NAV_SELECTOR);
  if (!navbar || !navbar.isConnected) {
    return null;
  }

  for (let element: HTMLElement | null = navbar; element; element = element.parentElement) {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") {
      return null;
    }
    const computedStyle = document.defaultView?.getComputedStyle(element);
    if (computedStyle?.display === "none" || computedStyle?.visibility === "hidden") {
      return null;
    }
    if (element === document.body) {
      break;
    }
  }
  return navbar;
}

function updateOwnedClasses(document: Document): void {
  const mobile = isMobileLayout(document);
  const navbarVisible = mobile && readVisibleNavbar(document) !== null;
  document.body.classList.toggle(MOBILE_LAYOUT_CLASS, mobile);
  document.body.classList.toggle(MOBILE_NAV_VISIBLE_CLASS, navbarVisible);
  document.body.classList.toggle(MOBILE_NAV_HIDDEN_CLASS, mobile && !navbarVisible);
}

function createController(document: Document): MobileHostLayoutController {
  const ownerWindow = document.defaultView;
  const MutationObserverCtor = ownerWindow?.MutationObserver
    ?? (typeof MutationObserver !== "undefined" ? MutationObserver : null);
  const ElementCtor = ownerWindow?.Element
    ?? (typeof Element !== "undefined" ? Element : null);
  const containsNavbar = (node: Node): boolean => ElementCtor !== null
    && isOwnerElement(node, ElementCtor)
    && (node.matches(HOST_MOBILE_NAV_SELECTOR) || node.querySelector(HOST_MOBILE_NAV_SELECTOR) !== null);

  const controller: MobileHostLayoutController = {
    document,
    bodyObserver: null,
    navbarObserver: null,
    trackedNavbar: null,
    mobileActive: false,
    scheduledFrame: null,
    update(): void {
      syncMobileLayout();
      updateOwnedClasses(document);
    },
    schedule(): void {
      if (controller.scheduledFrame !== null) {
        return;
      }
      const requestFrame = ownerWindow?.requestAnimationFrame?.bind(ownerWindow);
      if (requestFrame) {
        controller.scheduledFrame = requestFrame(() => {
          controller.scheduledFrame = null;
          controller.update();
        });
        return;
      }
      controller.update();
    },
    dispose(): void {
      if (controller.scheduledFrame !== null && ownerWindow?.cancelAnimationFrame) {
        ownerWindow.cancelAnimationFrame(controller.scheduledFrame);
      }
      controller.scheduledFrame = null;
      controller.bodyObserver?.disconnect();
      controller.bodyObserver = null;
      leaveMobileLayout();
      document.body.classList.remove(
        MOBILE_LAYOUT_CLASS,
        MOBILE_NAV_VISIBLE_CLASS,
        MOBILE_NAV_HIDDEN_CLASS,
      );
      controllers.delete(document);
    },
  };

  /**
   * Discovery watches body descendants for the navbar's insertion. Once found,
   * only the navbar and its ancestors are observed, without subtree: their
   * visibility attributes, and their child lists to notice the navbar leaving.
   */
  function trackNavbar(): void {
    const observer = controller.navbarObserver;
    if (!observer) return;
    const navbar = document.querySelector<HTMLElement>(HOST_MOBILE_NAV_SELECTOR);
    const found = navbar?.isConnected ? navbar : null;
    if (found && found === controller.trackedNavbar) return;
    observer.disconnect();
    controller.trackedNavbar = found;
    if (!found) {
      observer.observe(document.body, { childList: true, subtree: true });
      return;
    }
    for (let element: HTMLElement | null = found; element; element = element.parentElement) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: NAVBAR_VISIBILITY_ATTRIBUTES,
        childList: element !== found,
      });
      if (element === document.body) break;
    }
  }

  function enterMobileLayout(): void {
    controller.mobileActive = true;
    ownerWindow?.addEventListener("resize", controller.schedule);
    ownerWindow?.visualViewport?.addEventListener("resize", controller.schedule);
    if (MutationObserverCtor) {
      controller.navbarObserver = new MutationObserverCtor((records) => {
        const tracked = controller.trackedNavbar;
        if (tracked) {
          if (!tracked.isConnected) {
            trackNavbar();
            controller.schedule();
          } else if (records.some((record) => record.type === "attributes")) {
            controller.schedule();
          }
          return;
        }
        const inserted = records.some((record) => [...record.addedNodes].some(containsNavbar));
        if (inserted) {
          trackNavbar();
          controller.schedule();
        }
      });
    }
    trackNavbar();
  }

  function leaveMobileLayout(): void {
    controller.mobileActive = false;
    controller.navbarObserver?.disconnect();
    controller.navbarObserver = null;
    controller.trackedNavbar = null;
    ownerWindow?.removeEventListener("resize", controller.schedule);
    ownerWindow?.visualViewport?.removeEventListener("resize", controller.schedule);
  }

  function syncMobileLayout(): void {
    const mobile = isMobileLayout(document);
    if (mobile === controller.mobileActive) {
      if (mobile) trackNavbar();
      return;
    }
    if (mobile) enterMobileLayout();
    else leaveMobileLayout();
  }

  if (MutationObserverCtor) {
    // No subtree: desktop typing, scrolling, and pane resizing never reach
    // this observer. Only body class changes (mobile emulation) do.
    controller.bodyObserver = new MutationObserverCtor(() => controller.schedule());
    controller.bodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  controller.update();
  return controller;
}

/**
 * Maps Obsidian's current mobile chrome into SystemSculpt-owned body classes.
 * Feature CSS consumes only these owned classes, keeping host DOM knowledge in
 * one replaceable adapter.
 */
export function ensureMobileHostLayoutState(owner?: MobileLayoutOwner): void {
  const document = resolveMobileLayoutDocument(owner);
  if (!document?.body) {
    return;
  }
  if (!controllers.has(document)) {
    controllers.set(document, createController(document));
    return;
  }
  controllers.get(document)?.update();
}

/** Reads the current usable viewport boundary for a surface or pop-out. */
export function readMobileHostLayout(owner?: MobileLayoutOwner): MobileHostLayoutSnapshot {
  const document = resolveMobileLayoutDocument(owner);
  const ownerWindow = document?.defaultView;
  const viewportBottom = ownerWindow?.innerHeight
    ?? (typeof window !== "undefined" ? window.innerHeight : 0);
  if (!document?.body) {
    return { isMobile: false, navbarVisible: false, navbarTop: null, viewportBottom };
  }

  ensureMobileHostLayoutState(document);
  const mobile = isMobileLayout(document);
  const navbar = mobile ? readVisibleNavbar(document) : null;
  const navbarRect = navbar?.getBoundingClientRect();
  const navbarTop = navbarRect && navbarRect.height > 0 ? navbarRect.top : null;
  return {
    isMobile: mobile,
    navbarVisible: navbar !== null,
    navbarTop,
    viewportBottom: navbarTop === null ? viewportBottom : Math.min(viewportBottom, navbarTop),
  };
}

export function disposeMobileHostLayoutStates(): void {
  [...controllers.values()].forEach((controller) => controller.dispose());
}

export const MOBILE_HOST_LAYOUT_CLASSES = Object.freeze({
  layout: MOBILE_LAYOUT_CLASS,
  navbarVisible: MOBILE_NAV_VISIBLE_CLASS,
  navbarHidden: MOBILE_NAV_HIDDEN_CLASS,
});
