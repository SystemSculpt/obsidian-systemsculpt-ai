/** @jest-environment jsdom */

import { Platform } from "obsidian";
import {
  disposeMobileHostLayoutStates,
  ensureMobileHostLayoutState,
  MOBILE_HOST_LAYOUT_CLASSES,
  readMobileHostLayout,
} from "../mobileHostLayout";

type MutablePlatform = typeof Platform & {
  isDesktopApp?: boolean;
  isMobile?: boolean;
  isMobileApp?: boolean;
};

async function waitForOwnedClass(className: string, present: boolean): Promise<void> {
  if (document.body.classList.contains(className) === present) return;
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains(className) !== present) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error(
        `Timed out waiting for ${className} to become ${present ? "present" : "absent"}.`,
      ));
    }, 1_000);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  });
}

describe("mobile host layout adapter", () => {
  const platform = Platform as MutablePlatform;

  beforeEach(() => {
    platform.isDesktopApp = false;
    platform.isMobile = true;
    platform.isMobileApp = true;
    document.body.className = "";
    document.body.replaceChildren();
  });

  afterEach(() => {
    disposeMobileHostLayoutStates();
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
  });

  it("publishes only SystemSculpt-owned mobile state to feature CSS", () => {
    ensureMobileHostLayoutState(document);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.layout)).toBe(true);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(true);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(false);
  });

  it("maps Obsidian's private navbar element into an owned visible state", () => {
    document.body.appendChild(Object.assign(document.createElement("nav"), {
      className: "mobile-navbar-action",
    }));

    ensureMobileHostLayoutState(document.body);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(false);
  });

  it("tracks navbar insertion and visibility changes without feature-owned DOM queries", async () => {
    ensureMobileHostLayoutState(document);
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    document.body.appendChild(navbar);
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);

    navbar.hidden = true;
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, false);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(false);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(true);
  });

  it("falls back to the platform instanceof check when the Obsidian helper is unavailable", async () => {
    const nodePrototype = window.Node.prototype as Node & {
      instanceOf?: (constructor: typeof Element) => boolean;
    };
    const instanceOf = nodePrototype.instanceOf;
    delete nodePrototype.instanceOf;
    try {
      ensureMobileHostLayoutState(document);
      const navbar = document.createElement("nav");
      navbar.className = "mobile-navbar-action";
      document.body.appendChild(navbar);
      await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);

      expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);
    } finally {
      if (instanceOf) nodePrototype.instanceOf = instanceOf;
    }
  });

  it("tracks navbar visibility changes made on a host wrapper", async () => {
    const wrapper = document.createElement("footer");
    const navbar = document.createElement("button");
    navbar.className = "mobile-navbar-action";
    wrapper.appendChild(navbar);
    document.body.appendChild(wrapper);
    ensureMobileHostLayoutState(document);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);

    wrapper.hidden = true;
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, false);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(false);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(true);

    wrapper.hidden = false;
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(false);
  });

  it("tracks aria-hidden changes made on mobile chrome", async () => {
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    document.body.appendChild(navbar);
    ensureMobileHostLayoutState(document);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);

    navbar.setAttribute("aria-hidden", "true");
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, false);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(false);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(true);

    navbar.setAttribute("aria-hidden", "false");
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(false);
  });

  it("reports the navbar boundary as the usable viewport bottom", () => {
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    navbar.getBoundingClientRect = jest.fn(() => ({
      x: 0,
      y: 720,
      top: 720,
      right: 400,
      bottom: 800,
      left: 0,
      width: 400,
      height: 80,
      toJSON: () => ({}),
    }));
    document.body.appendChild(navbar);
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });

    expect(readMobileHostLayout(navbar)).toEqual({
      isMobile: true,
      navbarVisible: true,
      navbarTop: 720,
      viewportBottom: 720,
    });
  });

  it("removes owned body state and observers during plugin teardown", () => {
    ensureMobileHostLayoutState(document);

    disposeMobileHostLayoutStates();

    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.layout)).toBe(false);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(false);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(false);
  });
});
