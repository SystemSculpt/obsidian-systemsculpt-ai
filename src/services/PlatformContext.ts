export type PlatformTransport = "fetch" | "requestUrl";
export type PlatformRuntime = "desktop" | "mobile";
export type PlatformUIVariant = "mobile" | "desktop";

export interface PlatformTransportOptions {
  endpoint?: string;
}

export class PlatformContext {
  private static instance: PlatformContext | null = null;
  private readonly fetchAvailable: boolean;
  // The managed desktop-only build prefers direct `fetch` by default, while
  // keeping `requestUrl` available as a host-specific fallback.
  private static readonly DEFAULT_FETCH_AVOID_SUFFIXES: string[] = [];
  private static readonly FETCH_AVOID_SUFFIXES = new Set<string>(PlatformContext.DEFAULT_FETCH_AVOID_SUFFIXES);

  private constructor() {
    this.fetchAvailable = typeof fetch === "function";
  }

  public static initialize(): PlatformContext {
    if (!PlatformContext.instance) {
      PlatformContext.instance = new PlatformContext();
    }
    return PlatformContext.instance;
  }

  public static get(): PlatformContext {
    return PlatformContext.initialize();
  }

  public static registerFetchAvoidSuffix(suffix: string): void {
    if (!suffix) return;
    PlatformContext.FETCH_AVOID_SUFFIXES.add(suffix.toLowerCase());
  }

  public static clearFetchAvoidSuffixes(): void {
    PlatformContext.FETCH_AVOID_SUFFIXES.clear();
    for (const suffix of PlatformContext.DEFAULT_FETCH_AVOID_SUFFIXES) {
      PlatformContext.FETCH_AVOID_SUFFIXES.add(suffix);
    }
  }

  public isMobile(): boolean {
    return false;
  }

  public runtime(): PlatformRuntime {
    return "desktop";
  }

  public isDesktopRuntime(): boolean {
    return true;
  }

  public isMobileRuntime(): boolean {
    return false;
  }

  public supportsDesktopOnlyFeatures(): boolean {
    return true;
  }

  public supportsStatusBar(): boolean {
    return true;
  }

  public supportsEagerVaultWrites(): boolean {
    return true;
  }

  /**
   * The desktop-only plugin manifest guarantees a Node-capable Electron runtime.
   * Keep this seam so callers still route Node-only imports through the shared
   * boundary in `src/platform/desktopOnly.ts`.
   */
  public supportsNodeApis(): boolean {
    return true;
  }

  public uiVariant(): PlatformUIVariant {
    return "desktop";
  }

  public preferredTransport(options: PlatformTransportOptions = {}): PlatformTransport {
    const { endpoint } = options;
    const avoidFetch = this.shouldAvoidDirectFetch(endpoint);

    if (avoidFetch) {
      return "requestUrl";
    }
    return "fetch";
  }

  public supportsStreaming(options: PlatformTransportOptions = {}): boolean {
    if (!this.fetchAvailable) {
      return false;
    }
    const avoidFetch = this.shouldAvoidDirectFetch(options.endpoint);
    return !avoidFetch;
  }

  private shouldAvoidDirectFetch(endpoint?: string): boolean {
    if (!endpoint) {
      return false;
    }

    try {
      const host = new URL(endpoint).host;
      const lcHost = host.toLowerCase();
      const avoid = Array.from(PlatformContext.FETCH_AVOID_SUFFIXES).some((suffix) => lcHost.endsWith(suffix));
      return avoid;
    } catch {
      return false;
    }
  }
}
