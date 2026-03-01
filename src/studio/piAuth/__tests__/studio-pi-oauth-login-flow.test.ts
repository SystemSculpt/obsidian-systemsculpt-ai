import { runStudioPiOAuthLoginFlow } from "../StudioPiOAuthLoginFlow";
import * as StudioPiAuthStorage from "../StudioPiAuthStorage";

jest.mock("../StudioPiAuthStorage", () => ({
  loginStudioPiProviderOAuth: jest.fn(),
}));

describe("runStudioPiOAuthLoginFlow", () => {
  const loginStudioPiProviderOAuthMock = StudioPiAuthStorage.loginStudioPiProviderOAuth as jest.Mock;

  beforeEach(() => {
    loginStudioPiProviderOAuthMock.mockReset();
  });

  it("tracks auth events and auth URL callbacks", async () => {
    loginStudioPiProviderOAuthMock.mockImplementation(async (options: any) => {
      options.onAuth({ url: "https://claude.ai/oauth/authorize", instructions: "Open browser" });
    });

    const result = await runStudioPiOAuthLoginFlow({
      providerId: "anthropic",
      onAuth: () => {},
      onPrompt: async () => "ignored",
    });

    expect(result).toEqual({
      sawAuthEvent: true,
      sawAuthUrl: true,
    });
  });

  it("tracks prompt-driven flows even when no auth URL is emitted", async () => {
    loginStudioPiProviderOAuthMock.mockImplementation(async (options: any) => {
      await options.onPrompt({
        message: "Paste the authorization code:",
      });
    });

    const result = await runStudioPiOAuthLoginFlow({
      providerId: "anthropic",
      onAuth: () => {},
      onPrompt: async () => "code#state",
    });

    expect(result).toEqual({
      sawAuthEvent: true,
      sawAuthUrl: false,
    });
  });

  it("fails when provider emits no auth events", async () => {
    loginStudioPiProviderOAuthMock.mockResolvedValue(undefined);

    await expect(
      runStudioPiOAuthLoginFlow({
        providerId: "anthropic",
        onAuth: () => {},
        onPrompt: async () => "code#state",
      })
    ).rejects.toThrow("OAuth provider did not emit any authentication events.");
  });
});
