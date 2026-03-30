import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const modelRegistryCtorMock = jest.fn();

jest.mock("../PiSdkCore", () => ({
  ModelRegistry: jest.fn().mockImplementation((authStorage: any, modelsPath: string) => {
    modelRegistryCtorMock(authStorage, modelsPath);

    const oauthProviders = authStorage.getOAuthProviders();
    if (!Array.isArray(oauthProviders)) {
      throw new Error("Auth storage getOAuthProviders() must return an array.");
    }

    return {
      getAvailable: jest.fn(() =>
        authStorage.hasAuth("google")
          ? [
              {
                provider: "google",
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                reasoning: true,
                input: ["text"],
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ]
          : [],
      ),
    };
  }),
  SessionManager: {
    create: jest.fn(),
    open: jest.fn(),
  },
  SettingsManager: {
    inMemory: jest.fn(() => ({})),
  },
}));

import { ModelRegistry } from "../PiSdkCore";
import { createBundledPiAuthStorage } from "../PiSdkAuthStorage";

describe("PiSdkAuthStorage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("implements the OAuth-provider contract expected by the Pi model registry", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "systemsculpt-pi-auth-"));
    const authPath = join(tempDir, "auth.json");
    const modelsPath = join(tempDir, "models.json");

    const storage = createBundledPiAuthStorage(authPath);
    storage.set("google", {
      type: "api_key",
      key: "test-key",
    });

    expect(typeof storage.getOAuthProviders).toBe("function");
    expect(Array.isArray(storage.getOAuthProviders())).toBe(true);

    const registry = new ModelRegistry(storage, modelsPath);

    expect(modelRegistryCtorMock).toHaveBeenCalledWith(storage, modelsPath);
    expect(registry.getAvailable()).toEqual([
      expect.objectContaining({
        provider: "google",
        id: "gemini-2.5-flash",
      }),
    ]);
  });
});
