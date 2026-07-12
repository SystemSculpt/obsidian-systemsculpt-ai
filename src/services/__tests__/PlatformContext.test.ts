/**
 * @jest-environment node
 */

import { PlatformContext } from "../PlatformContext";

describe("PlatformContext", () => {
  const originalFetch = global.fetch;

  function resetPlatformContextInstance(): void {
    (PlatformContext as unknown as { instance: PlatformContext | null }).instance = null;
  }

  beforeEach(() => {
    resetPlatformContextInstance();
    PlatformContext.clearFetchAvoidSuffixes();
    global.fetch = originalFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("remains a singleton", () => {
    expect(PlatformContext.initialize()).toBe(PlatformContext.get());
  });

  it("reports the desktop-only plugin capabilities", () => {
    const context = PlatformContext.get();

    expect(context.isMobile()).toBe(false);
    expect(context.runtime()).toBe("desktop");
    expect(context.isDesktopRuntime()).toBe(true);
    expect(context.isMobileRuntime()).toBe(false);
    expect(context.supportsDesktopOnlyFeatures()).toBe(true);
    expect(context.supportsStatusBar()).toBe(true);
    expect(context.supportsEagerVaultWrites()).toBe(true);
    expect(context.supportsNodeApis()).toBe(true);
    expect(context.uiVariant()).toBe("desktop");
  });

  it('prefers "fetch" when no avoid suffix is registered', () => {
    const context = PlatformContext.get();

    expect(context.preferredTransport()).toBe("fetch");
    expect(context.preferredTransport({ endpoint: "https://api.openai.com/v1" })).toBe("fetch");
    expect(context.supportsStreaming({ endpoint: "https://api.openai.com/v1" })).toBe(true);
  });

  it('falls back to "requestUrl" for registered host suffixes', () => {
    PlatformContext.registerFetchAvoidSuffix("example.com");
    const context = PlatformContext.get();

    expect(context.preferredTransport({ endpoint: "https://api.example.com/v1" })).toBe("requestUrl");
    expect(context.supportsStreaming({ endpoint: "https://api.example.com/v1" })).toBe(false);
  });

  it("handles invalid endpoints without throwing", () => {
    const context = PlatformContext.get();

    expect(context.preferredTransport({ endpoint: "not-a-valid-url" })).toBe("fetch");
    expect(context.supportsStreaming({ endpoint: "not-a-valid-url" })).toBe(true);
  });

  it("clears non-default avoid suffixes", () => {
    PlatformContext.registerFetchAvoidSuffix("custom.com");
    PlatformContext.clearFetchAvoidSuffixes();
    const context = PlatformContext.get();

    expect(context.preferredTransport({ endpoint: "https://custom.com/api" })).toBe("fetch");
  });

  it("disables streaming when fetch is unavailable", () => {
    global.fetch = undefined as typeof global.fetch;
    resetPlatformContextInstance();
    const context = PlatformContext.get();

    expect(context.supportsStreaming({ endpoint: "https://api.openai.com/v1" })).toBe(false);
  });
});
