/** @jest-environment jsdom */

import { App, Platform } from "obsidian";
import { displayRecorderTabContent } from "../settings/RecorderTabContent";
import {
  getCurrentHostPreferredMicrophoneId,
  setCurrentHostPreferredMicrophoneId,
} from "../services/recorder/RecorderPreferenceStore";

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

const createPlugin = (app: App, settings: Record<string, unknown> = {}) => {
  const updateSettings = jest.fn().mockResolvedValue(undefined);
  const recoverPendingCaptures = jest.fn();
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
        ...settings,
      },
      getSettingsManager: jest.fn(() => ({ updateSettings })),
      getRecorderService: jest.fn(() => ({ recoverPendingCaptures })),
    },
    updateSettings,
    recoverPendingCaptures,
  };
};

const createTabHarness = (app: App, plugin: unknown) => {
  const cleanups = new Set<() => void>();
  const listeners: Array<{
    element: HTMLElement;
    type: string;
    listener: EventListener;
  }> = [];
  const tab = {
    app,
    plugin,
    registerRenderCleanup: jest.fn((cleanup: () => void) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    }),
    registerListener: jest.fn((element: HTMLElement, type: string, listener: EventListener) => {
      element.addEventListener(type, listener);
      listeners.push({ element, type, listener });
    }),
  };
  return {
    tab,
    cleanup: () => {
      const pending = [...cleanups];
      cleanups.clear();
      pending.forEach((cleanup) => cleanup());
      listeners.splice(0).forEach(({ element, type, listener }) => {
        element.removeEventListener(type, listener);
      });
    },
  };
};

