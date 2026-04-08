import { PlatformContext } from "../../PlatformContext";
import { resolveProviderRuntimePlan, ensureProviderRuntimeReady } from "../ProviderRuntime";

const mockAssertPiTextExecutionReady = jest.fn();
const mockHasPiTextProviderAuth = jest.fn();
const mockBuildPiTextProviderSetupMessage = jest.fn(
  (providerId: string, actualModelId?: string) =>
    actualModelId
      ? `Connect ${providerId} in Providers before running "${actualModelId}".`
      : `Connect ${providerId} in Providers before using this model.`
);

jest.mock("../../pi-native/PiTextAuth", () => ({
  hasPiTextProviderAuth: (...args: any[]) => mockHasPiTextProviderAuth(...args),
  buildPiTextProviderSetupMessage: (...args: any[]) =>
    mockBuildPiTextProviderSetupMessage(...args),
}));

jest.mock("../../pi-native/PiTextRuntime", () => ({
  assertPiTextExecutionReady: (...args: any[]) =>
    mockAssertPiTextExecutionReady(...args),
}));

jest.mock("../RemoteProviderCatalog", () => ({
  getConfiguredRemoteProviderApiKey: jest.fn(() => "sk-test-key"),
  resolveRemoteProviderEndpoint: jest.fn(() => "https://openrouter.ai/api/v1"),
}));

const mockResolveStudioPiProviderApiKey = jest.fn<Promise<string | null>, any[]>();
jest.mock("../../../studio/piAuth/StudioPiAuthStorage", () => ({
  resolveStudioPiProviderApiKey: (...args: any[]) => mockResolveStudioPiProviderApiKey(...args),
}));

import {
  getConfiguredRemoteProviderApiKey,
  resolveRemoteProviderEndpoint,
} from "../RemoteProviderCatalog";

const mockedGetApiKey = getConfiguredRemoteProviderApiKey as jest.Mock;
const mockedResolveEndpoint = resolveRemoteProviderEndpoint as jest.Mock;

