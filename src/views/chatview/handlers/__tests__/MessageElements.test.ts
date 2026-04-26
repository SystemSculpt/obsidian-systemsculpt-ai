/**
 * @jest-environment jsdom
 */

import {
  getStatusIndicator,
  showStreamingStatus,
  updateStreamingStatus,
} from "../MessageElements";

describe("MessageElements streaming status", () => {
  it("reattaches the existing status indicator after message content is re-rendered", () => {
    const messageEl = document.createElement("div");
    const liveRegionEl = document.createElement("div");

    showStreamingStatus(messageEl, liveRegionEl);
    const indicator = getStatusIndicator(messageEl);
    expect(indicator).toBeTruthy();
    expect(indicator?.parentElement).toBe(messageEl);

    messageEl.innerHTML = "";
    expect(indicator?.parentElement).toBeNull();

    showStreamingStatus(messageEl, liveRegionEl);
    expect(getStatusIndicator(messageEl)).toBe(indicator);
    expect(indicator?.parentElement).toBe(messageEl);

    updateStreamingStatus(messageEl, liveRegionEl, "retrying", "Retrying response\u2026", {
      elapsedMs: 1250,
      elapsedFormatted: "0:01",
      status: "retrying",
      statusLabel: "Retrying response\u2026",
    });

    expect(indicator?.getAttribute("data-status")).toBe("retrying");
    expect(indicator?.textContent).toContain("Retrying response\u2026");
    expect(indicator?.textContent).toContain("0:01");
    expect(liveRegionEl.textContent).toBe("Retrying response\u2026");
  });
});
