import type { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

export type HostedCatalogCacheOptions = Readonly<{ licenseKey?: () => string; now?: () => number }>;
const CACHE_TTL_MS = 5 * 60_000;

/** One owner for server catalog requests, account changes, and invalidation. */
export class HostedCatalogCache<T> {
  private license = "";
  private generation = 0;
  private pending: Promise<T> | undefined;
  private cached: { value: T; expiresAt: number } | undefined;

  constructor(
    private readonly transport: Pick<HostedTransportAdapter, "request">,
    private readonly kind: "Image" | "Video",
    private readonly parse: (value: unknown) => T,
    private readonly options: HostedCatalogCacheOptions = {},
  ) {}

  peek(): T | null {
    this.syncLicense();
    return this.cached && this.cached.expiresAt > this.now() ? this.cached.value : null;
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.pending = undefined;
  }

  load(): Promise<T> {
    const cached = this.peek();
    if (cached !== null) return Promise.resolve(cached);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.read().then(value => {
      this.syncLicense();
      if (generation !== this.generation) throw new Error("The model catalog changed while loading. Refresh and try again.");
      this.cached = { value, expiresAt: this.now() + CACHE_TTL_MS };
      return value;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private syncLicense(): void {
    const license = this.options.licenseKey?.().trim() ?? "";
    if (license === this.license) return;
    this.license = license;
    this.invalidate();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async read(): Promise<T> {
    const result = await this.transport.request({ path: `/api/plugin/${this.kind.toLowerCase()}s/models`, method: "GET" });
    if (!result.response.ok) throw new Error(`${this.kind} models are unavailable (${result.response.status}). Check your license and connection.`);
    return this.parse(await result.response.json());
  }
}
