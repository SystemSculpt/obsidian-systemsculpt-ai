import {
  MANAGED_CAPABILITY_CONTRACT, ManagedCapabilityCatalogContract,
  ManagedLease, ManagedOperation,
} from "./ManagedTypes";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

type Options = {
  transport: Pick<HostedTransportAdapter, "getCatalog" | "getAdmission">;
  licenseKey: () => string;
  now?: () => number;
};
type Cache = { catalog: ManagedCapabilityCatalogContract; licenseKey: string; fetchedAt: number };
const CATALOG_TTL_MS = 300_000;

/** A cancelled caller must see its own abort, not a temporarily_unavailable lease. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Managed admission was cancelled.", "AbortError");
}

export class ManagedAdmission {
  private cache: Cache | null = null;
  constructor(private readonly options: Options) {}

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

  async acquireLease(operation: ManagedOperation, signal?: AbortSignal): Promise<ManagedLease> {
    throwIfAborted(signal);
    let catalog: ManagedCapabilityCatalogContract;
    try { catalog = await this.catalog(signal); } catch {
      throwIfAborted(signal);
      return { outcome: "temporarily_unavailable" };
    }
    const server = await this.options.transport.getAdmission(signal).catch(() => {
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
