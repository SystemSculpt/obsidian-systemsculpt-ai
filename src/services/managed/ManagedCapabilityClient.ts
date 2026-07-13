import { ManagedAdmission } from "./ManagedAdmission";
import {
  ManagedTextGenerationAdapter,
  type ManagedTextGenerationOperation,
} from "./ManagedTextGenerationAdapter";
import { HostedTransportAdapter, type ManagedChatTransportTicket } from "./adapters/HostedTransportAdapter";
import {
  ManagedAdmissionOutcome, ManagedAllowedLease, ManagedCapabilityAlias, ManagedChatLeaseResult, ManagedLease,
  ManagedRequestContractId, ManagedTransportOperation, ManagedTransportResult,
} from "./ManagedTypes";
import {
  managedChatInputLimitsFromCatalog,
  type ManagedChatInputLimits,
} from "./ManagedChatInputLimits";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    deepFreeze((value as Record<PropertyKey, object | null | string | number | boolean | undefined>)[key], seen);
  }
  return Object.freeze(value);
}

function isAllowedChatLease(lease: ManagedLease): lease is ManagedAllowedLease {
  return lease.outcome === "allowed" && lease.descriptor?.alias === "systemsculpt/chat"
    && lease.requestContract?.capability === "chat_turn" && lease.descriptor.request_contracts.includes(lease.requestContract);
}

type ClientOperation = {
  alias: ManagedCapabilityAlias;
  requestContract?: ManagedRequestContractId;
  body?: () => unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export class ManagedCapabilityClient {
  private readonly textGeneration: ManagedTextGenerationAdapter;

  constructor(private readonly dependencies: { admission: ManagedAdmission; transport: HostedTransportAdapter }) {
    this.textGeneration = new ManagedTextGenerationAdapter(dependencies);
  }
  getCatalog() { return this.dependencies.transport.getCatalog(); }
  async getChatInputLimits(): Promise<ManagedChatInputLimits> {
    return managedChatInputLimitsFromCatalog(await this.getCatalog());
  }
  getAdmission() { return this.dependencies.transport.getAdmission(); }
  request(operation: ClientOperation) { return this.execute("request", operation); }
  stream(operation: ClientOperation) { return this.execute("stream", operation); }
  job(operation: ClientOperation) { return this.execute("job", operation); }
  generateText(operation: ManagedTextGenerationOperation) { return this.textGeneration.generate(operation); }
  public beginAcceptedChatDispatch(): ManagedChatTransportTicket | null {
    return this.dependencies.transport.beginManagedChatDispatch();
  }

  public streamAcceptedChat(
    ticket: ManagedChatTransportTicket,
    lease: ManagedAllowedLease,
    body: Readonly<Record<string, import("./ManagedTypes").JsonContractValue>>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ManagedTransportResult> {
    if (
      lease.outcome !== "allowed" || lease.descriptor.alias !== "systemsculpt/chat" ||
      lease.descriptor.mode !== "stream" || lease.descriptor.endpoint !== "/api/v1/chat/completions" ||
      lease.descriptor.cancellation_supported !== false || lease.requestContract.capability !== "chat_turn" ||
      lease.requestContract.background_eligible !== false || lease.requestContract.cancellation_supported !== false ||
      !lease.descriptor.request_contracts.includes(lease.requestContract) ||
      lease.requestContract.request?.path !== "/api/v1/chat/completions" || lease.requestContract.request.method !== "POST"
    ) {
      return Promise.reject(new Error("Accepted managed Chat lease does not match the required contract."));
    }
    return this.dependencies.transport.streamAcceptedChat(ticket, {
      path: lease.requestContract.request.path,
      method: lease.requestContract.request.method,
      capability: lease.requestContract.capability,
      idempotencyKey,
      body,
      signal,
    });
  }

  async acquireChatTurnLease(): Promise<ManagedChatLeaseResult> {
    const lease = await this.dependencies.admission.acquireLease({ alias: "systemsculpt/chat", requestContract: "chat_turn" });
    if (!isAllowedChatLease(lease)) return { outcome: lease.outcome === "allowed" ? "capability_unavailable" : lease.outcome, lease };
    deepFreeze(lease);
    return Object.freeze({ outcome: "allowed", lease });
  }

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
