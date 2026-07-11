import { ManagedAdmission } from "./ManagedAdmission";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";
import {
  ManagedAdmissionOutcome, ManagedCapabilityAlias, ManagedLease,
  ManagedRequestContractId, ManagedTransportOperation,
} from "./ManagedTypes";

type ClientOperation = {
  alias: ManagedCapabilityAlias;
  requestContract?: ManagedRequestContractId;
  body?: () => unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export class ManagedCapabilityClient {
  constructor(private readonly dependencies: { admission: ManagedAdmission; transport: HostedTransportAdapter }) {}
  getCatalog() { return this.dependencies.transport.getCatalog(); }
  getAdmission() { return this.dependencies.transport.getAdmission(); }
  request(operation: ClientOperation) { return this.execute("request", operation); }
  stream(operation: ClientOperation) { return this.execute("stream", operation); }
  job(operation: ClientOperation) { return this.execute("job", operation); }

  private execute(kind: "request" | "stream" | "job", operation: ClientOperation) {
    return this.dependencies.admission.withLease(
      { alias: operation.alias, requestContract: operation.requestContract },
      async (lease) => {
        const transportOperation = this.bindLease(kind, operation, lease);
        if (!transportOperation) {
          return { outcome: "capability_unavailable" as ManagedAdmissionOutcome };
        }
        return this.dependencies.transport[kind]({
          ...transportOperation,
          idempotencyKey: operation.idempotencyKey,
          signal: operation.signal,
          body: operation.body?.(),
        });
      },
    );
  }

  private bindLease(
    kind: "request" | "stream" | "job",
    operation: ClientOperation,
    lease: ManagedLease,
  ): ManagedTransportOperation | null {
    const descriptor = lease.descriptor;
    if (!descriptor || descriptor.alias !== operation.alias || descriptor.mode !== kind) return null;

    if (operation.requestContract) {
      const contract = lease.requestContract;
      if (
        !contract || contract.capability !== operation.requestContract ||
        !descriptor.request_contracts.includes(contract) || !contract.request ||
        contract.request.path !== descriptor.endpoint || contract.request.method.length === 0
      ) return null;
      return { path: contract.request.path, method: contract.request.method, capability: contract.capability };
    }

    if (lease.requestContract || descriptor.request_contracts.length > 0 || kind !== "job") return null;
    return { path: descriptor.endpoint, method: "POST" };
  }
}
