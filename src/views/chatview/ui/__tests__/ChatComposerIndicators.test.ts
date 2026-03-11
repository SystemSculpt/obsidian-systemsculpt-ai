/** @jest-environment jsdom */

import { renderChatCreditsIndicator } from "../ChatComposerIndicators";

describe("renderChatCreditsIndicator", () => {
  it("describes the remaining credits state without any model or prompt affordances", () => {
    const target = document.createElement("div");

    const rendered = renderChatCreditsIndicator(target, {
      balance: {
        totalRemaining: 1234,
        includedRemaining: 1000,
        includedPerMonth: 2000,
        addOnRemaining: 234,
        cycleEndsAt: "2026-03-01T00:00:00.000Z",
      },
    });

    expect(rendered.isLoading).toBe(false);
    expect(rendered.isLow).toBe(false);
    expect(target.querySelector(".systemsculpt-model-indicator-arrow")).toBeNull();
    expect(target.textContent).toBe("");
    expect(rendered.title).toContain("Credits remaining:");
  });
});
