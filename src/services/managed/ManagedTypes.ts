export const MANAGED_CAPABILITY_CONTRACT = "managed-capabilities-v2" as const;
export const MANAGED_ADMISSION_CONTRACT = "admission-v1" as const;

export type ManagedCapabilityAlias =
  | "systemsculpt/chat"
  | "systemsculpt/embeddings"
  | "systemsculpt/transcription"
  | "systemsculpt/documents"
  | "systemsculpt/images";
export type ManagedRequestContractId = "chat_turn" | "text_generation" | "embeddings";
export type ManagedMode = "stream" | "request" | "job";
export type ManagedAvailability = "available" | "unavailable";
export type ManagedServerOutcome = "allowed" | "license_required" | "license_rejected" | "temporarily_unavailable" | "rate_limited";
export type ManagedAdmissionOutcome = ManagedServerOutcome | "disclosure_required" | "capability_unavailable";
export type ManagedDisclosureAcceptance = { version: string; acceptedAt: string };

export type JsonContractValue = string | number | boolean | null | JsonContractValue[] | { [key: string]: JsonContractValue };

export interface ManagedPurposeContract { presence: "forbidden" | "required"; values: string[]; }
export interface ManagedWireRequestContract {
  method: string;
  path: string;
  required_headers: string[];
  body: { [key: string]: JsonContractValue };
  definitions?: { [key: string]: JsonContractValue };
}
export interface ManagedWireResponseContract { [key: string]: JsonContractValue; }
export interface ManagedWireErrorContract { [key: string]: JsonContractValue; }
export interface ManagedNestedRequestContract {
  capability: ManagedRequestContractId;
  header: "x-systemsculpt-capability";
  header_value: ManagedRequestContractId;
  background_eligible: boolean;
  purpose?: ManagedPurposeContract;
  cancellation_supported?: boolean;
  request?: ManagedWireRequestContract;
  response?: ManagedWireResponseContract;
  errors?: ManagedWireErrorContract;
}
export interface ManagedCapabilityDescriptor {
  alias: ManagedCapabilityAlias;
  endpoint: string;
  mode: ManagedMode;
  availability: ManagedAvailability;
  auth: "license";
  metering: "metered_turn" | "metered_operation" | "metered_job";
  cancellation_supported: boolean;
  background_eligible: boolean;
  limits: Record<string, string | number | boolean>;
  request_contracts: ManagedNestedRequestContract[];
}
export interface ManagedCapabilityCatalogContract {
  contract_version: typeof MANAGED_CAPABILITY_CONTRACT;
  status: "available" | "temporarily_unavailable";
  disclosure_version: string | null;
  cache_ttl_seconds: number;
  capabilities: ManagedCapabilityDescriptor[];
}
export interface ManagedAdmissionContractResponse {
  status: number; code: ManagedServerOutcome; message: string;
  reasons?: string[]; retryable?: boolean; grace_eligible?: boolean;
}
export interface ManagedAdmissionContract {
  contract_version: typeof MANAGED_ADMISSION_CONTRACT;
  negotiation_header: { name: "x-systemsculpt-admission-contract"; value: typeof MANAGED_ADMISSION_CONTRACT };
  responses: Record<ManagedServerOutcome, ManagedAdmissionContractResponse>;
  required_response_headers: string[];
  conditional_response_headers: Record<string, ManagedServerOutcome[]>;
  forbidden_response_fields: string[];
}
export interface ManagedOperation { alias: ManagedCapabilityAlias; requestContract?: ManagedRequestContractId; }
export interface ManagedLease { outcome: ManagedAdmissionOutcome; descriptor?: ManagedCapabilityDescriptor; requestContract?: ManagedNestedRequestContract; diagnostics?: ManagedResponseDiagnostics; }
export interface ManagedResponseDiagnostics {
  status: number; requestId: string | null; contentType: string | null;
  rateLimitLimit: string | null; rateLimitRemaining: string | null; rateLimitReset: string | null;
  retryAfter: string | null; errorText: string;
}
export interface ManagedTransportResult { response: Response; diagnostics: ManagedResponseDiagnostics; }
export interface ManagedTransportOperation {
  path: string; method?: string; body?: unknown; capability?: ManagedRequestContractId;
  idempotencyKey?: string; headers?: Record<string, string>; signal?: AbortSignal;
}

export type ManagedJobCapability = "transcription" | "document_processing" | "image_generation";
export type ManagedJobStatus = "uploading" | "queued" | "processing" | "succeeded" | "completed" | "failed" | "expired";
export type ManagedRecoveryPhase =
  | "admitted" | "content_ready" | "prepare_dispatching" | "prepared" | "create_dispatching" | "created"
  | "part_dispatching" | "uploading" | "abort_dispatching" | "upload_aborted" | "complete_dispatching"
  | "upload_completed" | "start_dispatching" | "processing" | "result_ready" | "local_commit_pending"
  | "completed" | "blocked_ambiguous" | "abandoned";
export interface ManagedPendingDispatch {
  operation: "prepare" | "create" | "part" | "abort" | "complete" | "start";
  requestId: string; idempotencyKey?: string; partNumber?: number; dispatchedAt: string;
}
export interface ManagedJobRecoveryRecord {
  schemaVersion: 1; revision: number; capability: ManagedJobCapability; operationId: string;
  source: { identity: string; fingerprint: string }; jobId?: string;
  completedParts?: Array<{ partNumber: number; etag: string }>;
  phase: ManagedRecoveryPhase; pendingDispatch?: ManagedPendingDispatch;
  createdAt: string; updatedAt: string;
}
