import { isMutatingTool } from "../../utils/toolPolicy";
import { canonicalAgentToolInput } from "./MutationJournal";
import type { AgentJsonValue } from "./Protocol";

type VaultAction = Readonly<{ callId: string; name: string; input: AgentJsonValue }>;

export type VaultActionDecision = Readonly<{
  approvalId: string;
  approved: boolean;
  source: "manual" | "policy";
}>;

type ActionRecord = {
  readonly name: string;
  readonly canonicalInput: string;
  approvalId?: string;
  decision?: VaultActionDecision;
};

/**
 * One run's local authority to execute vault actions. Server approval state
 * cannot grant this authority. Call identities and approval bindings are
 * immutable once observed; a decision can only be recorded once for its exact
 * binding. Callers never synchronize identity, forward and reverse approval,
 * binding, and decision maps themselves.
 */
export class VaultActionAuthorization {
  private readonly actions = new Map<string, ActionRecord>();
  private readonly approvals = new Map<string, string>();

  public observe(call: VaultAction): boolean {
    const existing = this.actions.get(call.callId);
    if (existing) return this.matches(call);
    this.actions.set(call.callId, {
      name: call.name,
      canonicalInput: canonicalAgentToolInput(call.input),
    });
    return true;
  }

  public bindApproval(callId: string, approvalId: string): boolean {
    const action = this.actions.get(callId);
    const existingCall = this.approvals.get(approvalId);
    if (!action || !approvalId
      || (action.approvalId !== undefined && action.approvalId !== approvalId)
      || (existingCall !== undefined && existingCall !== callId)) return false;
    action.approvalId = approvalId;
    this.approvals.set(approvalId, callId);
    return true;
  }

  public state(callId: string): Readonly<{
    approvalId?: string;
    decision?: VaultActionDecision;
  }> {
    const action = this.actions.get(callId);
    return { approvalId: action?.approvalId, decision: action?.decision };
  }

  public callForApproval(approvalId: string): string | undefined {
    return this.approvals.get(approvalId);
  }

  public decide(
    approvalId: string,
    approved: boolean,
    source: "manual" | "policy",
  ): VaultActionDecision | undefined {
    const callId = this.approvals.get(approvalId);
    const action = callId === undefined ? undefined : this.actions.get(callId);
    if (!action || action.decision || action.approvalId !== approvalId) return undefined;
    const decision = Object.freeze({ approvalId, approved, source });
    action.decision = decision;
    return decision;
  }

  public matches(call: VaultAction): boolean {
    const action = this.actions.get(call.callId);
    return action !== undefined && action.name === call.name
      && action.canonicalInput === canonicalAgentToolInput(call.input);
  }

  public allows(call: VaultAction): boolean {
    if (!isMutatingTool(call.name)) return true;
    return this.matches(call) && this.actions.get(call.callId)?.decision?.approved === true;
  }
}
