/**
 * @jest-environment jsdom
 */

import { createHoverShell } from "../HoverShell";

describe("HoverShell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
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
});
