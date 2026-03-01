import {
  loginStudioPiProviderOAuth,
  type StudioPiAuthInfo,
  type StudioPiAuthPrompt,
} from "./StudioPiAuthStorage";

type StudioPiOAuthLoginFlowOptions = {
  providerId: string;
  onAuth: (info: StudioPiAuthInfo) => void | Promise<void>;
  onPrompt: (prompt: StudioPiAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
};

export type StudioPiOAuthLoginFlowResult = {
  sawAuthEvent: boolean;
  sawAuthUrl: boolean;
};

export async function runStudioPiOAuthLoginFlow(
  options: StudioPiOAuthLoginFlowOptions
): Promise<StudioPiOAuthLoginFlowResult> {
  let sawAuthEvent = false;
  let sawAuthUrl = false;

  await loginStudioPiProviderOAuth({
    providerId: options.providerId,
    onAuth: async (info) => {
      sawAuthEvent = true;
      if (String(info.url || "").trim()) {
        sawAuthUrl = true;
      }
      await options.onAuth(info);
    },
    onPrompt: async (prompt) => {
      sawAuthEvent = true;
      return await options.onPrompt(prompt);
    },
    onProgress: (message) => {
      sawAuthEvent = true;
      if (typeof options.onProgress === "function") {
        options.onProgress(message);
      }
    },
    onManualCodeInput: options.onManualCodeInput
      ? async () => {
          sawAuthEvent = true;
          return await options.onManualCodeInput!();
        }
      : undefined,
    signal: options.signal,
  });

  if (!sawAuthEvent) {
    throw new Error("OAuth provider did not emit any authentication events.");
  }

  return {
    sawAuthEvent,
    sawAuthUrl,
  };
}
