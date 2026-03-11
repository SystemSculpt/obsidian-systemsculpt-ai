import { PlatformContext } from "../../PlatformContext";
import {
  assertPiTextExecutionReady,
  resolvePiTextExecutionPlan,
  shouldUseLocalPiExecution,
} from "../PiTextRuntime";

describe("PiTextRuntime", () => {
  let supportsDesktopOnlyFeatures: jest.Mock<boolean, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    supportsDesktopOnlyFeatures = jest.fn(() => true);
    jest.spyOn(PlatformContext, "get").mockReturnValue({
      supportsDesktopOnlyFeatures,
    } as any);
  });

  describe("shouldUseLocalPiExecution", () => {
    it("returns true only for desktop-local Pi models", () => {
      expect(
        shouldUseLocalPiExecution({
          sourceMode: "pi_local",
          piLocalAvailable: true,
        } as any)
      ).toBe(true);

      supportsDesktopOnlyFeatures.mockReturnValue(false);
      expect(
        shouldUseLocalPiExecution({
          sourceMode: "pi_local",
          piLocalAvailable: true,
        } as any)
      ).toBe(false);
      expect(
        shouldUseLocalPiExecution({
          sourceMode: "pi_local",
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
        providerId: "openai",
        authMode: "local",
      });
    });

    it("keeps the SystemSculpt alias on the local Pi runtime", async () => {
      const plan = await resolvePiTextExecutionPlan({
        id: "systemsculpt@@systemsculpt/ai-agent",
        provider: "systemsculpt",
        sourceMode: "pi_local",
        piExecutionModelId: "systemsculpt/ai-agent",
        piLocalAvailable: true,
        piAuthMode: "local",
      } as any);

      expect(plan).toEqual({
        mode: "local",
        actualModelId: "systemsculpt/ai-agent",
        providerId: "systemsculpt",
        authMode: "local",
      });
    });

    it("fails outside the desktop app", async () => {
      supportsDesktopOnlyFeatures.mockReturnValue(false);

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

  describe("assertPiTextExecutionReady", () => {
    it("returns the local Pi execution plan when the model is available", async () => {
      await expect(
        assertPiTextExecutionReady({
          id: "anthropic@@claude-3.7-sonnet",
          provider: "anthropic",
          sourceMode: "pi_local",
          piExecutionModelId: "anthropic/claude-3.7-sonnet",
          piLocalAvailable: true,
          piAuthMode: "local",
        } as any)
      ).resolves.toEqual({
        mode: "local",
        actualModelId: "anthropic/claude-3.7-sonnet",
        providerId: "anthropic",
        authMode: "local",
      });
    });
  });
});
