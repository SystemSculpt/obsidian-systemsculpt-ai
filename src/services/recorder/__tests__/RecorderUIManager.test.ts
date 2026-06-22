/**
 * @jest-environment jsdom
 */

jest.mock("../../../modals/RecorderAdvancedModal", () => ({
  openRecorderAdvancedModal: jest.fn(),
}));

import { RecorderUIManager } from "../RecorderUIManager";

const stopButtons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll("button[data-action-id='stop']")) as HTMLButtonElement[];

// The most recently rendered Stop button. open() leaves the previous shell in
// the DOM for a short teardown delay, so the newest button is always last.
const latestStopButton = (): HTMLButtonElement => {
  const buttons = stopButtons();
  return buttons[buttons.length - 1];
};

const createManager = (variant: "mobile" | "desktop" = "mobile"): RecorderUIManager =>
  new RecorderUIManager({
    app: {} as any,
    plugin: {} as any,
    platform: { uiVariant: () => variant } as any,
  });

describe("RecorderUIManager one-tap stop (#148)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("ends the recording on a single tap of Stop", () => {
    const onStop = jest.fn();
    const ui = createManager();
    ui.open(onStop);

    const button = latestStopButton();
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);

    button.click();

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated taps so 5 mashed taps still trigger exactly one stop (#148)", () => {
    const onStop = jest.fn();
    const ui = createManager();
    ui.open(onStop);

    // The reported bug: the first tap looked like it did nothing, so the user
    // tapped Stop five times. Hold the original (enabled) button reference to
    // mimic taps that land before the UI repaints the button as disabled — the
    // exact race seen on the Android webview in #148. Each tap must be a no-op
    // after the first, which relies on the idempotency guard, not just the
    // disabled attribute.
    const button = latestStopButton();
    for (let i = 0; i < 5; i++) {
      button.click();
    }

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables and relabels Stop after the first tap", () => {
    const onStop = jest.fn();
    const ui = createManager();
    ui.open(onStop);

    latestStopButton().click();

    const button = latestStopButton();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Stopping");
  });

  it("resets to one-tap stop for the next recording", () => {
    const ui = createManager();

    const firstStop = jest.fn();
    ui.open(firstStop);
    latestStopButton().click();
    expect(firstStop).toHaveBeenCalledTimes(1);

    const secondStop = jest.fn();
    ui.open(secondStop);

    const button = latestStopButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Stop");

    button.click();

    expect(secondStop).toHaveBeenCalledTimes(1);
    expect(firstStop).toHaveBeenCalledTimes(1);
  });

  it("wires one-tap stop the same way on desktop", () => {
    const onStop = jest.fn();
    const ui = createManager("desktop");
    ui.open(onStop);

    const button = latestStopButton();
    button.click();
    button.click();

    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
