import { PlatformContext } from "../../PlatformContext";
import {
  assertPiTextExecutionReady,
  resolvePiTextExecutionPlan,
  shouldUseLocalPiExecution,
} from "../PiTextRuntime";
import { ensureProviderRuntimeReady } from "../../providerRuntime/ProviderRuntime";

jest.mock("../PiTextAuth", () => ({
  hasPiTextProviderAuth: jest.fn(async () => true),
  buildPiTextProviderSetupMessage: jest.fn((providerId: string, actualModelId?: string) =>
    actualModelId
      ? `Connect ${providerId} in Pi before running "${actualModelId}".`
      : `Connect ${providerId} in Pi before using this model.`
  ),
}));

jest.mock("../../providerRuntime/RemoteProviderCatalog", () => ({
  resolveRemoteProviderEndpoint: jest.fn(() => "https://openrouter.ai/api/v1"),
  getConfiguredRemoteProviderApiKey: jest.fn(() => ""),
}));

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

  describe("ensureProviderRuntimeReady", () => {
    it("returns a remote runtime plan for configured remote provider models", async () => {
      supportsDesktopOnlyFeatures.mockReturnValue(false);

      await expect(
        ensureProviderRuntimeReady({
          id: "openrouter@@openai/gpt-5.4-mini",
          provider: "openrouter",
          sourceMode: "custom_endpoint",
          sourceProviderId: "openrouter",
          piExecutionModelId: "openai/gpt-5.4-mini",
          piRemoteAvailable: true,
          supported_parameters: ["tools"],
          architecture: { modality: "text+image->text" },
        } as any)
      ).resolves.toEqual({
        mode: "remote",
        actualModelId: "openai/gpt-5.4-mini",
        providerId: "openrouter",
        authMode: "byok",
        endpoint: "https://openrouter.ai/api/v1",
        supportsTools: true,
        supportsImages: true,
      });
    });

    it("accepts plugin-stored remote provider API keys before auth inventory catches up", async () => {
      const remoteCatalog = jest.requireMock("../../providerRuntime/RemoteProviderCatalog") as {
        getConfiguredRemoteProviderApiKey: jest.Mock;
      };
      supportsDesktopOnlyFeatures.mockReturnValue(false);
      remoteCatalog.getConfiguredRemoteProviderApiKey.mockReturnValueOnce("sk-or-mobile");

      await expect(
        ensureProviderRuntimeReady({
          id: "openrouter@@openai/gpt-5.4-mini",
          provider: "openrouter",
          sourceMode: "custom_endpoint",
          sourceProviderId: "openrouter",
          piExecutionModelId: "openai/gpt-5.4-mini",
          piRemoteAvailable: true,
          supported_parameters: ["tools"],
          architecture: { modality: "text+image->text" },
        } as any, {
          settings: {
            customProviders: [
              {
                id: "openrouter",
                endpoint: "https://openrouter.ai/api/v1",
                apiKey: "sk-or-mobile",
                isEnabled: true,
              },
            ],
          },
        } as any)
      ).resolves.toEqual({
        mode: "remote",
        actualModelId: "openai/gpt-5.4-mini",
        providerId: "openrouter",
        authMode: "byok",
        endpoint: "https://openrouter.ai/api/v1",
        supportsTools: true,
        supportsImages: true,
      });
    });

    it("fails remote provider models when mobile auth is missing", async () => {
      const { hasPiTextProviderAuth } = jest.requireMock("../PiTextAuth") as {
        hasPiTextProviderAuth: jest.Mock;
      };
      supportsDesktopOnlyFeatures.mockReturnValue(false);
      hasPiTextProviderAuth.mockResolvedValueOnce(false);

      await expect(
        ensureProviderRuntimeReady({
          id: "openrouter@@openai/gpt-5.4-mini",
          provider: "openrouter",
          sourceMode: "custom_endpoint",
          sourceProviderId: "openrouter",
          piExecutionModelId: "openai/gpt-5.4-mini",
          piRemoteAvailable: true,
          supported_parameters: ["tools"],
          architecture: { modality: "text+image->text" },
        } as any)
      ).rejects.toThrow('Connect openrouter in Pi before running "openai/gpt-5.4-mini".');
    });
  });
});
