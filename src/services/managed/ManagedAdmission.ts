import {
  MANAGED_CAPABILITY_CONTRACT, ManagedCapabilityCatalogContract,
  ManagedLease, ManagedOperation,
} from "./ManagedTypes";
import { HostedTransportAdapter, type HostedLicenseAdmission } from "./adapters/HostedTransportAdapter";

type Options = {
  transport: Pick<HostedTransportAdapter, "getCatalog" | "getAdmission"> & Partial<Pick<HostedTransportAdapter, "onAuthorizationRejected">>;
  licenseKey: () => string;
  now?: () => number;
};
type Cache = { catalog: ManagedCapabilityCatalogContract; licenseKey: string; fetchedAt: number };
type AdmissionCache = { admission: HostedLicenseAdmission; licenseKey: string; checkedAt: number };
const CATALOG_TTL_MS = 300_000;
/** An allowed license admission is reused this long for the same license key. */
const ADMISSION_TTL_MS = 60_000;

/** A cancelled caller must see its own abort, not a temporarily_unavailable lease. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Managed admission was cancelled.", "AbortError");
}

/**
 * The one source of license admission for managed work and license
 * validation (#386). A server-allowed admission is cached for a minute per
 * license key, so a run of managed operations makes one license round trip
 * instead of one each. The cache is dropped when the key changes, when any
 * managed endpoint answers 401 or 403, and whenever a read is not allowed.
 * Concurrent reads share one request in the transport.
 */
export class ManagedAdmission {
  private cache: Cache | null = null;
  private admissionCache: AdmissionCache | null = null;

  constructor(private readonly options: Options) {
    options.transport.onAuthorizationRejected?.(() => this.invalidate());
  }

  /** Forgets the cached admission, e.g. after a 401 or 403 from a job endpoint. */
  invalidate(): void {
    this.admissionCache = null;
  }

  private async catalog(signal?: AbortSignal): Promise<ManagedCapabilityCatalogContract> {
    const now = (this.options.now ?? Date.now)();
    if (this.cache && this.cache.licenseKey === this.options.licenseKey().trim()
      && now < this.cache.fetchedAt + CATALOG_TTL_MS) return this.cache.catalog;
    this.cache = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const licenseKey = this.options.licenseKey().trim();
      const fetchedAt = (this.options.now ?? Date.now)();
      const catalog = await this.options.transport.getCatalog(signal);
      if (catalog.contract_version !== MANAGED_CAPABILITY_CONTRACT || catalog.cache_ttl_seconds !== 300) {
        throw new Error("Managed capability contract drift");
      }
      if (licenseKey !== this.options.licenseKey().trim()) {
        if (attempt === 0) continue;
        throw new Error("Managed capability snapshots changed repeatedly");
      }
      this.cache = { catalog, licenseKey, fetchedAt };
      return catalog;
    }
    throw new Error("Managed capability catalog unavailable");
  }

  /**
   * The license admission for the current key. `fresh` skips the cache (an
   * explicit license validation) but still joins a read already in flight.
   * Rejects when the read fails or the caller aborts.
   */
  async checkLicense(signal?: AbortSignal, options: Readonly<{ fresh?: boolean }> = {}): Promise<HostedLicenseAdmission> {
    throwIfAborted(signal);
    const licenseKey = this.options.licenseKey().trim();
    const cached = this.admissionCache;
    if (
      !options.fresh
      && cached
      && cached.licenseKey === licenseKey
      && (this.options.now ?? Date.now)() < cached.checkedAt + ADMISSION_TTL_MS
    ) {
      return cached.admission;
    }
    const admission = await this.options.transport.getAdmission(signal);
    throwIfAborted(signal);
    if (licenseKey === this.options.licenseKey().trim()) {
      this.admissionCache = admission.outcome === "allowed"
        ? { admission, licenseKey, checkedAt: (this.options.now ?? Date.now)() }
        : null;
    }
    return admission;
  }

  async acquireLease(operation: ManagedOperation, signal?: AbortSignal): Promise<ManagedLease> {
    throwIfAborted(signal);
    let catalog: ManagedCapabilityCatalogContract;
    try { catalog = await this.catalog(signal); } catch {
      throwIfAborted(signal);
      return { outcome: "temporarily_unavailable" };
    }
    const server = await this.checkLicense(signal).catch(() => {
      throwIfAborted(signal);
      return { outcome: "temporarily_unavailable" as const, diagnostics: undefined };
    });
    throwIfAborted(signal);
    if (server.outcome !== "allowed") return { outcome: server.outcome, diagnostics: server.diagnostics };
    const descriptor = catalog.capabilities.find((entry) => entry.alias === operation.alias);
    if (!descriptor || descriptor.availability !== "available" || catalog.status !== "available") return { outcome: "capability_unavailable", descriptor, diagnostics: server.diagnostics };
    const requestContract = operation.requestContract ? descriptor.request_contracts.find((entry) => entry.capability === operation.requestContract) : undefined;
    if (operation.requestContract && !requestContract) return { outcome: "capability_unavailable", descriptor, diagnostics: server.diagnostics };
    return { outcome: "allowed", descriptor, requestContract, diagnostics: server.diagnostics };
  }

  async withLease<T>(operation: ManagedOperation, callback: (lease: ManagedLease) => Promise<T> | T): Promise<T | ManagedLease> {
    const lease = await this.acquireLease(operation);
    return lease.outcome === "allowed" ? callback(lease) : lease;
  }
}
