/**
 * @jest-environment jsdom
 */

import { InputHandler } from "../InputHandler";

type ButtonStub = {
  buttonEl: HTMLButtonElement;
  setDisabled: jest.Mock<ButtonStub, [boolean]>;
};

function buttonStub(): ButtonStub {
  const buttonEl = document.createElement("button");
  const stub = {
    buttonEl,
    setDisabled: jest.fn(),
  } as ButtonStub;
  stub.setDisabled.mockImplementation((disabled: boolean) => {
    buttonEl.disabled = disabled;
    return stub;
  });
  return stub;
}

function createHarness(initialReadOnly: boolean) {
  let readOnly = initialReadOnly;
  const inputWrapper = document.createElement("div");
  const input = document.createElement("textarea");
  input.value = "draft";
  inputWrapper.appendChild(input);

  const sendButton = buttonStub();
  const attachButton = buttonStub();
  const micButton = buttonStub();
  const settingsButton = buttonStub();
  const stopButton = buttonStub();

  const handler = Object.assign(Object.create(InputHandler.prototype), {
    input,
    inputWrapper,
    sendButton,
    attachButton,
    micButton,
    settingsButton,
    stopButton,
    isGenerating: false,
    isChatReady: () => true,
    chatView: {
      isLegacyReadOnlyChat: () => readOnly,
    },
    plugin: {
      settings: {
        licenseKey: "license",
        licenseValid: true,
      },
    },
    scrollManager: {
      setGenerating: jest.fn(),
    },
  }) as InputHandler;

  return {
    handler,
    input,
    inputWrapper,
    sendButton,
    attachButton,
    micButton,
    settingsButton,
    setReadOnly(value: boolean) {
      readOnly = value;
    },
  };
}

describe("InputHandler archived-chat composer state", () => {
  it("visibly disables transcript and context mutation controls", () => {
    const harness = createHarness(true);

    harness.handler.notifyChatReadyChanged();

    expect(harness.input.disabled).toBe(true);
    expect(harness.input.placeholder).toBe("This archived chat is read-only.");
    expect(harness.input.getAttribute("aria-readonly")).toBe("true");
    expect(harness.input.getAttribute("aria-label")).toBe("Archived chat is read-only");
    expect(harness.inputWrapper.classList.contains("is-read-only")).toBe(true);
    expect(harness.sendButton.buttonEl.disabled).toBe(true);
    expect(harness.attachButton.buttonEl.disabled).toBe(true);
    expect(harness.micButton.buttonEl.disabled).toBe(true);
    expect(harness.settingsButton.buttonEl.disabled).toBe(false);
  });

  it("re-enables the same composer when the view switches to a managed chat", () => {
    const harness = createHarness(true);
    harness.handler.notifyChatReadyChanged();

    harness.setReadOnly(false);
    harness.handler.notifyChatReadyChanged();

    expect(harness.input.disabled).toBe(false);
    expect(harness.input.placeholder).toBe("Write a message…");
    expect(harness.input.getAttribute("aria-readonly")).toBe("false");
    expect(harness.input.getAttribute("aria-label")).toBe("Chat message");
    expect(harness.inputWrapper.classList.contains("is-read-only")).toBe(false);
    expect(harness.sendButton.buttonEl.disabled).toBe(false);
    expect(harness.attachButton.buttonEl.disabled).toBe(false);
    expect(harness.micButton.buttonEl.disabled).toBe(false);
  });
});
