/** @jest-environment jsdom */

import { App } from "obsidian";
import { showPopup } from "../../../core/ui/";
import {
  STANDARD_CHAT_IDENTITY,
  STANDARD_CHAT_PERSISTED_MODEL_ID,
  getChatModelDisplayName,
  getStandardChatModelOption,
  loadChatModelPickerOptions,
  normalizeStandardChatModelId,
  promptChatModelSetup,
} from "../modelSelection";

jest.mock("../../../core/ui/", () => ({ showPopup: jest.fn() }));

describe("standard Chat identity", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    undefined,
    null,
    "",
    "systemsculpt/ai-agent",
    "ai-agent",
    "openai@@gpt-4.1",
    "local-pi-openai@@gpt-5.4",
    "retired-provider@@retired-model",
  ])("normalizes %p before any lookup", (candidate) => {
    expect(normalizeStandardChatModelId(candidate)).toBe("systemsculpt@@systemsculpt/ai-agent");
  });

  it("exposes distinct persisted, display, and wire identities", () => {
    expect(STANDARD_CHAT_PERSISTED_MODEL_ID).toBe("systemsculpt@@systemsculpt/ai-agent");
    expect(STANDARD_CHAT_IDENTITY).toEqual({
      persistedId: "systemsculpt@@systemsculpt/ai-agent",
      providerLabel: "SystemSculpt",
      modelLabel: "ai-agent",
      wireModel: "ai-agent",
    });
    expect(Object.isFrozen(STANDARD_CHAT_IDENTITY)).toBe(true);
    expect(getChatModelDisplayName("openai@@gpt-4.1")).toBe("SystemSculpt");
  });

  it("returns one deeply immutable picker option without reading catalog/provider state", async () => {
    const poison = {} as Record<string, object>;
    for (const key of ["modelService", "settings", "favorites", "providerRegistry", "piAuth"]) {
      Object.defineProperty(poison, key, { get: () => { throw new Error(`forbidden read: ${key}`); } });
    }
    const options = await loadChatModelPickerOptions(poison);
    expect(options).toEqual([getStandardChatModelOption()]);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({
      value: "systemsculpt@@systemsculpt/ai-agent",
      label: "SystemSculpt",
      modelLabel: "ai-agent",
      icon: "sparkles",
    });
    expect(Object.isFrozen(options[0])).toBe(true);
  });

  it("routes the only setup action to Account", async () => {
    (showPopup as jest.Mock).mockResolvedValue({ confirmed: true });
    const openAccount = jest.fn();
    await expect(promptChatModelSetup({ app: new App(), openAccount, retryHint: true })).resolves.toBe(true);
    expect(showPopup).toHaveBeenCalledWith(
      expect.any(App),
      "Open Settings -> Account to activate your SystemSculpt license, then try again.",
      expect.objectContaining({ title: "Finish setup", primaryButton: "Open Account" }),
    );
    expect(openAccount).toHaveBeenCalledTimes(1);
  });
});
