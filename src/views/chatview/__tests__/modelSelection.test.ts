/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { showPopup } from "../../../core/ui/";
import {
  openChatModelSetupTab,
  promptChatModelSetup,
} from "../modelSelection";

jest.mock("../../../core/ui/", () => ({
  showPopup: jest.fn(),
}));

describe("chat model setup helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens Providers when Pi setup is confirmed", async () => {
    (showPopup as jest.Mock).mockResolvedValue({ confirmed: true });
    const openSettingsTab = jest.fn();

    await expect(
      promptChatModelSetup({
        app: new App(),
        openSettingsTab,
        selectedModelId: "openai@@gpt-4.1",
      }),
    ).resolves.toBe(true);

    expect(showPopup).toHaveBeenCalledWith(
      expect.any(App),
      "Open Settings -> Providers to connect the selected Pi provider.",
      expect.objectContaining({
        title: "Finish Pi setup",
        primaryButton: "Open Providers",
      }),
    );
    expect(openSettingsTab).toHaveBeenCalledWith("providers");
  });

  it("uses retry-hint account copy and does not open settings when dismissed", async () => {
    (showPopup as jest.Mock).mockResolvedValue({ confirmed: false });
    const openSettingsTab = jest.fn();

    await expect(
      promptChatModelSetup({
        app: new App(),
        openSettingsTab,
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        retryHint: true,
      }),
    ).resolves.toBe(false);

    expect(showPopup).toHaveBeenCalledWith(
      expect.any(App),
      "Open Settings -> Account to activate your SystemSculpt license, then try again.",
      expect.objectContaining({
        title: "Finish setup",
        primaryButton: "Open Account",
      }),
    );
    expect(openSettingsTab).not.toHaveBeenCalled();
  });

  it("swallows settings-tab failures for setup fallbacks", () => {
    expect(() => {
      openChatModelSetupTab(() => {
        throw new Error("settings unavailable");
      }, "providers");
    }).not.toThrow();
  });
});
