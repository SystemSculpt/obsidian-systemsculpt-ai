import {
  isMobileLayout,
  resolveMobileLayoutDocument,
  type MobileLayoutOwner,
} from "./mobileLayout";

const HOST_MOBILE_NAV_SELECTOR = ".mobile-navbar-action";
const MOBILE_LAYOUT_CLASS = "ss-mobile-layout";
const MOBILE_NAV_VISIBLE_CLASS = "ss-mobile-navbar-visible";
const MOBILE_NAV_HIDDEN_CLASS = "ss-mobile-navbar-hidden";

type MobileHostLayoutController = {
  document: Document;
  observer: MutationObserver | null;
  scheduledFrame: number | null;
  update(): void;
  schedule(): void;
  dispose(): void;
};

export type MobileHostLayoutSnapshot = Readonly<{
  isMobile: boolean;
  navbarVisible: boolean;
  navbarTop: number | null;
  viewportBottom: number;
}>;

const controllers = new Map<Document, MobileHostLayoutController>();

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
  const controller: MobileHostLayoutController = {
    document,
    observer: null,
    scheduledFrame: null,
    update(): void {
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
      controller.observer?.disconnect();
      ownerWindow?.removeEventListener("resize", controller.schedule);
      ownerWindow?.visualViewport?.removeEventListener("resize", controller.schedule);
      document.body.classList.remove(
        MOBILE_LAYOUT_CLASS,
        MOBILE_NAV_VISIBLE_CLASS,
        MOBILE_NAV_HIDDEN_CLASS,
      );
      controllers.delete(document);
    },
  };

  const MutationObserverCtor = ownerWindow?.MutationObserver
    ?? (typeof MutationObserver !== "undefined" ? MutationObserver : null);
  if (MutationObserverCtor) {
    const ElementCtor = ownerWindow?.Element
      ?? (typeof Element !== "undefined" ? Element : null);
    controller.observer = new MutationObserverCtor((records) => {
      const hostChromeChanged = records.some((record) => {
        if (record.type === "attributes") {
          const target = record.target;
          return target === document.body
            || (ElementCtor !== null
              && target.instanceOf(ElementCtor)
              && (target.matches(HOST_MOBILE_NAV_SELECTOR)
                || target.querySelector(HOST_MOBILE_NAV_SELECTOR) !== null));
        }
        return [...record.addedNodes, ...record.removedNodes].some((node) =>
          ElementCtor !== null
          && node.instanceOf(ElementCtor)
          && (node.matches(HOST_MOBILE_NAV_SELECTOR)
            || node.querySelector(HOST_MOBILE_NAV_SELECTOR) !== null),
        );
      });
      if (hostChromeChanged) {
        controller.schedule();
      }
    });
    controller.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "hidden", "style"],
      childList: true,
      subtree: true,
    });
  }
  ownerWindow?.addEventListener("resize", controller.schedule);
  ownerWindow?.visualViewport?.addEventListener("resize", controller.schedule);
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
