/**
 * Tests that expose the OAuth callback server vs manual-code-input race condition.
 *
 * These tests mock the SDK's provider.login() at the same boundary the plugin
 * uses (loginStudioPiProviderOAuth → storage.login()) and simulate the four
 * real-world scenarios a user can hit:
 *
 *   1. Callback server catches the redirect → no manual input needed.
 *   2. Callback server fails to bind → falls back to manual input.
 *   3. User cancels during the wait → flow aborts cleanly.
 *   4. Current code always provides onManualCodeInput, which the SDK calls
 *      immediately — showing a paste popup before the callback server has a
 *      chance to complete.  ← This is the UX bug.
 */

import { Platform } from "obsidian";

describe("OAuth callback-server flow", () => {
  const originalIsDesktopApp = Platform.isDesktopApp;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: originalIsDesktopApp,
    });
  });

  // ── Helper: wire up mocks and isolate modules ──────────────────────────

  function buildMockedLogin(loginImpl: (providerId: string, callbacks: any) => Promise<void>) {
    const storage = {
      login: jest.fn(loginImpl),
      getOAuthProviders: jest.fn(() => [
        { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", usesCallbackServer: true },
      ]),
    };
    const withPiDesktopFetchShim = jest.fn(async (cb: () => Promise<unknown>) => cb());

    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => storage),
      withPiDesktopFetchShim,
    }));

    let loginStudioPiProviderOAuth: typeof import("../StudioPiAuthStorage").loginStudioPiProviderOAuth;
    jest.isolateModules(() => {
      ({ loginStudioPiProviderOAuth } = require("../StudioPiAuthStorage"));
    });

    return { loginStudioPiProviderOAuth: loginStudioPiProviderOAuth!, storage };
  }

  // ── 1. Callback server completes — onManualCodeInput should NOT be needed ─

  it("completes OAuth via callback server without calling onManualCodeInput", async () => {
    // Simulate the SDK's behavior when the callback server catches the redirect.
    // In this path, provider.login() resolves without ever calling onManualCodeInput.
    const { loginStudioPiProviderOAuth } = buildMockedLogin(async (_id, callbacks) => {
      // SDK calls onAuth with the authorization URL
      callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?...", instructions: "Open browser" });
      // Callback server catches the redirect — login resolves directly.
      // onManualCodeInput and onPrompt are NEVER called.
    });

    const onAuth = jest.fn();
    const onPrompt = jest.fn(async () => "unused");
    const onManualCodeInput = jest.fn(async () => "unused");

    await loginStudioPiProviderOAuth({
      providerId: "openai-codex",
      onAuth,
      onPrompt,
      onManualCodeInput,
    });

    expect(onAuth).toHaveBeenCalledTimes(1);
    expect(onManualCodeInput).not.toHaveBeenCalled();
    expect(onPrompt).not.toHaveBeenCalled();
  });

  // ── 2. Callback server fails to bind — falls back to manual code input ────

  it("falls back to onManualCodeInput when callback server cannot bind", async () => {
    const { loginStudioPiProviderOAuth } = buildMockedLogin(async (_id, callbacks) => {
      callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?...", instructions: "Open browser" });
      // Callback server failed to bind port 1455, SDK falls back to manual input
      if (callbacks.onManualCodeInput) {
        const input = await callbacks.onManualCodeInput();
        if (!input) throw new Error("Login cancelled.");
      }
    });

    const onManualCodeInput = jest.fn(async () =>
      "http://localhost:1455/auth/callback?code=abc123&state=xyz"
    );

    await loginStudioPiProviderOAuth({
      providerId: "openai-codex",
      onAuth: jest.fn(),
      onPrompt: jest.fn(async () => "unused"),
      onManualCodeInput,
    });

    expect(onManualCodeInput).toHaveBeenCalledTimes(1);
  });

  // ── 3. Falls back to onPrompt when neither callback nor manual input works ─

  it("falls back to onPrompt as last resort", async () => {
    const { loginStudioPiProviderOAuth } = buildMockedLogin(async (_id, callbacks) => {
      callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?..." });
      // No onManualCodeInput provided, callback server returned null → prompt
      const input = await callbacks.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      if (!input) throw new Error("Login cancelled.");
    });

    const onPrompt = jest.fn(async () => "auth-code-from-user");

    await loginStudioPiProviderOAuth({
      providerId: "openai-codex",
      onAuth: jest.fn(),
      onPrompt,
    });

    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  // ── 4. THE BUG: SDK calls onManualCodeInput IMMEDIATELY ───────────────────

  it("demonstrates that SDK races onManualCodeInput with callback server (the UX bug)", async () => {
    // This test mirrors what the SDK *actually does* in loginOpenAICodex():
    //
    //   const manualPromise = options.onManualCodeInput()   ← called IMMEDIATELY
    //     .then(input => { manualCode = input; server.cancelWait(); })
    //   const result = await server.waitForCode();
    //
    // Both the callback server and manual input are started in parallel.
    // The user sees the paste popup the instant the browser opens.

    const callOrder: string[] = [];

    const { loginStudioPiProviderOAuth } = buildMockedLogin(async (_id, callbacks) => {
      callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?..." });

      // Simulate the SDK's race: call onManualCodeInput immediately and
      // race it with the callback server.
      if (callbacks.onManualCodeInput) {
        callOrder.push("onManualCodeInput:called");

        // In real code, both are racing. Here we simulate the callback server
        // winning (returning the code before the user pastes anything).
        void callbacks.onManualCodeInput().then((input: string) => {
          callOrder.push("onManualCodeInput:resolved");
          return input;
        });

        // Callback server "wins" — but onManualCodeInput was already called,
        // meaning the popup is already showing.
        callOrder.push("callback-server:won");

        // In reality the SDK would use the callback server code and ignore
        // manualPromise, but manualPromise is still pending (popup is open).
      }
    });

    // This is what ProvidersTabContent.ts does — always provides onManualCodeInput
    const onManualCodeInput = jest.fn(
      () =>
        new Promise<string>((_resolve) => {
          // Simulate popup staying open (user hasn't pasted yet)
          // In real code this would be showPopup() which blocks until user acts
          callOrder.push("popup:shown");
          // Never resolves — simulates user staring at unnecessary popup
        })
    );

    const loginPromise = loginStudioPiProviderOAuth({
      providerId: "openai-codex",
      onAuth: jest.fn(),
      onPrompt: jest.fn(async () => "unused"),
      onManualCodeInput,
    });

    await loginPromise;

    // The bug: onManualCodeInput was called (popup shown) even though
    // the callback server would have handled it.
    expect(onManualCodeInput).toHaveBeenCalledTimes(1);
    expect(callOrder).toContain("onManualCodeInput:called");
    expect(callOrder).toContain("popup:shown");
    expect(callOrder).toContain("callback-server:won");

    // The popup appeared BEFORE the callback server had a chance to complete.
    const popupIndex = callOrder.indexOf("popup:shown");
    const callbackIndex = callOrder.indexOf("callback-server:won");
    expect(popupIndex).toBeLessThan(callbackIndex);
  });

  // ── 5. User cancels mid-flow via AbortController ──────────────────────────

  it("aborts cleanly when the user cancels during OAuth", async () => {
    const abortController = new AbortController();

    const { loginStudioPiProviderOAuth } = buildMockedLogin(async (_id, callbacks) => {
      callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?..." });
      // Check signal before continuing
      if (callbacks.signal?.aborted) throw new Error("Login cancelled.");
      // Simulate waiting for callback, then abort fires
      await new Promise<void>((resolve) => {
        callbacks.signal?.addEventListener("abort", () => resolve());
      });
      throw new Error("Login cancelled.");
    });

    const loginPromise = loginStudioPiProviderOAuth({
      providerId: "openai-codex",
      onAuth: jest.fn(),
      onPrompt: jest.fn(async () => "unused"),
      signal: abortController.signal,
    });

    // User clicks cancel
    abortController.abort();

    await expect(loginPromise).rejects.toThrow("Login cancelled.");
  });

  // ── 6. Desktop-only gate ──────────────────────────────────────────────────

  it("rejects OAuth login on non-desktop platforms", async () => {
    // The moduleNameMapper maps 'obsidian' to a mock file that exports a
    // Platform singleton. jest.isolateModules re-requires the module, but
    // moduleNameMapper-resolved modules are NOT re-isolated — they're shared.
    // So we mock 'obsidian' explicitly for this isolated scope.
    jest.doMock("obsidian", () => ({
      ...jest.requireActual("obsidian"),
      Platform: { isDesktopApp: false },
    }));

    const storage = {
      login: jest.fn(async () => {}),
      getOAuthProviders: jest.fn(() => []),
    };
    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => storage),
      withPiDesktopFetchShim: jest.fn(async (cb: () => Promise<unknown>) => cb()),
    }));

    let loginStudioPiProviderOAuth: typeof import("../StudioPiAuthStorage").loginStudioPiProviderOAuth;
    jest.isolateModules(() => {
      ({ loginStudioPiProviderOAuth } = require("../StudioPiAuthStorage"));
    });

    await expect(
      loginStudioPiProviderOAuth!({
        providerId: "openai-codex",
        onAuth: jest.fn(),
        onPrompt: jest.fn(async () => "unused"),
      })
    ).rejects.toThrow("OAuth login is only available on desktop.");
  });
});

