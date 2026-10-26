/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { AudioSourcePicker, type AudioSourcePickerOptions } from "../AudioSourcePicker";

const audioFile = (path: string, mtime: number, size = 1_000): TFile => new (TFile as any)({
  path,
  name: path.split("/").pop(),
  extension: path.split(".").pop(),
  stat: { size, mtime, ctime: mtime },
}) as TFile;

function mountPicker(files: TFile[], overrides: Partial<AudioSourcePickerOptions> = {}) {
  const app = new App();
  (app.vault as any).getResourcePath = jest.fn((file: TFile) => `app://${file.path}`);
  const onChange = jest.fn();
  const container = document.body.createDiv();
  const picker = new AudioSourcePicker(container, {
    app,
    listFiles: () => files,
    acceptDeviceFile: () => true,
    deviceHint: "Drop a file here.",
    onChange,
    ...overrides,
  });
  const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".ss-audio-source__file"));
  return { app, container, picker, onChange, rows };
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function drop(target: HTMLElement, files: File[]): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  target.dispatchEvent(event);
}

describe("AudioSourcePicker", () => {
  let createObjectUrl: jest.Mock;
  let revokeObjectUrl: jest.Mock;

  beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    createObjectUrl = jest.fn(() => "blob:audio-preview");
    revokeObjectUrl = jest.fn();
    Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
  });

  afterEach(() => {
    document.body.empty();
    jest.restoreAllMocks();
  });

  it("moves selection with arrow, Home and End keys through one delegated listener and one tab stop", () => {
    const files = [
      audioFile("Meetings/oldest.m4a", 1),
      audioFile("Meetings/newest.m4a", 4),
      audioFile("Notes/draft.md", 5),
      audioFile("Lectures/week-6.mp3", 3),
      audioFile("Podcasts/raw.wav", 2),
    ];
    const addListener = jest.spyOn(HTMLElement.prototype, "addEventListener");
    const { picker, onChange, rows } = mountPicker(files);

    // Newest first, audio only; nothing is chosen until the user acts.
    expect(rows().map((row) => row.dataset.path)).toEqual([
      "Meetings/newest.m4a",
      "Lectures/week-6.mp3",
      "Podcasts/raw.wav",
      "Meetings/oldest.m4a",
    ]);
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(picker.selection).toBeNull();

    rows()[0].focus();
    expect(press(rows()[0], "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    expect(rows()[1].classList.contains("is-selected")).toBe(true);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "vault", file: files[3] });
    expect(document.querySelector<HTMLAudioElement>(".ss-audio-source__preview")?.src)
      .toBe("app://Lectures/week-6.mp3");

    press(rows()[1], "End");
    expect(document.activeElement).toBe(rows()[3]);
    expect(picker.selection).toEqual({ kind: "vault", file: files[0] });

    press(rows()[3], "ArrowDown");
    expect(document.activeElement).toBe(rows()[3]);

    press(rows()[3], "Home");
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().filter((row) => row.getAttribute("aria-selected") === "true"))
      .toEqual([rows()[0]]);

    // At the top edge the key is consumed without a new selection.
    onChange.mockClear();
    expect(press(rows()[0], "ArrowUp").defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(press(rows()[0], "a").defaultPrevented).toBe(false);

    // Searching rebuilds the rows; none of them ever gets its own listener.
    const search = document.querySelector<HTMLInputElement>('.ss-search-field input[type="search"]')!;
    search.value = "week";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows().map((row) => row.dataset.path)).toEqual(["Lectures/week-6.mp3"]);
    const rowListeners = addListener.mock.contexts.filter((element) =>
      (element as HTMLElement).classList?.contains("ss-audio-source__file"));
    expect(rowListeners).toHaveLength(0);
    const list = document.querySelector(".ss-audio-source__list");
    expect(addListener.mock.contexts.filter((element) => element === list)).toHaveLength(2);
  });

  it("bounds the vault list and explains an empty vault", () => {
    const many = Array.from({ length: 60 }, (_, index) => audioFile(`Audio/clip-${index}.mp3`, index));
    const { container, rows } = mountPicker(many);
    expect(rows()).toHaveLength(50);
    expect(container.textContent).toContain("Showing 50 of 60. Search to narrow the list.");

    const empty = mountPicker([]);
    expect(empty.container.textContent).toContain("No audio in this vault");
    expect(empty.container.textContent).toContain("Use the Device tab to choose a file.");
  });

  it("previews a device file and releases its object URL when the selection changes or the picker closes", async () => {
    const files = [audioFile("Meetings/sync.m4a", 1)];
    const { container, picker, onChange, rows } = mountPicker(files);
    const input = container.querySelector<HTMLInputElement>(".ss-audio-source__file-input")!;
    const label = container.querySelector<HTMLLabelElement>(".ss-audio-source__choose-file")!;
    expect(input.accept).toBe(".mp3,.wav,.m4a,.mp4,.ogg,.webm,.flac");
    expect(label.htmlFor).toBe(input.id);
    expect(container.textContent).toContain("MP3 · WAV · M4A · MP4 · OGG · WEBM · FLAC");

    const voice = new File(["voice"], "voice.webm", { type: "audio/webm" });
    Object.defineProperty(input, "files", { configurable: true, value: [voice] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(picker.selection).toEqual({ kind: "device", file: voice });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "device", file: voice });
    expect(container.querySelector(".ss-audio-source__selection-path")?.textContent)
      .toContain("From this device");
    expect(container.querySelector<HTMLAudioElement>(".ss-audio-source__preview")?.src)
      .toBe("blob:audio-preview");

    rows()[0].click();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(picker.selection?.kind).toBe("vault");

    await picker.selectDeviceFile(voice);
    picker.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);

    onChange.mockClear();
    rows()[0]?.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets a vault choice win over a device file still being checked", async () => {
    let finishCheck!: (accepted: boolean) => void;
    const files = [audioFile("Meetings/sync.m4a", 1)];
    const { picker, rows } = mountPicker(files, {
      acceptDeviceFile: () => new Promise<boolean>((resolve) => { finishCheck = resolve; }),
    });

    const pending = picker.selectDeviceFile(new File(["x"], "late.mp3", { type: "audio/mpeg" }));
    rows()[0].click();
    finishCheck(true);

    await expect(pending).resolves.toBe(false);
    expect(picker.selection).toEqual({ kind: "vault", file: files[0] });
  });

  it("takes the first audio file from a drop and names the formats when none is audio", () => {
    const notice = jest.spyOn(console, "log").mockImplementation(() => {});
    const { container, picker } = mountPicker([]);
    const dropzone = container.querySelector<HTMLElement>(".ss-audio-source__dropzone")!;
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    const memo = new File(["memo"], "memo.m4a", { type: "audio/mp4" });

    drop(dropzone, [text, memo]);
    expect(picker.selection).toEqual({ kind: "device", file: memo });

    drop(dropzone, [text]);
    expect(picker.selection).toEqual({ kind: "device", file: memo });
    expect(notice).toHaveBeenCalledWith(
      "Notice: Choose an MP3, WAV, M4A, MP4, OGG, WebM, or FLAC audio file.",
    );
  });

  it("shows only the device dropzone where vault audio cannot be used", () => {
    const listFiles = jest.fn(() => [audioFile("Meetings/sync.m4a", 1)]);
    const { container, rows } = mountPicker([], { listFiles, vaultAvailable: false });

    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(rows()).toHaveLength(0);
    expect(listFiles).not.toHaveBeenCalled();
    expect(container.querySelector(".ss-audio-source__dropzone")).toBeTruthy();
    expect(container.textContent).toContain("No audio selected.");
  });
});
