import { MobileDetection } from "../utils/MobileDetection";

export type PlatformTransport = "fetch" | "requestUrl";
export type PlatformUIVariant = "mobile" | "desktop";

export interface PlatformTransportOptions {
  endpoint?: string;
}

export class PlatformContext {
  private static instance: PlatformContext | null = null;
  private readonly mobileDetection = MobileDetection.getInstance();
  private readonly fetchAvailable: boolean;
  private static readonly DEFAULT_FETCH_AVOID_SUFFIXES = ["openrouter.ai", "systemsculpt.com"];
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
    return this.mobileDetection.isMobileDevice();
  }

  public uiVariant(): PlatformUIVariant {
    return this.isMobile() ? "mobile" : "desktop";
  }

  public preferredTransport(options: PlatformTransportOptions = {}): PlatformTransport {
    const { endpoint } = options;
    const isMobile = this.isMobile();
    const avoidFetch = this.shouldAvoidDirectFetch(endpoint);
    try {
      console.debug('[SystemSculpt][PlatformContext] preferredTransport decision', {
        endpoint,
        isMobile,
        avoidFetch,
        fetchAvailable: this.fetchAvailable
      });
    } catch {}

    if (isMobile || avoidFetch) {
      return "requestUrl";
    }
    return "fetch";
  }

  public supportsStreaming(options: PlatformTransportOptions = {}): boolean {
    if (!this.fetchAvailable) {
      try {
        console.debug('[SystemSculpt][PlatformContext] supportsStreaming=false (fetch unavailable)', {
          endpoint: options.endpoint,
          fetchAvailable: this.fetchAvailable
        });
      } catch {}
      return false;
    }
    const isMobile = this.isMobile();
    if (isMobile) {
      try {
        console.debug('[SystemSculpt][PlatformContext] supportsStreaming=false (mobile)', {
          endpoint: options.endpoint
        });
      } catch {}
      return false;
    }
    const avoidFetch = this.shouldAvoidDirectFetch(options.endpoint);
    const canStream = !avoidFetch;
    try {
      console.debug('[SystemSculpt][PlatformContext] supportsStreaming decision', {
        endpoint: options.endpoint,
        avoidFetch,
        result: canStream
      });
    } catch {}
    return canStream;
  }

  public getDeviceInfo() {
    return this.mobileDetection.getDeviceInfo();
  }

  public getDetection(): MobileDetection {
    return this.mobileDetection;
  }

  private shouldAvoidDirectFetch(endpoint?: string): boolean {
    if (!endpoint) {
      return false;
    }

    try {
      const host = new URL(endpoint).host;
      const lcHost = host.toLowerCase();
      const avoid = Array.from(PlatformContext.FETCH_AVOID_SUFFIXES).some((suffix) => lcHost.endsWith(suffix));
      if (avoid) {
        try {
          console.debug('[SystemSculpt][PlatformContext] avoiding direct fetch for host', { host });
        } catch {}
      }
      return avoid;
    } catch {
      return false;
    }
  }
}
