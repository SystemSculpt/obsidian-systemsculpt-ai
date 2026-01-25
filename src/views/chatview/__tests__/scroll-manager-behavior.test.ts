/**
 * @jest-environment jsdom
 */

import { ScrollManagerService } from "../ScrollManagerService";

interface ContainerState {
  scrollHeight: number;
  scrollTop: number;
}

const containerState = new WeakMap<HTMLElement, ContainerState>();

describe("ScrollManagerService sticky bottom behavior", () => {
  const rafIds: number[] = [];

  const waitForMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const settleProgrammaticScroll = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
  const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - (el.scrollTop + el.clientHeight);

  beforeAll(() => {
    class NoopIntersectionObserver {
      constructor(_cb: IntersectionObserverCallback) {}
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }

    class NoopResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    (window as any).IntersectionObserver = NoopIntersectionObserver;
    (window as any).ResizeObserver = NoopResizeObserver;

    const raf = (callback: FrameRequestCallback) => {
      const id = window.setTimeout(() => callback(performance.now()), 0);
      rafIds.push(id);
      return id;
    };
    const caf = (id: number) => {
      const index = rafIds.indexOf(id);
      if (index >= 0) rafIds.splice(index, 1);
      window.clearTimeout(id);
    };

    (window as any).requestAnimationFrame = raf;
    (window as any).cancelAnimationFrame = caf;
    (globalThis as any).requestAnimationFrame = raf;
    (globalThis as any).cancelAnimationFrame = caf;
  });

  afterEach(() => {
    rafIds.splice(0).forEach((id) => window.clearTimeout(id));
  });

  const createContainer = () => {
    const container = document.createElement("div");
    Object.assign(container.style, {
      height: "240px",
      width: "320px",
      overflowY: "auto",
    });
    container.className = "systemsculpt-chat-container";

    const state: ContainerState = {
      scrollHeight: 480,
      scrollTop: 0,
    };
    containerState.set(container, state);

    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      get: () => 240,
    });

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => state.scrollHeight,
      set: (value: number) => {
        state.scrollHeight = value;
      },
    });

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => {
        state.scrollTop = value;
      },
    });

    document.body.appendChild(container);
    return container;
  };

  const addMessageBlock = (container: HTMLElement, text: string) => {
    const message = document.createElement("div");
    message.className = "systemsculpt-message";
    Object.assign(message.style, {
      padding: "8px",
      margin: "4px 0",
      minHeight: "120px",
    });
    message.textContent = text;
    container.appendChild(message);
    const state = containerState.get(container);
    if (state) {
      state.scrollHeight += 160;
    }
    return message;
  };

  test("appending a new message forces the view back to the bottom even after manual scroll", async () => {
    const container = createContainer();
    const scrollManager = new ScrollManagerService({ container });

    await settleProgrammaticScroll();

    for (let i = 0; i < 12; i++) addMessageBlock(container, `Message ${i}`);

    container.scrollTop = container.scrollHeight;

    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));

    expect(distanceFromBottom(container)).toBeGreaterThan(24);
    expect(scrollManager.isAutoScrollEnabled()).toBe(false);

    addMessageBlock(container, "Latest message");

    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(scrollManager.isAutoScrollEnabled()).toBe(true);
    expect(distanceFromBottom(container)).toBeLessThanOrEqual(1);

    scrollManager.destroy();
    container.remove();
  });

  test("streaming text updates keep the user anchored at the bottom", async () => {
    const container = createContainer();
    const scrollManager = new ScrollManagerService({ container });

    await settleProgrammaticScroll();

    for (let i = 0; i < 6; i++) addMessageBlock(container, `Message ${i}`);
    const streamingMessage = addMessageBlock(container, "Thinking");

    container.scrollTop = container.scrollHeight;

    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));

    expect(distanceFromBottom(container)).toBeGreaterThan(24);
    expect(scrollManager.isAutoScrollEnabled()).toBe(false);

    streamingMessage.textContent = "Thinking…";
    streamingMessage.textContent += " now responding";

    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(scrollManager.isAutoScrollEnabled()).toBe(true);
    expect(distanceFromBottom(container)).toBeLessThanOrEqual(1);

    scrollManager.destroy();
    container.remove();
  });
});
