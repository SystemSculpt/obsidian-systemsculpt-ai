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

describe("mobile host layout observation scope", () => {
  const platform = Platform as MutablePlatform;
  const NativeMutationObserver = window.MutationObserver;
  type Observation = { target: Node; options: MutationObserverInit };
  const active = new Map<MutationObserver, Observation[]>();

  class RecordingMutationObserver extends NativeMutationObserver {
    override observe(target: Node, options?: MutationObserverInit): void {
      const list = active.get(this) ?? [];
      list.push({ target, options: options ?? {} });
      active.set(this, list);
      super.observe(target, options);
    }

    override disconnect(): void {
      active.delete(this);
      super.disconnect();
    }
  }

  const observations = (): Observation[] => [...active.values()].flat();
  const subtreeObservations = (): Observation[] => observations().filter(({ options }) => options.subtree === true);

  beforeEach(() => {
    active.clear();
    window.MutationObserver = RecordingMutationObserver as typeof MutationObserver;
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
    document.body.className = "";
    document.body.replaceChildren();
  });

  afterEach(() => {
    disposeMobileHostLayoutStates();
    window.MutationObserver = NativeMutationObserver;
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
    document.body.className = "";
  });

  it("watches only body class changes on desktop, with no subtree or resize listeners", () => {
    const addEventListener = jest.spyOn(window, "addEventListener");

    ensureMobileHostLayoutState(document);

    expect(observations()).toEqual([
      { target: document.body, options: { attributes: true, attributeFilter: ["class"] } },
    ]);
    expect(addEventListener).not.toHaveBeenCalledWith("resize", expect.anything());
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.layout)).toBe(false);
    addEventListener.mockRestore();
  });

  it("follows mobile emulation on and off, installing navbar tracking only while mobile", async () => {
    ensureMobileHostLayoutState(document);
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    document.body.appendChild(navbar);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(false);

    document.body.classList.add("is-mobile");
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.layout)).toBe(true);
    expect(subtreeObservations()).toEqual([]);
    expect(observations().some(({ target }) => target === navbar)).toBe(true);

    document.body.classList.remove("is-mobile");
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.layout, false);
    expect(observations()).toEqual([
      { target: document.body, options: { attributes: true, attributeFilter: ["class"] } },
    ]);
  });

  it("stops subtree discovery once the navbar is found and resumes it when the navbar leaves", async () => {
    platform.isDesktopApp = false;
    platform.isMobile = true;
    platform.isMobileApp = true;
    ensureMobileHostLayoutState(document);
    expect(subtreeObservations()).toEqual([
      { target: document.body, options: { childList: true, subtree: true } },
    ]);

    const wrapper = document.createElement("div");
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    wrapper.appendChild(navbar);
    document.body.appendChild(wrapper);
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);

    expect(subtreeObservations()).toEqual([]);
    const tracked = observations().filter(({ options }) => options.subtree !== true);
    expect(tracked.map(({ target }) => target)).toEqual(expect.arrayContaining([navbar, wrapper, document.body]));

    wrapper.remove();
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, false);
    expect(subtreeObservations()).toEqual([
      { target: document.body, options: { childList: true, subtree: true } },
    ]);
  });

  it("follows a connected navbar moved under a hidden container and back out", async () => {
    platform.isDesktopApp = false;
    platform.isMobile = true;
    platform.isMobileApp = true;
    const visibleHost = document.createElement("div");
    const hiddenHost = document.createElement("div");
    hiddenHost.hidden = true;
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    visibleHost.appendChild(navbar);
    document.body.append(visibleHost, hiddenHost);
    ensureMobileHostLayoutState(document);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible)).toBe(true);

    hiddenHost.appendChild(navbar);
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, false);
    expect(document.body.classList.contains(MOBILE_HOST_LAYOUT_CLASSES.navbarHidden)).toBe(true);
    expect(subtreeObservations()).toEqual([]);
    expect(observations().some(({ target }) => target === hiddenHost)).toBe(true);

    // The new host's own visibility is now observed directly.
    hiddenHost.hidden = false;
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);

    hiddenHost.hidden = true;
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, false);
    visibleHost.appendChild(navbar);
    await waitForOwnedClass(MOBILE_HOST_LAYOUT_CLASSES.navbarVisible, true);
    expect(subtreeObservations()).toEqual([]);
  });

  it("ignores unrelated body descendants once the navbar is tracked", async () => {
    platform.isDesktopApp = false;
    platform.isMobile = true;
    platform.isMobileApp = true;
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar-action";
    document.body.appendChild(navbar);
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    ensureMobileHostLayoutState(document);
    const querySelector = jest.spyOn(Element.prototype, "querySelector");

    pane.setAttribute("style", "width: 10px");
    pane.appendChild(document.createElement("span"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(querySelector).not.toHaveBeenCalled();
    querySelector.mockRestore();
  });
});
