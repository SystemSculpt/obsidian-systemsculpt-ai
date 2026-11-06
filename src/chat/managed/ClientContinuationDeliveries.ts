import type { AgentJsonValue } from './Protocol';
import type { LocalToolCall } from './WireConversation';
import type { VaultActionDecision } from './VaultActionAuthorization';

type ToolDelivery = {
  readonly requestId: string;
  readonly call: LocalToolCall;
  readonly toolExecutionOrdinal?: number;
  readonly state: 'output-available' | 'output-error';
  readonly output?: AgentJsonValue;
  readonly errorText?: string;
};
type ApprovalDecision = VaultActionDecision & Readonly<{ requestId: string; callId: string }>;

class DeliveryState {
  private attemptedEpoch: number | null = null;
  private sending = false;
  private ack = false;
  private ackRecorded = false;
  get attemptedOpenEpoch(): number | null { return this.attemptedEpoch; }
  get inFlight(): boolean { return this.sending; }
  get acknowledged(): boolean { return this.ack; }

  canAttempt(epoch: number): boolean { return !this.sending && this.attemptedEpoch !== epoch; }
  begin(epoch: number): void { this.attemptedEpoch = epoch; this.ack = false; this.sending = true; }
  retryAfterSynchronization(): void { this.attemptedEpoch = null; }
  finish(): void { this.sending = false; }
  acknowledge(epoch: number): boolean | null {
    if (!this.sending || this.attemptedEpoch !== epoch) return null;
    this.ack = true;
    const first = !this.ackRecorded;
    this.ackRecorded = true;
    return first;
  }
}

export type PendingToolDelivery = ToolDelivery & DeliveryState;
export type PendingApprovalDelivery = { readonly decision: ApprovalDecision } & DeliveryState;
type PendingDelivery = PendingToolDelivery | PendingApprovalDelivery;

type DeliveryAttempt = Readonly<{
  /** Re-check current managed session projection and authorization before each dispatch. */
  prepare: () => (() => Promise<void>) | undefined;
  isActive: () => boolean;
  reconcile: () => void;
  publish: () => void;
  markUnsynchronized: () => void;
  reportError: (error: unknown) => void;
  streamCompleted?: () => void;
  streamFailed?: () => void;
}>;

/** Retains exact managed client continuations across uncertain stream delivery. */
export class ClientContinuationDeliveries {
  private readonly retainedResults = new Map<string, PendingToolDelivery>();
  private readonly retainedApprovals = new Map<string, PendingApprovalDelivery>();
  get results(): ReadonlyMap<string, PendingToolDelivery> { return this.retainedResults; }
  get approvals(): ReadonlyMap<string, PendingApprovalDelivery> { return this.retainedApprovals; }
  private openEpoch = 0;
  opened(): void { this.openEpoch += 1; }

  retainResult(input: ToolDelivery): PendingToolDelivery {
    const delivery = Object.assign(new DeliveryState(), input);
    this.retainedResults.set(input.call.callId, delivery);
    return delivery;
  }

  retainApproval(decision: ApprovalDecision): PendingApprovalDelivery {
    const delivery = Object.assign(new DeliveryState(), { decision });
    this.retainedApprovals.set(decision.callId, delivery);
    return delivery;
  }

  clear(): void {
    this.retainedResults.clear();
    this.retainedApprovals.clear();
  }

  acknowledgeResult(callId: string, requestId: string): { delivery: PendingToolDelivery; first: boolean } | null {
    const delivery = this.results.get(callId);
    if (!delivery || delivery.requestId !== requestId) return null;
    const first = delivery.acknowledge(this.openEpoch);
    return first === null ? null : { delivery, first };
  }

  acknowledgeApproval(callId: string, requestId: string): { delivery: PendingApprovalDelivery; first: boolean } | null {
    const delivery = this.approvals.get(callId);
    if (!delivery || delivery.decision.requestId !== requestId) return null;
    const first = delivery.acknowledge(this.openEpoch);
    return first === null ? null : { delivery, first };
  }

  /** ACK alone never retires a command: the caller must prove its exact authoritative projection. */
  reconcile(requestId: string, matches: {
    result: (delivery: PendingToolDelivery) => boolean;
    approval: (delivery: PendingApprovalDelivery) => boolean;
  }): void {
    for (const [callId, delivery] of this.results) {
      if (delivery.requestId === requestId && delivery.acknowledged && matches.result(delivery)) this.retainedResults.delete(callId);
    }
    for (const [callId, delivery] of this.approvals) {
      if (delivery.decision.requestId === requestId && delivery.acknowledged && matches.approval(delivery)) this.retainedApprovals.delete(callId);
    }
  }

  async deliver(delivery: PendingDelivery, attempt: DeliveryAttempt): Promise<void> {
    if (!this.retains(delivery) || !delivery.canAttempt(this.openEpoch)) return;
    const send = attempt.prepare();
    if (!send || !this.retains(delivery)) return;
    const epoch = this.openEpoch;
    delivery.begin(epoch);
    attempt.publish();
    try {
      await send();
      attempt.reconcile();
      // Replacement synchronization intentionally resolves an old reader. It
      // is not a clean stream close in the new epoch and cannot retire work.
      if (this.openEpoch !== epoch) return;
      attempt.streamCompleted?.();
      if (attempt.isActive() && this.retains(delivery)) {
        // ACK is delivery, not continuation authority. Retain the exact payload
        // after ACK-only EOF and obtain a fresh snapshot before bounded replay.
        delivery.retryAfterSynchronization();
        attempt.markUnsynchronized();
      }
    } catch (error) {
      attempt.reconcile();
      if (this.openEpoch === epoch) attempt.streamFailed?.();
      if (attempt.isActive() && this.retains(delivery)) {
        delivery.retryAfterSynchronization();
        attempt.reportError(error);
      }
    } finally {
      delivery.finish();
      if (attempt.isActive()) attempt.publish();
      if (attempt.isActive() && this.retains(delivery) && this.openEpoch !== epoch) {
        // Re-enter the full projection/authorization preflight, never just resend.
        await this.deliver(delivery, attempt);
      }
    }
  }

  private retains(delivery: PendingDelivery): boolean {
    return 'decision' in delivery ? this.approvals.get(delivery.decision.callId) === delivery
      : this.results.get(delivery.call.callId) === delivery;
  }
}
