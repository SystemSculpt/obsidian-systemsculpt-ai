/**
 * @jest-environment jsdom
 */

import { createRecorderWidget } from "../RecorderWidget";

describe("RecorderWidget", () => {
  const makePlugin = () => {
    return {
      settings: {
        autoTranscribeRecordings: false,
        autoPasteTranscription: false,
        autoSubmitAfterTranscription: false,
        cleanTranscriptionOutput: false,
        postProcessingEnabled: false,
        preferredMicrophoneId: "default",
      },
      app: {
        workspace: {
          activeLeaf: null,
        },
      },
      getLogger: () => ({
        error: jest.fn(),
      }),
      getSettingsManager: () => ({
        updateSettings: jest.fn(async () => undefined),
      }),
    } as any;
  };

  it("fires onStop when stop button clicked", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const onStop = jest.fn();
    createRecorderWidget({
      host,
      plugin: makePlugin(),
      variant: "desktop",
      onStop,
    });

    const stopButton = host.querySelector("button[data-recorder-stop='true']") as HTMLButtonElement;
    expect(stopButton).toBeTruthy();

    stopButton.click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does not use stop button as drag handle", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const handles = createRecorderWidget({
      host,
      plugin: makePlugin(),
      variant: "desktop",
      onStop: () => undefined,
    });

    const stopButton = host.querySelector("button[data-recorder-stop='true']") as HTMLButtonElement;
    expect(stopButton).toBeTruthy();

    expect(handles.dragHandleEl.contains(stopButton)).toBe(false);
  });
});
