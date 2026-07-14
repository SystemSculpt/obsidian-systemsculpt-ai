/** @jest-environment jsdom */

import { App } from "obsidian";
import { RecorderAdvancedModal } from "../RecorderAdvancedModal";

const device = (deviceId: string, label: string): MediaDeviceInfo => ({
  deviceId,
  groupId: "group",
  kind: "audioinput",
  label,
  toJSON: () => ({ deviceId, groupId: "group", kind: "audioinput", label }),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const setMediaDevices = (owner: Navigator, mediaDevices: unknown): void => {
  Object.defineProperty(owner, "mediaDevices", {
    configurable: true,
    value: mediaDevices,
  });
};

const installObsidianDomHelpers = (ownerWindow: Window): void => {
  const source = HTMLElement.prototype as unknown as Record<string, unknown>;
  const target = (ownerWindow as any).HTMLElement.prototype;
  for (const name of [
    "setText", "setAttr", "setAttrs", "empty", "createEl", "createDiv",
    "createSpan", "appendText", "addClass", "removeClass", "toggleClass",
    "hasClass", "toggle", "setCssStyles", "setCssProps", "hide", "show",
  ]) {
    if (name in target || !(name in source)) continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name)!);
  }
};

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const createPlugin = (app: App) => ({
  app,
  settings: {
    preferredMicrophoneId: "default",
    autoTranscribeRecordings: false,
    autoPasteTranscription: false,
    cleanTranscriptionOutput: true,
    autoSubmitAfterTranscription: false,
    postProcessingEnabled: false,
  },
  getSettingsManager: jest.fn(() => ({
    updateSettings: jest.fn().mockResolvedValue(undefined),
  })),
  openSettingsTab: jest.fn(),
});

describe("RecorderAdvancedModal microphone discovery", () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const openModals: RecorderAdvancedModal[] = [];

  afterEach(() => {
    for (const modal of openModals.splice(0)) modal.close();
    document.body.empty();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    }
  });

  it("uses the mounted modal's owner realm instead of the main navigator", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const foreignWindow = frame.contentWindow!;
    installObsidianDomHelpers(foreignWindow);
    const foreignEnumerate = jest.fn().mockResolvedValue([
      device("popout", "Popout microphone"),
    ]);
    setMediaDevices(foreignWindow.navigator, {
      enumerateDevices: foreignEnumerate,
      getUserMedia: jest.fn(),
    });
    const mainEnumerate = jest.fn().mockRejectedValue(new Error("main realm used"));
    setMediaDevices(navigator, {
      enumerateDevices: mainEnumerate,
      getUserMedia: jest.fn(),
    });

    const app = new App();
    const modal = new RecorderAdvancedModal(app, createPlugin(app) as any);
    openModals.push(modal);
    foreignWindow.document.body.appendChild(modal.modalEl);
    modal.open();
    await flush();

    const options = Array.from(modal.modalEl.querySelectorAll("option"));
    expect(options.map((option) => option.textContent)).toContain("Popout microphone");
    expect(options[0]?.ownerDocument).toBe(foreignWindow.document);
    expect(foreignEnumerate).toHaveBeenCalledTimes(1);
    expect(mainEnumerate).not.toHaveBeenCalled();
  });

  it("renders the existing rejection copy without escaping the async scope", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockRejectedValue(new Error("device query failed")),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    const modal = new RecorderAdvancedModal(app, createPlugin(app) as any);
    openModals.push(modal);

    modal.open();
    await flush();

    expect(
      modal.modalEl.querySelector(".ss-recorder-advanced-modal__inline-note")?.textContent,
    ).toBe("Unable to load microphones: device query failed");
  });

  it("ignores a closed generation and renders only the reopened device request", async () => {
    const staleDevices = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = jest
      .fn()
      .mockImplementationOnce(() => staleDevices.promise)
      .mockResolvedValueOnce([device("fresh", "Fresh microphone")]);
    setMediaDevices(navigator, { enumerateDevices, getUserMedia: jest.fn() });
    const app = new App();
    const modal = new RecorderAdvancedModal(app, createPlugin(app) as any);
    openModals.push(modal);

    modal.open();
    modal.close();
    modal.open();
    await flush();

    expect(modal.modalEl.textContent).toContain("Fresh microphone");
    staleDevices.resolve([device("stale", "Stale microphone")]);
    await flush();

    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(modal.modalEl.textContent).toContain("Fresh microphone");
    expect(modal.modalEl.textContent).not.toContain("Stale microphone");
  });
});
