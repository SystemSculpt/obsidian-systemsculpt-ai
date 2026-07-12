import type { AcceptedManagedChatOperation } from "../../../services/managed/ManagedTypes";
import type { AcceptedManagedChatRequestSnapshot } from "../../../services/chat/AcceptedChatRequestSnapshot";
import type { StreamEvent } from "../../../streaming/types";
import type { ChatTranscriptSnapshot } from "../transcript/ChatTranscriptTypes";
import type { ChatTurnFence } from "./ChatTurnEffects";
import {
  ManagedChatRuntimeAdapter,
  translateManagedChatEvents,
  type ManagedChatDiagnostic,
} from "./ManagedChatRuntimeAdapter";

export type ManagedChatRecoveryDisposition =
  | "operation_in_progress"
  | "operation_already_completed"
  | "operation_terminal"
  | "settlement_pending";

export type CurrentRuntimeDispatchInput = Readonly<{
  operation: AcceptedManagedChatOperation;
  acceptedRequestSnapshot: AcceptedManagedChatRequestSnapshot;
  phase: "initial" | "continuation";
  continuationIndex: number;
  postCheckpointDurableSnapshot?: ChatTranscriptSnapshot;
  signal: AbortSignal;
  fence: Pick<ChatTurnFence, "isOpen">;
}>;

export type CurrentRuntimeDispatchResult =
  | Readonly<{ kind: "stream"; events: AsyncGenerator<StreamEvent>; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: "recovery"; disposition: ManagedChatRecoveryDisposition; diagnostic: ManagedChatDiagnostic }>;

export type ManagedChatRuntimeFailureKind =
  | "transport_failure"
  | "aborted"
  | "capability_request"
  | "license"
  | "credits"
  | "plugin_version"
  | "rate_limit"
  | "unavailable"
  | "empty";

export class ManagedChatRuntimeFailure extends Error {
  constructor(
    public readonly kind: ManagedChatRuntimeFailureKind,
    public readonly diagnostic: ManagedChatDiagnostic,
  ) {
    super(`Managed Chat dispatch failed (${kind}).`);
    this.name = "ManagedChatRuntimeFailure";
  }
}

function isRecoveryDisposition(value: string): value is ManagedChatRecoveryDisposition {
  return value === "operation_in_progress"
    || value === "operation_already_completed"
    || value === "operation_terminal"
    || value === "settlement_pending";
}

/** The production runtime seam for standard Chat. It has no provider/environment switch. */
export class CurrentRuntimeAdapter {
  constructor(private readonly managed: ManagedChatRuntimeAdapter) {}

  public async dispatch(input: CurrentRuntimeDispatchInput): Promise<CurrentRuntimeDispatchResult> {
    if (
      input.acceptedRequestSnapshot.operation !== input.operation ||
      input.signal.aborted ||
      !input.fence.isOpen(input.operation)
    ) {
      throw new ManagedChatRuntimeFailure("aborted", {});
    }
    const result = await this.managed.dispatch({
      operation: input.operation,
      acceptedRequestSnapshot: input.acceptedRequestSnapshot,
      phase: input.phase,
      continuationIndex: input.continuationIndex,
      ...(input.postCheckpointDurableSnapshot
        ? { postCheckpointDurableSnapshot: input.postCheckpointDurableSnapshot }
        : {}),
      signal: input.signal,
    });
    if (input.signal.aborted || !input.fence.isOpen(input.operation)) {
      throw new ManagedChatRuntimeFailure("aborted", result.diagnostic);
    }
    if (result.kind === "success") {
      return {
        kind: "stream",
        events: translateManagedChatEvents(result.events, input.signal, input.fence),
        diagnostic: result.diagnostic,
      };
    }
    if (isRecoveryDisposition(result.kind)) {
      return {
        kind: "recovery",
        disposition: result.kind,
        diagnostic: result.diagnostic,
      };
    }
    throw new ManagedChatRuntimeFailure(result.kind, result.diagnostic);
  }

  public notifyDurablyTerminal(operation: AcceptedManagedChatOperation): void {
    this.managed.notifyDurablyTerminal(operation);
  }
}