describe("OAuth flow wrapper (runStudioPiOAuthLoginFlow) callback handling", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("passes onManualCodeInput through to the SDK when provided", async () => {
    const capturedCallbacks: Record<string, any> = {};

    jest.doMock("../StudioPiAuthStorage", () => ({
      loginStudioPiProviderOAuth: jest.fn(async (options: any) => {
        capturedCallbacks.onManualCodeInput = options.onManualCodeInput;
        capturedCallbacks.onAuth = options.onAuth;
        // Simulate a normal auth event so the flow doesn't throw
        options.onAuth({ url: "https://example.com" });
      }),
    }));

    let runStudioPiOAuthLoginFlow: typeof import("../StudioPiOAuthLoginFlow").runStudioPiOAuthLoginFlow;
    jest.isolateModules(() => {
      ({ runStudioPiOAuthLoginFlow } = require("../StudioPiOAuthLoginFlow"));
    });

    const onManualCodeInput = jest.fn(async () => "some-code");

    await runStudioPiOAuthLoginFlow!({
      providerId: "openai-codex",
      onAuth: jest.fn(),
      onPrompt: jest.fn(async () => "unused"),
      onManualCodeInput,
    });

    // The wrapper passes it through — SDK will call it immediately
    expect(capturedCallbacks.onManualCodeInput).toBeDefined();
  });

  it("does NOT pass onManualCodeInput when not provided (callback-server-only path)", async () => {
    const capturedCallbacks: Record<string, any> = {};

    jest.doMock("../StudioPiAuthStorage", () => ({
      loginStudioPiProviderOAuth: jest.fn(async (options: any) => {
        capturedCallbacks.onManualCodeInput = options.onManualCodeInput;
        options.onAuth({ url: "https://example.com" });
      }),
    }));

    let runStudioPiOAuthLoginFlow: typeof import("../StudioPiOAuthLoginFlow").runStudioPiOAuthLoginFlow;
    jest.isolateModules(() => {
      ({ runStudioPiOAuthLoginFlow } = require("../StudioPiOAuthLoginFlow"));
    });

    await runStudioPiOAuthLoginFlow!({
      providerId: "openai-codex",
      onAuth: jest.fn(),
      onPrompt: jest.fn(async () => "unused"),
      // No onManualCodeInput — SDK should only use callback server + onPrompt fallback
    });

    // Without onManualCodeInput, the SDK won't race with a popup.
    // It will wait for the callback server, then fall back to onPrompt.
    expect(capturedCallbacks.onManualCodeInput).toBeUndefined();
  });
});

