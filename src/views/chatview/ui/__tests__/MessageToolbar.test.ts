/**
 * @jest-environment jsdom
 */
import { attachMessageToolbar } from "../MessageToolbar";
import { setIcon } from "obsidian";

jest.mock("obsidian", () => ({
  Platform: { isMobile: false },
  setIcon: jest.fn(),
}));

jest.mock("../../../../services/PlatformContext", () => ({
  PlatformContext: {
    get: () => ({
      uiVariant: () => "desktop",
    }),
  },
}));

describe("MessageToolbar", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("calls the typed resend callback on the first resend click", async () => {
    const messageEl = document.createElement("div");
    messageEl.className = "systemsculpt-message systemsculpt-user-message";
    messageEl.dataset.content = "hi :)";

    const contentEl = document.createElement("div");
    contentEl.className = "systemsculpt-message-content";
    contentEl.textContent = "hi :)";
    messageEl.appendChild(contentEl);
    document.body.appendChild(messageEl);

    const onResend = jest.fn().mockResolvedValue({ status: "success" });

    attachMessageToolbar({
      app: {} as any,
      messageEl,
      role: "user",
      messageId: "msg-1",
      onResend,
    });

    const resendBtn = messageEl.querySelector('button[aria-label="Resend"]') as HTMLButtonElement | null;
    expect(resendBtn).not.toBeNull();

    resendBtn?.click();
    await Promise.resolve();

    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onResend).toHaveBeenCalledWith({
      messageId: "msg-1",
      content: "hi :)",
    });
  });

  it("shows resend pending and success feedback", async () => {
    const messageEl = document.createElement("div");
    messageEl.className = "systemsculpt-message systemsculpt-user-message";
    messageEl.dataset.content = "hi :)";

    const contentEl = document.createElement("div");
    contentEl.className = "systemsculpt-message-content";
    contentEl.textContent = "hi :)";
    messageEl.appendChild(contentEl);
    document.body.appendChild(messageEl);

    let resolveResend: ((value: { status: "success" }) => void) | undefined;
    const onResend = jest.fn(
      () =>
        new Promise<{ status: "success" }>((resolve) => {
          resolveResend = resolve;
        })
    );

    attachMessageToolbar({
      app: {} as any,
      messageEl,
      role: "user",
      messageId: "msg-1",
      onResend,
    });

    const resendBtn = messageEl.querySelector('button[aria-label="Resend"]') as HTMLButtonElement | null;
    expect(resendBtn).not.toBeNull();

    resendBtn?.click();
    expect(resendBtn?.getAttribute("aria-label")).toBe("Resending…");
    expect(resendBtn?.disabled).toBe(true);
    expect(resendBtn?.classList.contains("ss-confirm")).toBe(true);

    resolveResend?.({ status: "success" });
    await Promise.resolve();

    expect(resendBtn?.getAttribute("aria-label")).toBe("Resent");
    expect(resendBtn?.classList.contains("ss-success")).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(resendBtn, "check");

    jest.advanceTimersByTime(1200);

    expect(resendBtn?.getAttribute("aria-label")).toBe("Resend");
    expect(resendBtn?.disabled).toBe(false);
    expect(resendBtn?.classList.contains("ss-success")).toBe(false);
  });
});
