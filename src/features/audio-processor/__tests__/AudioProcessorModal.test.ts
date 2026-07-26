/** @jest-environment jsdom */

import { App, Platform, TFile } from "obsidian";
import { AudioProcessorModal } from "../AudioProcessorModal";

const audioFile = (
  path: string,
  size: number,
  mtime: number,
): TFile => new (TFile as any)({
  path,
  name: path.split("/").pop(),
  extension: path.split(".").pop(),
  stat: { size, mtime, ctime: mtime },
}) as TFile;

function createPlugin(
  files: TFile[] = [],
  settings: Record<string, unknown> = {},
) {
  const app = new App();
  (app.vault.getFiles as jest.Mock).mockReturnValue(files);
  (app.vault as any).getResourcePath = jest.fn((file: TFile) => `app://${file.path}`);
  (app.vault as any).adapter = {
    getFullPath: jest.fn((path: string) => `/vault/${path}`),
  };
  return {
    app,
    manifest: { version: "6.1.0" },
    settings: {
      licenseKey: "license",
      audioProcessorOutputPreset: "detailed",
      ...settings,
    },
    vaultFileCache: null,
    directoryManager: { ensureDirectoryByPath: jest.fn() },
    register: jest.fn(),
  } as any;
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

describe("AudioProcessorModal", () => {
  let pauseSpy: jest.SpyInstance;
  let loadSpy: jest.SpyInstance;

  beforeEach(() => {
    pauseSpy = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    loadSpy = jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    pauseSpy.mockRestore();
    loadSpy.mockRestore();
    document.body.empty();
    jest.restoreAllMocks();
  });

  it("opens directly to the YouTube source with strict URL validation and output presets", () => {
    const modal = new AudioProcessorModal(createPlugin(), { initialTab: "youtube" });
    document.body.appendChild(modal.modalEl);
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Audio Processor");
    const sourceTabs = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      ".ss-audio-processor__tab[role='tab']",
    );
    expect(sourceTabs).toHaveLength(2);
    expect(sourceTabs[1].getAttribute("aria-selected")).toBe("true");
    expect(modal.modalEl.textContent).toContain("Detailed note");
    expect(modal.modalEl.textContent).toContain("Meeting brief");
    expect(modal.modalEl.textContent).toContain("Clean transcript");
    expect(buttonWithText(modal.modalEl, "Meeting brief").textContent)
      .toContain("plus a linked transcript");
    expect(buttonWithText(modal.modalEl, "Clean transcript").textContent)
      .toContain("without timestamps in the main note");
    expect(modal.modalEl.querySelectorAll(
      ".ss-audio-processor__output-option[role='radio']",
    )).toHaveLength(3);
    expect(modal.modalEl.querySelector(
      ".ss-audio-processor__output-option[aria-checked='true']",
    )?.textContent).toContain("Detailed note");
    expect(modal.modalEl.textContent).not.toMatch(/model|template/i);

    const input = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-audio-processor__youtube-input",
    )!;
    const process = buttonWithText(modal.modalEl, "Process video");
    expect(process.disabled).toBe(true);

    input.value = "https://notyoutube.com/watch?v=dQw4w9WgXcQ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(process.disabled).toBe(true);
    expect(modal.modalEl.textContent).toContain("Enter a valid YouTube video URL");

    input.value = "https://youtu.be/dQw4w9WgXcQ?si=share";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(process.disabled).toBe(false);
    expect(modal.modalEl.textContent).toContain("YouTube video ready");
  });

  it("shares one preset selector across Audio and YouTube and passes the one-job choice", async () => {
    const process = jest.fn(() => new Promise(() => undefined));
    const modal = new AudioProcessorModal(
      createPlugin([], { audioProcessorOutputPreset: "meeting_brief" }),
      {
        initialTab: "youtube",
        createService: () => ({ process }) as any,
      },
    );
    document.body.appendChild(modal.modalEl);
    modal.onOpen();

    const selected = () => modal.modalEl.querySelector<HTMLButtonElement>(
      ".ss-audio-processor__output-option[aria-checked='true']",
    );
    expect(selected()?.textContent).toContain("Meeting brief");

    buttonWithText(modal.modalEl, "Audio").click();
    expect(selected()?.textContent).toContain("Meeting brief");
    buttonWithText(modal.modalEl, "YouTube").click();

    buttonWithText(modal.modalEl, "Clean transcript").click();
    expect(selected()?.textContent).toContain("Clean transcript");

    const input = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-audio-processor__youtube-input",
    )!;
    input.value = "https://youtu.be/dQw4w9WgXcQ?si=share";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    buttonWithText(modal.modalEl, "Process video").click();

    expect(process).toHaveBeenCalledWith(
      {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      expect.objectContaining({
        outputPreset: "clean_transcript",
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
  });

  it("uses bounded, searchable, keyboard-selectable vault audio and a native device picker", () => {
    const files = Array.from({ length: 60 }, (_, index) =>
      audioFile(`Meetings/session-${index}.m4a`, 1_000 + index, index),
    );
    const modal = new AudioProcessorModal(createPlugin(files));
    document.body.appendChild(modal.modalEl);
    modal.onOpen();

    const options = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      ".ss-audio-processor__audio-file[role='option']",
    );
    expect(options).toHaveLength(50);
    expect(modal.modalEl.textContent).toContain("Showing 50 of 60");

    options[0].focus();
    options[0].dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    }));
    const selected = modal.modalEl.querySelector<HTMLButtonElement>(
      ".ss-audio-processor__audio-file[aria-selected='true']",
    );
    expect(selected).toBeTruthy();
    expect(document.activeElement).toBe(selected);
    expect(buttonWithText(modal.modalEl, "Process audio").disabled).toBe(false);

    const search = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-search-field input[type='search']",
    )!;
    search.value = "session-7.m4a";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(modal.modalEl.querySelectorAll(".ss-audio-processor__audio-file")).toHaveLength(1);

    buttonWithText(modal.modalEl, "Device").click();
    const input = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-audio-processor__file-input",
    )!;
    const label = modal.modalEl.querySelector<HTMLLabelElement>(
      ".ss-audio-processor__choose-file",
    )!;
    expect(input.type).toBe("file");
    expect(input.accept).toContain(".flac");
    expect(label.htmlFor).toBe(input.id);
    expect(modal.modalEl.textContent).toContain("up to 1 GB");

    const deviceFile = new File(["audio bytes"], "device-recording.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [deviceFile],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(modal.modalEl.querySelector(
      ".ss-audio-processor__selection-name",
    )?.textContent).toBe("device-recording.mp3");
    expect(buttonWithText(modal.modalEl, "Process audio").disabled).toBe(false);
  });

  it("fails closed instead of dereferencing an incomplete audio selection", () => {
    const modal = new AudioProcessorModal(createPlugin([
      undefined as unknown as TFile,
      audioFile("Meetings/valid.m4a", 2_000, 1),
    ]));
    document.body.appendChild(modal.modalEl);

    expect(() => modal.onOpen()).not.toThrow();
    expect(() => (modal as any).selectAudio({
      kind: "device",
      file: undefined,
    })).not.toThrow();

    expect(modal.modalEl.textContent).toContain("No audio selected.");
    expect(modal.modalEl.querySelector(".ss-audio-processor__audio-preview")).toBeNull();
    expect(buttonWithText(modal.modalEl, "Process audio").disabled).toBe(true);
  });

  it("uses only the bounded device picker when vault range reads are unavailable", () => {
    const previousDesktopApp = Platform.isDesktopApp;
    (Platform as unknown as { isDesktopApp: boolean }).isDesktopApp = false;
    try {
      const modal = new AudioProcessorModal(createPlugin([
        audioFile("Meetings/mobile.m4a", 2_000, 1),
      ]));
      document.body.appendChild(modal.modalEl);
      modal.onOpen();

      expect(modal.modalEl.querySelector(".ss-audio-processor__audio-file")).toBeNull();
      expect(Array.from(modal.modalEl.querySelectorAll("button"))
        .some((button) => button.textContent === "Vault")).toBe(false);
      expect(modal.modalEl.textContent).toContain("Large files upload in small parts");
      expect(modal.modalEl.querySelector<HTMLInputElement>(
        ".ss-audio-processor__file-input",
      )).toBeTruthy();
    } finally {
      (Platform as unknown as { isDesktopApp: boolean }).isDesktopApp = previousDesktopApp;
    }
  });
});
