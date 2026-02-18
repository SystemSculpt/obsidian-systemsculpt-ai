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
      layout: "desktop",
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
      layout: "desktop",
    });

    expect(shell.subtitleEl.hasAttribute("hidden")).toBe(true);
    shell.setSubtitle("Recording");
    expect(shell.subtitleEl.textContent).toBe("Recording");
    expect(shell.subtitleEl.hasAttribute("hidden")).toBe(false);

    shell.setState("recording");
    expect(shell.root.dataset.state).toBe("recording");
  });
});

