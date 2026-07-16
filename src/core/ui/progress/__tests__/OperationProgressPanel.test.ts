/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { OperationProgressPanel } from "../OperationProgressPanel";

describe("OperationProgressPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders steps and updates their state deterministically", () => {
    const panel = new OperationProgressPanel({
      title: "Test operation",
      icon: "loader",
      steps: [
        { id: "queued", label: "Queued" },
        { id: "running", label: "Running" },
        { id: "done", label: "Done" },
      ],
    });

    panel.setStatus({
      label: "Running",
      icon: "loader",
      progress: 40,
      state: "running",
    });
    panel.setTimelineState("running", "running");

    const progress = document.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-valuenow")).toBe("40");
    expect(document.querySelector(".systemsculpt-progress-panel")?.getAttribute("role"))
      .toBe("region");

    const steps = [...document.querySelectorAll(".systemsculpt-progress-step")];
    expect(steps[0].classList.contains("is-complete")).toBe(true);
    expect(steps[1].classList.contains("is-active")).toBe(true);
    expect(steps[2].classList.contains("is-complete")).toBe(false);

    panel.setTimelineState("done", "complete");

    steps.forEach((step) => {
      expect(step.classList.contains("is-complete")).toBe(true);
    });
  });

  it("fires dismiss callback and detaches itself", () => {
    const onDismiss = jest.fn();
    const panel = new OperationProgressPanel({
      title: "Dismissable",
      icon: "loader",
      onDismiss,
    });

    const dismissButton = document.querySelector(".systemsculpt-progress-dismiss") as HTMLButtonElement;
    dismissButton.click();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();

    panel.close();
  });

  it("mounts in the supplied document host as a transient surface", () => {
    const host = document.createElement("section");
    document.body.appendChild(host);

    new OperationProgressPanel({
      title: "Hosted",
      icon: "loader",
      host,
    });

    const root = host.querySelector(".systemsculpt-progress-panel");
    expect(root?.getAttribute("data-ss-surface")).toBe("transient");
  });

  it("owns collapsible chrome and dynamic item state for feature adapters", () => {
    const panel = new OperationProgressPanel({
      title: "Batch",
      icon: "loader",
      collapsible: true,
    });
    panel.setItems([
      { id: "first", label: "First.md", icon: "file" },
      { id: "second", label: "Second.md", icon: "file" },
    ]);
    panel.setItemState("first", "complete");
    panel.setItemState("second", "error", "Failed to process");

    const items = [...document.querySelectorAll(".systemsculpt-progress-item")];
    expect(items[0].classList.contains("is-complete")).toBe(true);
    expect(items[1].classList.contains("is-error")).toBe(true);
    expect(items[1].getAttribute("title")).toBe("Failed to process");

    const toggle = document.querySelector(".systemsculpt-progress-dismiss") as HTMLButtonElement;
    toggle.click();
    expect(document.querySelector(".systemsculpt-progress-panel")?.classList.contains("is-collapsed"))
      .toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand");
  });

  it("keeps the fixed mobile panel above native navigation and inside safe areas", () => {
    const css = readFileSync("src/css/modals/progress-toast.css", "utf8");

    expect(css).toMatch(
      /\.ss-mobile-layout \.systemsculpt-progress-panel\s*\{[^}]*bottom:\s*var\(--ss-mobile-bottom-clearance\);/s,
    );
    expect(css).toMatch(/env\(safe-area-inset-left,\s*0px\)/);
    expect(css).toMatch(/env\(safe-area-inset-right,\s*0px\)/);
  });
});