describe("Recorder settings tab", () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

  afterEach(() => {
    document.body.empty();
    const vaultIdentity = new App().vault.getName();
    setCurrentHostPreferredMicrophoneId(window, vaultIdentity, "");
    Object.assign(Platform, {
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
    });
    setCurrentHostPreferredMicrophoneId(window, vaultIdentity, "");
    window.localStorage.clear();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    }
  });

  it("groups the canonical recorder controls and removes retired options", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([]),
      getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }),
    });
    const app = new App();
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    const headings = [...container.querySelectorAll("h3")].map((element) => element.textContent?.trim());
    expect(headings).toEqual(["Capture", "After recording", "Transcript output", "Chat dictation"]);

    const names = [...container.querySelectorAll(".setting-item-name")].map((element) => element.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining([
      "Microphone",
      "Transcribe automatically",
      "Keep source audio",
      "Default file format",
      "Clean transcript output",
      "Clean up transcript",
      "Insert transcript at origin",
      "Send after dictation",
    ]));
    expect(names).not.toContain("Cleanup instructions");
    expect(names).not.toContain("Automatic audio format conversion");
    expect(names).not.toContain("Show output format chooser in transcribe modal");
    expect(names).not.toContain("Transcription provider");
    expect(names).not.toContain("Custom endpoint URL");
    expect(names).not.toContain("API key");
    expect(names).not.toContain("Model name");
    expect(names).not.toContain("Post-processing model");
    expect(container.textContent).toContain(
      "exact note insertion target remains unchanged",
    );
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
      '.extra-button[aria-label="Refresh microphone list"]',
    ) as HTMLButtonElement | null;
    expect(refreshButton).not.toBeNull();
    expect(refreshButton?.classList.contains("ss-recorder-microphone-refresh")).toBe(true);
    refreshButton?.click();
    await flush();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stores the default microphone locally on this device", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([device("built-in", "Built-in microphone")]),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    setCurrentHostPreferredMicrophoneId(window, app.vault.getName(), "built-in");
    const { plugin, updateSettings } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    const microphoneSelect = container.querySelector("select") as HTMLSelectElement;
    expect(microphoneSelect.value).toBe("built-in");

    microphoneSelect.value = "";
    microphoneSelect.dispatchEvent(new Event("change"));
    await flush();

    expect(getCurrentHostPreferredMicrophoneId(window, app.vault.getName())).toBe("");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("shows a saved microphone as unavailable instead of silently displaying default", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([
        device("built-in", "Built-in microphone"),
      ]),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    setCurrentHostPreferredMicrophoneId(
      window,
      app.vault.getName(),
      "disconnected-usb-mic",
    );
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    const microphoneSelect = container.querySelector("select") as HTMLSelectElement;
    expect(microphoneSelect.value).toBe("disconnected-usb-mic");
    expect(microphoneSelect.selectedOptions[0]?.text).toBe("Saved microphone (unavailable)");
    expect(container.textContent).toContain("Recording will fall back to the default microphone");
  });

  it("shows cleanup instructions only when enabled and saves them on change", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([]),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    const { plugin, updateSettings } = createPlugin(app, { postProcessingEnabled: true });
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    expect(container.textContent).toContain("Cleanup instructions");
    expect(container.textContent).toContain(
      "Cleanup always keeps the original languages, names, and code-switches.",
    );
    const prompt = container.querySelector("textarea") as HTMLTextAreaElement;
    prompt.value = "Keep the wording concise.";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(updateSettings).not.toHaveBeenCalled();

    prompt.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(updateSettings).toHaveBeenCalledWith({
      postProcessingPrompt: "Keep the wording concise.",
    });
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
    expect(getCurrentHostPreferredMicrophoneId(
      foreignWindow,
      app.vault.getName(),
    )).toBe("popout");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps device-local mobile and desktop microphone preferences isolated", async () => {
    const app = new App();
    setCurrentHostPreferredMicrophoneId(window, app.vault.getName(), "desk-mic");
    Object.assign(Platform, {
      isDesktopApp: false,
      isMobile: true,
      isMobileApp: true,
    });
    setCurrentHostPreferredMicrophoneId(window, app.vault.getName(), "phone");
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([
        device("phone", "Phone microphone"),
        device("headset", "USB headset"),
      ]),
      getUserMedia: jest.fn(),
    });
    const { plugin, updateSettings } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("phone");

    select.value = "headset";
    select.dispatchEvent(new Event("change"));
    await flush();

    expect(getCurrentHostPreferredMicrophoneId(window, app.vault.getName())).toBe("headset");
    expect(updateSettings).not.toHaveBeenCalled();

    Object.assign(Platform, {
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
    });
    expect(getCurrentHostPreferredMicrophoneId(window, app.vault.getName())).toBe("desk-mic");
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

  it("explains how to reveal microphones when passive mobile enumeration is permission-gated", async () => {
    setMediaDevices(navigator, {
      enumerateDevices: jest.fn().mockResolvedValue([device("", "")]),
      getUserMedia: jest.fn(),
    });
    const app = new App();
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      "Default microphone",
    ]);
    expect(container.querySelector(".ss-inline-note")?.textContent).toBe(
      "Tap Refresh microphone list to reveal named microphones.",
    );
  });

  it("keeps a selection changed while microphone enumeration is in flight", async () => {
    const refreshedDevices = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = jest
      .fn()
      .mockResolvedValueOnce([device("saved", "Saved microphone")])
      .mockImplementationOnce(() => refreshedDevices.promise);
    setMediaDevices(navigator, { enumerateDevices, getUserMedia: jest.fn() });
    const app = new App();
    setCurrentHostPreferredMicrophoneId(window, app.vault.getName(), "saved");
    const { plugin } = createPlugin(app);
    const { tab } = createTabHarness(app, plugin);
    const container = document.createElement("div");

    await displayRecorderTabContent(container, tab as any);
    const select = container.querySelector("select") as HTMLSelectElement;
    const refreshButton = container.querySelector(
      '.extra-button[aria-label="Refresh microphone list"]',
    ) as HTMLButtonElement;

    refreshButton.click();
    await Promise.resolve();
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(getCurrentHostPreferredMicrophoneId(window, app.vault.getName())).toBe("");

    refreshedDevices.resolve([
      device("saved", "Saved microphone"),
      device("new", "New microphone"),
    ]);
    await flush();

    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.text).toBe("Default microphone");
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
