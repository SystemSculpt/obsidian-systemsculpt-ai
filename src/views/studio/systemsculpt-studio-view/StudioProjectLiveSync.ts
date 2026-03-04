export type StudioProjectModifyDecision =
  | {
      kind: "ignore";
      reason: "inactive_project" | "self_write" | "duplicate_accepted" | "duplicate_rejected";
    }
  | {
      kind: "defer";
      reason: "local_save_pending";
    }
  | {
      kind: "evaluate";
    };

type ResolveStudioProjectModifyDecisionOptions = {
  isActiveProjectFile: boolean;
  hasPendingLocalSaveWork: boolean;
  isExpectedSelfWrite: boolean;
  signature: string;
  lastAcceptedSignature: string | null;
  lastRejectedSignature: string | null;
};

const DEFAULT_EXPECTED_SIGNATURE_LIMIT = 12;

export function computeStudioProjectTextSignature(rawText: string): string {
  const text = String(rawText || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length.toString(16)}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function trackExpectedStudioProjectWriteSignature(
  signatures: Set<string>,
  signature: string,
  options?: { maxEntries?: number }
): void {
  const normalized = String(signature || "").trim();
  if (!normalized) {
    return;
  }
  signatures.delete(normalized);
  signatures.add(normalized);
  const maxEntries = Math.max(1, Math.floor(options?.maxEntries || DEFAULT_EXPECTED_SIGNATURE_LIMIT));
  while (signatures.size > maxEntries) {
    const oldest = signatures.values().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    signatures.delete(oldest);
  }
}

export function consumeExpectedStudioProjectWriteSignature(
  signatures: Set<string>,
  signature: string
): boolean {
  const normalized = String(signature || "").trim();
  if (!normalized) {
    return false;
  }
  const present = signatures.has(normalized);
  if (present) {
    signatures.delete(normalized);
  }
  return present;
}

export function resolveStudioProjectModifyDecision(
  options: ResolveStudioProjectModifyDecisionOptions
): StudioProjectModifyDecision {
  if (!options.isActiveProjectFile) {
    return {
      kind: "ignore",
      reason: "inactive_project",
    };
  }
  if (options.isExpectedSelfWrite) {
    return {
      kind: "ignore",
      reason: "self_write",
    };
  }
  if (options.hasPendingLocalSaveWork) {
    return {
      kind: "defer",
      reason: "local_save_pending",
    };
  }
  if (options.lastAcceptedSignature && options.lastAcceptedSignature === options.signature) {
    return {
      kind: "ignore",
      reason: "duplicate_accepted",
    };
  }
  if (options.lastRejectedSignature && options.lastRejectedSignature === options.signature) {
    return {
      kind: "ignore",
      reason: "duplicate_rejected",
    };
  }
  return {
    kind: "evaluate",
  };
}