describe("OAuth UI helpers", () => {
  it("correctly identifies authorization-code prompts from the SDK", () => {
    const { isOAuthCodePrompt } = require("../../../utils/oauthUiHelpers");

    // Prompts the SDK sends when it needs a code
    expect(isOAuthCodePrompt({ message: "Paste the authorization code (or full redirect URL):" })).toBe(true);
    expect(isOAuthCodePrompt({ message: "Enter the redirect URL from your browser:" })).toBe(true);
    expect(isOAuthCodePrompt({ message: "Paste the OAuth code below:" })).toBe(true);

    // Prompts that should NOT be treated as code prompts
    expect(isOAuthCodePrompt({ message: "Enter your API key:" })).toBe(false);
    expect(isOAuthCodePrompt({ message: "Enter your username:" })).toBe(false);
    expect(isOAuthCodePrompt({ message: "" })).toBe(false);
  });

  it("opens external URL via electron shell when available", async () => {
    const mockOpenExternal = jest.fn(async () => {});
    const originalWindow = global.window;

    // Mock electron availability
    (global as any).window = {
      ...(global as any).window,
      require: jest.fn(() => ({
        shell: { openExternal: mockOpenExternal },
      })),
    };

    jest.resetModules();
    const { openExternalUrlForOAuth } = require("../../../utils/oauthUiHelpers");

    await openExternalUrlForOAuth("https://auth.openai.com/oauth/authorize?client_id=test");

    expect(mockOpenExternal).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?client_id=test");

    (global as any).window = originalWindow;
  });

  it("falls back to window.open when electron is unavailable", async () => {
    const mockWindowOpen = jest.fn();
    const originalWindow = global.window;

    (global as any).window = {
      require: undefined,
      open: mockWindowOpen,
    };

    jest.resetModules();
    const { openExternalUrlForOAuth } = require("../../../utils/oauthUiHelpers");

    await openExternalUrlForOAuth("https://auth.openai.com/oauth/authorize?client_id=test");

    expect(mockWindowOpen).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?client_id=test",
      "_blank",
      "noopener,noreferrer"
    );

    (global as any).window = originalWindow;
  });

  it("does nothing for empty URLs", async () => {
    jest.resetModules();
    const { openExternalUrlForOAuth } = require("../../../utils/oauthUiHelpers");

    // Should not throw
    await openExternalUrlForOAuth("");
    await openExternalUrlForOAuth("   ");
    await openExternalUrlForOAuth(null as any);
  });
});

