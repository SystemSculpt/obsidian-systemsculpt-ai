/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { beginTextSettings } from "../TextSettings";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Notice: jest.fn(),
}));

const typeValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input"));
};

describe("Settings text commit lifecycle", () => {
  let tab: SystemSculptSettingTab;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    tab = new SystemSculptSettingTab(new App(), {} as never);
  });

  afterEach(() => {
    tab.hide();
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
    document.body.innerHTML = "";
  });

  it("uses the input's owner window for scheduling and clearing the debounce", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerWindow = frame.contentWindow!;
    const setTimer = jest.spyOn(ownerWindow, "setTimeout").mockImplementation((handler, delay) =>
      window.setTimeout(handler, delay),
    );
    const clearTimer = jest.spyOn(ownerWindow, "clearTimeout").mockImplementation((timer) =>
      window.clearTimeout(timer),
    );
    const input = ownerWindow.document.createElement("input");
    const save = jest.fn().mockResolvedValue(undefined);
    beginTextSettings(frame, tab)(input, save);

    typeValue(input, "draft");
    typeValue(input, "final");
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    tab.hide();
    expect(save.mock.calls).toEqual([["final"]]);
    expect(clearTimer).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("flushes a newer edit on settings hide even while an earlier save is pending", async () => {
    const input = document.createElement("input");
    let finishFirstSave!: () => void;
    const save = jest.fn().mockResolvedValue(undefined).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finishFirstSave = resolve; }),
    );
    beginTextSettings(tab.containerEl, tab)(input, save);

    typeValue(input, "first");
    jest.advanceTimersByTime(300);
    typeValue(input, "final");
    tab.hide();
    tab.hide();
    typeValue(input, "detached");

    expect(save.mock.calls).toEqual([["first"], ["final"]]);
    expect(jest.getTimerCount()).toBe(0);
    finishFirstSave();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale failure when a newer save has committed the same value again", async () => {
    const input = document.createElement("input");
    let rejectFirstSave!: (error: Error) => void;
    const save = jest.fn().mockResolvedValue(undefined).mockImplementationOnce(() =>
      new Promise<void>((_resolve, reject) => { rejectFirstSave = reject; }),
    );
    const commit = beginTextSettings(tab.containerEl, tab)(input, save);

    typeValue(input, "first");
    commit();
    typeValue(input, "second");
    commit();
    typeValue(input, "first");
    commit();
    await Promise.resolve();
    rejectFirstSave(new Error("Stale failure"));
    await Promise.resolve();
    input.dispatchEvent(new Event("blur"));

    expect(save.mock.calls).toEqual([["first"], ["second"], ["first"]]);
    expect(Notice).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not treat an earlier failed attempt as committed when a later attempt also fails", async () => {
    const input = document.createElement("input");
    let rejectFirstSave!: (error: Error) => void;
    let rejectSecondSave!: (error: Error) => void;
    const save = jest.fn().mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirstSave = reject; }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSecondSave = reject; }));
    const commit = beginTextSettings(tab.containerEl, tab)(input, save);

    typeValue(input, "first");
    commit();
    typeValue(input, "second");
    commit();
    rejectFirstSave(new Error("First failure"));
    await Promise.resolve();
    rejectSecondSave(new Error("Second failure"));
    await Promise.resolve();
    typeValue(input, "first");
    input.dispatchEvent(new Event("blur"));

    expect(save.mock.calls).toEqual([["first"], ["second"], ["first"]]);
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps the newest failed edit retryable after an older save completes", async () => {
    const input = document.createElement("input");
    let finishFirstSave!: () => void;
    const save = jest.fn().mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstSave = resolve; }))
      .mockRejectedValueOnce(new Error("Latest failure"));
    const commit = beginTextSettings(tab.containerEl, tab)(input, save);

    typeValue(input, "first");
    commit();
    typeValue(input, "final");
    commit();
    await Promise.resolve();
    finishFirstSave();
    await Promise.resolve();
    input.dispatchEvent(new Event("blur"));

    expect(save.mock.calls).toEqual([["first"], ["final"], ["final"]]);
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("reports a failed save and permits committing the same edit again on blur", async () => {
    const input = document.createElement("input");
    const save = jest.fn().mockResolvedValue(undefined).mockRejectedValueOnce(new Error("Disk unavailable"));
    beginTextSettings(tab.containerEl, tab)(input, save);

    typeValue(input, "keep-me");
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(Notice).toHaveBeenCalledWith("Couldn’t save that setting.");

    input.dispatchEvent(new Event("blur"));
    expect(save.mock.calls).toEqual([["keep-me"], ["keep-me"]]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
