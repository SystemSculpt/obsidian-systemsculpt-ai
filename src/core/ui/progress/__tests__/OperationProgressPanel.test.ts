/**
 * @jest-environment jsdom
 */
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

    const steps = [...document.querySelectorAll(".systemsculpt-progress-step")];
    expect(steps[0].classList.contains("completed")).toBe(true);
    expect(steps[1].classList.contains("active")).toBe(true);
    expect(steps[2].classList.contains("completed")).toBe(false);

    panel.setTimelineState("done", "complete");

    steps.forEach((step) => {
      expect(step.classList.contains("completed")).toBe(true);
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
});
