import { createManagedRequestId } from "./ManagedRequestId";
import type { ManagedJobRecoveryStore } from "./ManagedJobRecoveryStore";
import type { ManagedJobRecoveryRecord, ManagedMultipartCreateRequest, ManagedPendingDispatch } from "./ManagedTypes";

/** Persists dispatch identity before transport; replay keeps the recorded identity. */
export class ManagedJobDispatch {
  constructor(
    private readonly recovery: Pick<ManagedJobRecoveryStore, "beginDispatch">,
    private readonly createRequestId: () => string = () => createManagedRequestId("dispatch"),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  begin(
    record: ManagedJobRecoveryRecord,
    operation: ManagedPendingDispatch["operation"],
    partNumber?: number,
    createRequest?: ManagedMultipartCreateRequest,
  ): Promise<ManagedJobRecoveryRecord> {
    return this.recovery.beginDispatch(record.capability, record.operationId, record.revision, {
      operation,
      requestId: this.createRequestId(),
      ...(partNumber === undefined ? {} : { partNumber }),
      ...(createRequest === undefined ? {} : { createRequest }),
      ...(["create", "complete", "start"].includes(operation) ? { idempotencyKey: `${record.operationId}:${operation}` } : {}),
      dispatchedAt: this.now(),
    });
  }
}
