import {
  MANAGED_CAPABILITY_CONTRACT, ManagedCapabilityCatalogContract, ManagedDisclosureAcceptance,
  ManagedLease, ManagedOperation,
} from "./ManagedTypes";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

type Options = {
  transport: Pick<HostedTransportAdapter, "getCatalog" | "getAdmission">;
  licenseKey: () => string;
  disclosureAcceptance: () => ManagedDisclosureAcceptance | null;
  now?: () => number;
};
type Snapshot = { licenseKey: string; disclosure: string; contractVersion: string };
type Cache = { catalog: ManagedCapabilityCatalogContract; snapshots: Snapshot; fetchedAt: number };
const CATALOG_TTL_MS = 300_000;

export class ManagedAdmission {
  private cache: Cache | null = null;
  constructor(private readonly options: Options) {}

  private disclosureSnapshot(): string { return JSON.stringify(this.options.disclosureAcceptance()); }
  private snapshot(): Snapshot {
    return {
      licenseKey: this.options.licenseKey().trim(),
      disclosure: this.disclosureSnapshot(),
      contractVersion: MANAGED_CAPABILITY_CONTRACT,
    };
  }
  private sameSnapshot(left: Snapshot, right: Snapshot): boolean {
    return left.licenseKey === right.licenseKey
      && left.disclosure === right.disclosure
      && left.contractVersion === right.contractVersion;
  }
  private cacheMatches(now: number): boolean {
    if (!this.cache) return false;
    const matches = this.sameSnapshot(this.cache.snapshots, this.snapshot());
    if (!matches || now >= this.cache.fetchedAt + CATALOG_TTL_MS) { this.cache = null; return false; }
    return true;
  }

  private async catalog(): Promise<ManagedCapabilityCatalogContract> {
    if (this.cacheMatches((this.options.now ?? Date.now)())) return this.cache!.catalog;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshots = this.snapshot();
      const fetchedAt = (this.options.now ?? Date.now)();
      const catalog = await this.options.transport.getCatalog();
      if (catalog.contract_version !== MANAGED_CAPABILITY_CONTRACT || catalog.cache_ttl_seconds !== 300) {
        throw new Error("Managed capability contract drift");
      }
      if (!this.sameSnapshot(snapshots, this.snapshot())) {
        if (attempt === 0) continue;
        throw new Error("Managed capability snapshots changed repeatedly");
      }
      this.cache = { catalog, snapshots, fetchedAt };
      return catalog;
    }
    throw new Error("Managed capability catalog unavailable");
  }

  async acquireLease(operation: ManagedOperation): Promise<ManagedLease> {
    let catalog: ManagedCapabilityCatalogContract;
    try { catalog = await this.catalog(); } catch { return { outcome: "temporarily_unavailable" }; }
    const server = await this.options.transport.getAdmission().catch(() => ({ outcome: "temporarily_unavailable" as const, diagnostics: undefined }));
    if (server.outcome !== "allowed") return { outcome: server.outcome, diagnostics: server.diagnostics };
    const descriptor = catalog.capabilities.find((entry) => entry.alias === operation.alias);
    if (!descriptor || descriptor.availability !== "available" || catalog.status !== "available") return { outcome: "capability_unavailable", descriptor, diagnostics: server.diagnostics };
    const requestContract = operation.requestContract ? descriptor.request_contracts.find((entry) => entry.capability === operation.requestContract) : undefined;
    if (operation.requestContract && !requestContract) return { outcome: "capability_unavailable", descriptor, diagnostics: server.diagnostics };
    const acceptance = this.options.disclosureAcceptance();
    if (catalog.disclosure_version !== null && (!acceptance || acceptance.version !== catalog.disclosure_version)) {
      return { outcome: "disclosure_required", descriptor, requestContract, diagnostics: server.diagnostics };
    }
    return { outcome: "allowed", descriptor, requestContract, diagnostics: server.diagnostics };
  }

  async withLease<T>(operation: ManagedOperation, callback: (lease: ManagedLease) => Promise<T> | T): Promise<T | ManagedLease> {
    const lease = await this.acquireLease(operation);
    return lease.outcome === "allowed" ? callback(lease) : lease;
  }
}
