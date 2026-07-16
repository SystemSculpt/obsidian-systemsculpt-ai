/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayRecorderTabContent } from "../settings/RecorderTabContent";

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

const createPlugin = (app: App) => {
  const updateSettings = jest.fn().mockResolvedValue(undefined);
  return {
    plugin: {
      app,
      settings: {
        autoTranscribeRecordings: false,
        autoPasteTranscription: false,
        keepRecordingsAfterTranscription: true,
        cleanTranscriptionOutput: true,
        autoSubmitAfterTranscription: false,
        postProcessingEnabled: false,
        postProcessingPrompt: "Clean it up",
        transcriptionOutputFormat: "markdown",
        showTranscriptionFormatChooserInModal: true,
        enableAutoAudioResampling: true,
        preferredMicrophoneId: "default",
      },
      getSettingsManager: jest.fn(() => ({ updateSettings })),
    },
    updateSettings,
  };
};

const createTabHarness = (app: App, plugin: unknown) => {
  const cleanups = new Set<() => void>();
  const tab = {
    app,
    plugin,
    registerRenderCleanup: jest.fn((cleanup: () => void) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    }),
  };
  return {
    tab,
    cleanup: () => {
      const pending = [...cleanups];
      cleanups.clear();
      pending.forEach((cleanup) => cleanup());
    },
  };
};

describe("Recorder settings tab", () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

  afterEach(() => {
    document.body.empty();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    }
  });

  it("offers local recorder/output controls without provider, endpoint, key, or model configuration", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([]),
      getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }),
    });
    const app = new App();
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    const names = [...container.querySelectorAll(".setting-item-name")].map((element) => element.textContent?.trim());
    expect(names).toContain("Auto-transcribe recordings");
    expect(names).toContain("Default transcription output format");
    expect(names).toContain("Automatic audio format conversion");
    expect(names).not.toContain("Transcription provider");
    expect(names).not.toContain("Custom endpoint URL");
    expect(names).not.toContain("API key");
    expect(names).not.toContain("Model name");
    expect(names).not.toContain("Post-processing model");
  });

  it("does not request microphone permission until the user refreshes devices", async () => {
    const getUserMedia = jest.fn().mockResolvedValue({
      getTracks: () => [{ stop: jest.fn() }],
    });
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([device("hidden", "")]),
      getUserMedia,
    });
    const app = new App();
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);
    expect(getUserMedia).not.toHaveBeenCalled();

    const refreshButton = container.querySelector(
      '.extra-button[aria-label="Refresh microphones"]',
    ) as HTMLButtonElement | null;
    expect(refreshButton).not.toBeNull();
    refreshButton?.click();
    await flush();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("uses the settings surface owner realm and preserves microphone persistence", async () => {
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
    const { plugin, updateSettings } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = foreignWindow.document.body.createDiv();

    await displayRecorderTabContent(container, tab as any);

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toContain("Popout microphone");
    expect(select.ownerDocument).toBe(foreignWindow.document);
    expect(foreignEnumerate).toHaveBeenCalledTimes(1);
    expect(mainEnumerate).not.toHaveBeenCalled();

    select.value = "popout";
    select.dispatchEvent(new foreignWindow.Event("change"));
    await flush();
    expect(updateSettings).toHaveBeenCalledWith({ preferredMicrophoneId: "popout" });
  });

  it("renders the existing enumeration rejection copy", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockRejectedValue(new Error("device query failed")),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    expect(container.querySelector(".ss-inline-note")?.textContent).toBe(
      "Unable to load microphones: device query failed",
    );
  });

  it("invalidates an older render before applying its device result", async () => {
    const staleDevices = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = jest
      .fn()
      .mockImplementationOnce(() => staleDevices.promise)
      .mockResolvedValueOnce([device("fresh", "Fresh microphone")]);
    setMediaDevices(navigator, { enumerateDevices, getUserMedia: jest.fn() });
    const app = new App();
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const staleContainer = document.createElement("div");
    const freshContainer = document.createElement("div");

    const staleRender = displayRecorderTabContent(staleContainer, tab as any);
    await displayRecorderTabContent(freshContainer, tab as any);
    expect(freshContainer.textContent).toContain("Fresh microphone");

    staleDevices.resolve([device("stale", "Stale microphone")]);
    await staleRender;

    expect(staleContainer.textContent).not.toContain("Stale microphone");
    expect(freshContainer.textContent).toContain("Fresh microphone");
  });

  it("suppresses a pending result when the settings render unloads", async () => {
    const lateDevices = deferred<MediaDeviceInfo[]>();
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn(() => lateDevices.promise),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    const { plugin } = createPlugin(app);
    const harness = createTabHarness(app, plugin);
    const container = document.createElement("div");

    const render = displayRecorderTabContent(container, harness.tab as any);
    await Promise.resolve();
    harness.cleanup();
    lateDevices.resolve([device("late", "Late microphone")]);
    await render;

    expect(container.textContent).not.toContain("Late microphone");
    expect(harness.tab.registerRenderCleanup).toHaveBeenCalledTimes(1);
  });
});
