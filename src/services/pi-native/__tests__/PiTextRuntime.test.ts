jest.mock("../PiTextAuth", () => ({
  buildPiTextProviderSetupMessage: jest.fn((provider: string, actualModelId?: string) =>
    `Connect ${provider} in Pi before running "${actualModelId || provider}".`
  ),
  hasPiTextProviderAuth: jest.fn().mockResolvedValue(true),
}));

import { Platform } from "obsidian";
import {
  resolvePiTextExecutionPlan,
  shouldUseLocalPiExecution,
} from "../PiTextRuntime";

describe("PiTextRuntime", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  describe("shouldUseLocalPiExecution", () => {
    it("returns true only for desktop-local Pi models", () => {
      expect(
        shouldUseLocalPiExecution({
          piLocalAvailable: true,
        } as any)
      ).toBe(true);

      Object.defineProperty(Platform, "isDesktopApp", {
        configurable: true,
        value: false,
      });
      expect(
        shouldUseLocalPiExecution({
          piLocalAvailable: true,
        } as any)
      ).toBe(false);
      expect(
        shouldUseLocalPiExecution({
          piLocalAvailable: false,
        } as any)
      ).toBe(false);
    });
  });

  describe("resolvePiTextExecutionPlan", () => {
    it("uses the local Pi runtime for desktop-local models", async () => {
      const plan = await resolvePiTextExecutionPlan({
        id: "openai@@gpt-5-mini",
        provider: "openai",
        piExecutionModelId: "openai/gpt-5-mini",
        piLocalAvailable: true,
      } as any);

      expect(plan).toEqual({
        mode: "local",
        actualModelId: "openai/gpt-5-mini",
      });
    });

    it("fails outside the desktop app", async () => {
      Object.defineProperty(Platform, "isDesktopApp", {
        configurable: true,
        value: false,
      });

      await expect(
        resolvePiTextExecutionPlan({
          id: "openai@@gpt-5-mini",
          provider: "openai",
          piExecutionModelId: "openai/gpt-5-mini",
          piLocalAvailable: true,
        } as any)
      ).rejects.toThrow("Pi desktop text generation is only available in the desktop app.");
    });

    it("fails when the selected model is not available in the local Pi runtime", async () => {
      await expect(
        resolvePiTextExecutionPlan({
          id: "openai@@gpt-5-mini",
          provider: "openai",
          piExecutionModelId: "openai/gpt-5-mini",
          piLocalAvailable: false,
        } as any)
      ).rejects.toThrow(
        'Pi desktop mode requires a locally available Pi model. "openai/gpt-5-mini" is not available in the local Pi runtime.'
      );
    });

    it("fails when a model is missing its Pi execution id", async () => {
      await expect(
        resolvePiTextExecutionPlan({
          id: "broken-model",
          provider: "openai",
          piExecutionModelId: "",
          piLocalAvailable: true,
        } as any)
      ).rejects.toThrow('Model "broken-model" is missing a Pi execution model id.');
    });
  });
});