describe("ProviderRuntime", () => {
  let supportsDesktopOnlyFeatures: jest.Mock<boolean, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    supportsDesktopOnlyFeatures = jest.fn(() => true);
    jest.spyOn(PlatformContext, "get").mockReturnValue({
      supportsDesktopOnlyFeatures,
    } as any);
    mockedGetApiKey.mockReturnValue("sk-test-key");
    mockResolveStudioPiProviderApiKey.mockResolvedValue("sk-test-key");
    mockedResolveEndpoint.mockReturnValue("https://openrouter.ai/api/v1");
  });

  describe("resolveProviderRuntimePlan — pi_local models", () => {
    it("delegates to assertPiTextExecutionReady for pi_local models", async () => {
      mockAssertPiTextExecutionReady.mockResolvedValue({
        mode: "local",
        actualModelId: "llama-3.2",
        providerId: "local-pi",
        authMode: "local",
      });

      const model = {
        sourceMode: "pi_local",
        supported_parameters: ["tools"],
        architecture: { modality: "text->text" },
      } as any;

      const plan = await resolveProviderRuntimePlan(model);

      expect(mockAssertPiTextExecutionReady).toHaveBeenCalledWith(model);
      expect(plan).toEqual({
        mode: "local",
        actualModelId: "llama-3.2",
        providerId: "local-pi",
        authMode: "local",
        supportsTools: true,
        supportsImages: false,
      });
    });

    it("detects image support from architecture modality", async () => {
      mockAssertPiTextExecutionReady.mockResolvedValue({
        mode: "local",
        actualModelId: "llava-1.6",
        providerId: "local-pi",
        authMode: "local",
      });

      const model = {
        sourceMode: "pi_local",
        supported_parameters: [],
        architecture: { modality: "text+image->text" },
      } as any;

      const plan = await resolveProviderRuntimePlan(model);
      expect(plan.supportsImages).toBe(true);
      expect(plan.supportsTools).toBe(false);
    });
  });

  describe("resolveProviderRuntimePlan — custom_endpoint remote models", () => {
    function makeRemoteModel(overrides: Record<string, any> = {}): any {
      return {
        id: "openrouter@@openai/gpt-5.4-mini",
        sourceMode: "custom_endpoint",
        piRemoteAvailable: true,
        piExecutionModelId: "openai/gpt-5.4-mini",
        sourceProviderId: "openrouter",
        provider: "openrouter",
        supported_parameters: ["tools"],
        architecture: { modality: "text+image->text" },
        ...overrides,
      };
    }

    it("resolves a remote BYOK plan when provider auth exists via plugin key", async () => {
      const model = makeRemoteModel();
      const plugin = {} as any;
      const plan = await resolveProviderRuntimePlan(model, plugin);

      expect(plan).toEqual({
        mode: "remote",
        actualModelId: "openai/gpt-5.4-mini",
        providerId: "openrouter",
        authMode: "byok",
        endpoint: "https://openrouter.ai/api/v1",
        supportsTools: true,
        supportsImages: true,
      });
    });

    it("falls back to Pi provider auth when plugin has no stored key", async () => {
      mockedGetApiKey.mockReturnValue("");
      mockResolveStudioPiProviderApiKey.mockResolvedValue(null);
      mockHasPiTextProviderAuth.mockResolvedValue(true);

      const model = makeRemoteModel();
      const plan = await resolveProviderRuntimePlan(model);

      expect(mockHasPiTextProviderAuth).toHaveBeenCalledWith(
        "openrouter",
        undefined
      );
      expect(plan.mode).toBe("remote");
      expect(plan.authMode).toBe("byok");
    });

    it("throws when neither plugin key nor Pi auth is available", async () => {
      mockedGetApiKey.mockReturnValue("");
      mockResolveStudioPiProviderApiKey.mockResolvedValue(null);
      mockHasPiTextProviderAuth.mockResolvedValue(false);

      const model = makeRemoteModel();

      await expect(resolveProviderRuntimePlan(model)).rejects.toThrow(
        /Connect openrouter in Providers/
      );
    });

    it("throws when piExecutionModelId is missing", async () => {
      const model = makeRemoteModel({ piExecutionModelId: "" });

      await expect(resolveProviderRuntimePlan(model)).rejects.toThrow(
        /missing a remote execution model id/
      );
    });

    it("throws when no endpoint is configured for the provider", async () => {
      mockedResolveEndpoint.mockReturnValue("");

      const model = makeRemoteModel();
      const plugin = {} as any;

      await expect(
        resolveProviderRuntimePlan(model, plugin)
      ).rejects.toThrow(/No remote endpoint.*openrouter/);
    });

    it("normalizes providerId from sourceProviderId, then provider, then model id prefix", async () => {
      mockedGetApiKey.mockReturnValue("sk-key");
      mockResolveStudioPiProviderApiKey.mockResolvedValue("sk-key");
      mockedResolveEndpoint.mockReturnValue("https://example.com/v1");
      mockHasPiTextProviderAuth.mockResolvedValue(true);

      const model = makeRemoteModel({
        sourceProviderId: "",
        provider: "",
        piExecutionModelId: "anthropic/claude-4",
      });

      const plan = await resolveProviderRuntimePlan(model);
      expect(plan.providerId).toBe("anthropic");
    });
  });

  describe("resolveProviderRuntimePlan — unsupported models", () => {
    it("throws a desktop-specific message on desktop", async () => {
      const model = { sourceMode: "unknown" } as any;
      await expect(resolveProviderRuntimePlan(model)).rejects.toThrow(
        /not configured for provider-backed execution/
      );
    });

    it("throws a mobile-specific message on mobile", async () => {
      supportsDesktopOnlyFeatures.mockReturnValue(false);
      const model = { sourceMode: "unknown" } as any;
      await expect(resolveProviderRuntimePlan(model)).rejects.toThrow(
        /not available for mobile/
      );
    });

    it("throws for custom_endpoint models without piRemoteAvailable", async () => {
      const model = {
        sourceMode: "custom_endpoint",
        piRemoteAvailable: false,
      } as any;
      await expect(resolveProviderRuntimePlan(model)).rejects.toThrow();
    });
  });

  describe("ensureProviderRuntimeReady", () => {
    it("is an alias for resolveProviderRuntimePlan", async () => {
      mockedGetApiKey.mockReturnValue("sk-key");
      mockHasPiTextProviderAuth.mockResolvedValue(true);
      const model = {
        sourceMode: "custom_endpoint",
        piRemoteAvailable: true,
        piExecutionModelId: "openai/gpt-5.4-mini",
        sourceProviderId: "openrouter",
        supported_parameters: ["tools"],
        architecture: { modality: "text->text" },
      } as any;

      const plan = await ensureProviderRuntimeReady(model);
      expect(plan.mode).toBe("remote");
      expect(plan.actualModelId).toBe("openai/gpt-5.4-mini");
    });
  });
});
