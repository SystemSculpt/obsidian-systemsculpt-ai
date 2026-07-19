/**
 * @jest-environment jsdom
 */

import { createHoverShell } from "../HoverShell";
import { disposeMobileHostLayoutStates } from "../../platform/mobileHostLayout";

describe("HoverShell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.classList.remove("is-mobile");
    localStorage.clear();
  });

  afterEach(() => {
    disposeMobileHostLayoutStates();
  });

  it("renders actions and triggers callbacks", () => {
    const onStop = jest.fn();
    const shell = createHoverShell({
      title: "Recorder",
      showStatusRow: true,
    });

    shell.setFooterActions([
      {
        id: "stop",
        label: "Stop",
        variant: "primary",
        onClick: onStop,
      },
    ]);

    const button = shell.footerActionsEl.querySelector("button[data-action-id='stop']") as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("updates subtitle visibility and state", () => {
    const shell = createHoverShell({
      title: "Recorder",
      subtitle: "",
    });

    expect(shell.subtitleEl.hasAttribute("hidden")).toBe(true);
    shell.setSubtitle("Recording");
    expect(shell.subtitleEl.textContent).toBe("Recording");
    expect(shell.subtitleEl.hasAttribute("hidden")).toBe(false);

    shell.setState("recording");
    expect(shell.root.dataset.state).toBe("recording");
    expect(shell.root.getAttribute("data-ss-surface")).toBe("transient");
  });

  it("announces the labeled transient region and changing status", () => {
    const shell = createHoverShell({
      title: "Recorder",
      statusText: "Ready",
      showStatusRow: true,
    });

    expect(shell.root.getAttribute("role")).toBe("region");
    expect(shell.root.getAttribute("aria-labelledby")).toBe(shell.titleEl.id);
    expect(shell.titleEl.id).toMatch(/^ss-hover-shell-title-/);
    expect(shell.statusEl.getAttribute("role")).toBe("status");
    expect(shell.statusEl.getAttribute("aria-live")).toBe("polite");
    expect(shell.statusEl.getAttribute("aria-atomic")).toBe("true");
  });

  it("uses the supplied host document and compact layout", () => {
    Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });
    const host = document.createElement("section");
    document.body.appendChild(host);

    const shell = createHoverShell({ title: "Recorder", host });
    window.dispatchEvent(new Event("resize"));

    expect(host.contains(shell.root)).toBe(true);
    expect(shell.root.dataset.layout).toBe("compact");
    expect(shell.root.style.left).toBe("12px");
  });

  it("clears native navigation and horizontal safe areas in mobile compact layout", () => {
    Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });
    document.body.classList.add("is-mobile");

    const shell = createHoverShell({ title: "Recorder" });
    window.dispatchEvent(new Event("resize"));

    expect(shell.root.dataset.layout).toBe("compact");
    expect(document.body.classList.contains("ss-mobile-layout")).toBe(true);
    expect(shell.root.style.bottom).toBe("var(--ss-mobile-bottom-clearance)");
    expect(shell.root.style.left).toContain("safe-area-inset-left");
    expect(shell.root.style.right).toContain("safe-area-inset-right");
  });

  it("keeps the recorder docked on tablet-width mobile hosts", () => {
    Object.defineProperty(window, "innerWidth", { value: 768, configurable: true });
    document.body.classList.add("is-mobile");

    const shell = createHoverShell({ title: "Recorder" });
    window.dispatchEvent(new Event("resize"));

    expect(shell.root.dataset.layout).toBe("compact");
    expect(shell.root.style.bottom).toBe("var(--ss-mobile-bottom-clearance)");
    expect(shell.root.style.left).toContain("safe-area-inset-left");
    expect(shell.root.style.right).toContain("safe-area-inset-right");
  });

  it("reserves mobile stack space so progress panels cannot cover recorder controls", () => {
    Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });
    document.body.classList.add("is-mobile");

    const shell = createHoverShell({
      title: "Recorder",
      className: "ss-recorder-hover",
    });
    jest.spyOn(shell.root, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 400,
      bottom: 132,
      left: 0,
      width: 400,
      height: 132,
      toJSON: () => ({}),
    });

    window.dispatchEvent(new Event("resize"));
    expect(document.body.style.getPropertyValue("--ss-recorder-mobile-stack-offset"))
      .toBe("calc(132px + var(--ss-space-2))");

    shell.destroy();
    expect(document.body.style.getPropertyValue("--ss-recorder-mobile-stack-offset")).toBe("");
  });
});