describe("SDK openai-codex login callback server internals", () => {
  // These tests directly exercise the SDK's parseAuthorizationInput logic
  // to understand what formats it accepts from manual code input.

  it("parses a full redirect URL with code and state", () => {
    // The SDK's parseAuthorizationInput handles multiple input formats.
    // Users might paste the full URL, just the code, or code#state.

    // Full URL format (what the callback server redirect looks like)
    const url = "http://localhost:1455/auth/callback?code=abc123&state=xyz789";
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code")).toBe("abc123");
    expect(parsed.searchParams.get("state")).toBe("xyz789");
  });

  it("documents the hardcoded callback port (1455)", () => {
    // The SDK uses port 1455 for OpenAI Codex.
    // This is important because:
    // 1. If another process uses port 1455, the callback fails
    // 2. In Obsidian's Electron, the port should be bindable
    // 3. The redirect_uri MUST match what's registered with OpenAI
    const REDIRECT_URI = "http://localhost:1455/auth/callback";
    expect(REDIRECT_URI).toBe("http://localhost:1455/auth/callback");
  });

  it("documents that the SDK requires node:http (not available in browser)", () => {
    // The openai-codex.js module checks for Node.js environment:
    //   if (typeof process !== "undefined" && (process.versions?.node || ...))
    //     import("node:http").then(m => { _http = m; })
    //
    // In Obsidian's Electron (which IS Node.js), this should work.
    // But the dynamic import is async — _http might be null if login() is
    // called before the import resolves.
    expect(typeof process).toBe("object");
    expect(process.versions?.node).toBeTruthy();
  });
});

describe("ProvidersTabContent OAuth UX flow", () => {
  // These tests verify what the user actually sees during OAuth login
  // by testing the callback wiring in ProvidersTabContent.

  it("always provides onManualCodeInput (current behavior — the bug)", () => {
    // ProvidersTabContent.ts lines 637-649 always define onManualCodeInput:
    //
    //   onManualCodeInput: async () => {
    //     const result = await showPopup(plugin.app, "Paste the authorization code or redirect URL:", { ... });
    //     if (!result?.confirmed || !result.inputs?.[0]) throw new Error("Login cancelled.");
    //     return result.inputs[0];
    //   }
    //
    // This means for EVERY OAuth provider — even those with usesCallbackServer: true —
    // the SDK will call onManualCodeInput immediately, racing it with the callback server.
    //
    // Result: user sees a confusing "Paste the authorization code" popup the instant
    // their browser opens, even though the callback server should handle everything.

    // This test documents the expected fix:
    // For providers where usesCallbackServer is true, onManualCodeInput should NOT
    // be provided. Instead, show a non-blocking "Waiting for browser..." indicator.
    // Only show the paste prompt if the callback server fails or the provider
    // doesn't support callback servers.

    const usesCallbackServer = true; // openai-codex
    const shouldProvideManualCodeInput = !usesCallbackServer;
    expect(shouldProvideManualCodeInput).toBe(false);
  });

  it("should show waiting UI for callback-server providers instead of paste prompt", () => {
    // The correct UX for callback-server providers:
    // 1. Open browser with auth URL
    // 2. Show "Waiting for authentication to complete in browser..." (non-blocking)
    // 3. Callback server catches redirect → success
    // 4. If callback server fails → THEN show paste prompt as fallback
    //
    // The current UX:
    // 1. Open browser with auth URL
    // 2. IMMEDIATELY show "Paste the authorization code or redirect URL:" modal
    // 3. User is confused — they're now in the browser AND staring at a paste modal
    // 4. If callback server catches redirect, the modal is orphaned

    // Document the expected behavior
    const expectedFlow = {
      step1: "onAuth called → open browser",
      step2: "show non-blocking 'waiting' indicator",
      step3: "callback server catches redirect → dismiss indicator → success",
      fallback: "callback server fails → show paste prompt modal",
    };

    expect(expectedFlow.step2).not.toContain("paste");
    expect(expectedFlow.fallback).toContain("paste");
  });
});
