import type { ChatMessage } from "../../types";
import type { AgentTranscriptSnapshot as ChatTranscriptSnapshot } from "../../views/chatview/AgentTranscriptRepository";

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
export type ManagedAdmissionOutcome = ManagedServerOutcome | "capability_unavailable";

export type JsonContractValue = string | number | boolean | null | readonly JsonContractValue[] | { readonly [key: string]: JsonContractValue };

export interface ManagedPurposeContract { readonly presence: "forbidden" | "required"; readonly values: readonly string[]; }
export interface ManagedWireRequestContract {
  readonly method: string;
  readonly path: string;
  readonly required_headers: readonly string[];
  readonly body: Readonly<{ [key: string]: JsonContractValue }>;
  readonly definitions?: Readonly<{ [key: string]: JsonContractValue }>;
}
export interface ManagedWireResponseContract { readonly [key: string]: JsonContractValue; }
export interface ManagedWireErrorContract { readonly [key: string]: JsonContractValue; }
export interface ManagedNestedRequestContract {
  readonly capability: ManagedRequestContractId;
  readonly header: "x-systemsculpt-capability";
  readonly header_value: ManagedRequestContractId;
  readonly background_eligible: boolean;
  readonly purpose?: ManagedPurposeContract;
  readonly cancellation_supported?: boolean;
  readonly request?: ManagedWireRequestContract;
  readonly response?: ManagedWireResponseContract;
  readonly errors?: ManagedWireErrorContract;
}
export interface ManagedEmbeddingGenerationDescriptor {
  readonly id: string;
  readonly index_schema_version: number;
  readonly index_namespace: string;
}
export interface ManagedCapabilityDescriptor {
  readonly alias: ManagedCapabilityAlias;
  readonly endpoint: string;
  readonly mode: ManagedMode;
  readonly availability: ManagedAvailability;
  readonly auth: "license";
  readonly metering: "metered_turn" | "metered_operation" | "metered_job";
  readonly cancellation_supported: boolean;
  readonly background_eligible: boolean;
  readonly limits: Readonly<Record<string, string | number | boolean>>;
  /** Present only for generation-sensitive semantic embeddings. */
  readonly generation?: ManagedEmbeddingGenerationDescriptor;
  readonly request_contracts: readonly ManagedNestedRequestContract[];
}
export interface ManagedCapabilityCatalogContract {
  contract_version: typeof MANAGED_CAPABILITY_CONTRACT;
  status: "available" | "temporarily_unavailable";
  disclosure_version: string | null;
  cache_ttl_seconds: number;
  capabilities: ManagedCapabilityDescriptor[];
}
export type ManagedChatSessionBudgetState = Readonly<{
  messageCount: number;
  imageCount: number;
  attachmentBytes: number;
  storedJsonBytes: number;
}>;
export interface ManagedAdmissionContractResponse {
  status: number; code: ManagedServerOutcome; message: string;
  reasons?: string[]; retryable?: boolean; grace_eligible?: boolean;
}
export interface ManagedAdmissionContract {
  contract_version: typeof MANAGED_ADMISSION_CONTRACT;
  negotiation_header: { name: "x-systemsculpt-admission-contract"; value: typeof MANAGED_ADMISSION_CONTRACT };
  responses: Record<ManagedServerOutcome, ManagedAdmissionContractResponse>;
  required_response_body_fields: string[];
  required_response_headers: string[];
  conditional_response_headers: Record<string, ManagedServerOutcome[]>;
  forbidden_response_fields: string[];
}
export interface ManagedOperation { alias: ManagedCapabilityAlias; requestContract?: ManagedRequestContractId; }
export interface ManagedLease { outcome: ManagedAdmissionOutcome; descriptor?: ManagedCapabilityDescriptor; requestContract?: ManagedNestedRequestContract; diagnostics?: ManagedResponseDiagnostics; }
export interface ManagedAllowedLease extends ManagedLease { readonly outcome: "allowed"; readonly descriptor: ManagedCapabilityDescriptor; readonly requestContract: ManagedNestedRequestContract; }
export type ManagedChatLeaseResult =
  | Readonly<{ outcome: "allowed"; lease: ManagedAllowedLease }>
  | Readonly<{ outcome: Exclude<ManagedAdmissionOutcome, "allowed">; lease: ManagedLease }>;
export interface ManagedChatAdmissionPort { acquireChatTurnLease(): Promise<ManagedChatLeaseResult>; }
export type AcceptedChatOperationBase = Readonly<{
  durableTurnId: string;
  acceptedUserMessage: Readonly<ChatMessage>;
  initialDurableSnapshot: ChatTranscriptSnapshot;
  turnBoundaryId: string;
}>;
export type AcceptedManagedChatOperation = AcceptedChatOperationBase & Readonly<{
  runtime: "managed";
  lease: ManagedAllowedLease;
}>;
export type AcceptedChatOperation = AcceptedManagedChatOperation;
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
export type ManagedImageOutputMetadata = Readonly<{
  index: number;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
}>;
export type ManagedImageOutputBytes = Readonly<{ metadata: ManagedImageOutputMetadata; bytes: ArrayBuffer }>;
export type ManagedJobStatus = "uploading" | "queued" | "processing" | "succeeded" | "completed" | "failed" | "expired";
export type ManagedRecoveryPhase =
  | "admitted" | "content_ready" | "prepare_dispatching" | "prepared" | "create_dispatching" | "created"
  | "part_dispatching" | "uploading" | "abort_dispatching" | "upload_aborted" | "complete_dispatching"
  | "upload_completed" | "start_dispatching" | "processing" | "result_ready" | "local_commit_pending"
  | "completed" | "blocked_ambiguous" | "abandoned";
export interface ManagedMultipartCreateRequest {
  filename: string;
  contentType: string;
  contentLengthBytes: number;
  timestamped?: boolean;
  language?: string;
}
export interface ManagedMultipartUploadDescriptor {
  createRequest: ManagedMultipartCreateRequest;
  partSizeBytes: number;
  totalParts: number;
}
export interface ManagedPendingDispatch {
  operation: "prepare" | "create" | "part" | "abort" | "complete" | "start";
  requestId: string;
  idempotencyKey?: string;
  partNumber?: number;
  dispatchedAt: string;
  createRequest?: ManagedMultipartCreateRequest;
}
export interface ManagedLocalCommitReceipt {
  kind: "marker" | "exact";
  outputPath: string;
  contentSha256: string;
  marker?: string;
}
export interface ManagedJobRecoveryRecord {
  schemaVersion: 1; revision: number; capability: ManagedJobCapability; operationId: string;
  source: { identity: string; fingerprint: string }; jobId?: string;
  multipartUpload?: ManagedMultipartUploadDescriptor;
  completedParts?: Array<{ partNumber: number; etag: string }>;
  phase: ManagedRecoveryPhase; pendingDispatch?: ManagedPendingDispatch;
  localCommitReceipt?: ManagedLocalCommitReceipt;
  createdAt: string; updatedAt: string;
}
