/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { AutomationRunnerModal } from "../AutomationRunnerModal";

describe("AutomationRunnerModal", () => {
  afterEach(() => document.body.empty());

  it("adapts Obsidian's native suggestion modal to the canonical modal surface", () => {
    const modal = new AutomationRunnerModal(
      new App(),
      {} as any,
      new TFile({ path: "Projects/Brief.md" } as any),
      [],
    );

    modal.open();

    expect(modal.modalEl.matches('.ss-surface[data-ss-surface="modal"]')).toBe(true);
    expect(modal.modalEl.classList.contains("ss-automation-runner-modal")).toBe(true);
  });
});
