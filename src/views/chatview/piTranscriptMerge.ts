import type { ChatMessage } from "../../types";

function serializeComparableContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

function messagesEqual(
  left: Pick<ChatMessage, "role" | "content" | "message_id" | "pi_entry_id">,
  right: Pick<ChatMessage, "role" | "content" | "message_id" | "pi_entry_id">,
): boolean {
  const leftPiEntryId = String(left.pi_entry_id || "").trim();
  const rightPiEntryId = String(right.pi_entry_id || "").trim();
  if (leftPiEntryId && rightPiEntryId) {
    return leftPiEntryId === rightPiEntryId;
  }

  if (String(left.role || "") !== String(right.role || "")) {
    return false;
  }

  return serializeComparableContent(left.content) === serializeComparableContent(right.content);
}

function findSuffixPrefixOverlapStart(
  currentMessages: ChatMessage[],
  snapshotMessages: ChatMessage[],
): number {
  let bestStart = -1;
  let bestOverlap = 0;

  for (let start = 0; start < currentMessages.length; start += 1) {
    let overlap = 0;

    while (
      start + overlap < currentMessages.length &&
      overlap < snapshotMessages.length &&
      messagesEqual(currentMessages[start + overlap], snapshotMessages[overlap])
    ) {
      overlap += 1;
    }

    if (overlap > 0 && start + overlap === currentMessages.length && overlap > bestOverlap) {
      bestStart = start;
      bestOverlap = overlap;
    }
  }

  return bestStart;
}

export function mergePiTranscriptMessages(
  currentMessages: ChatMessage[],
  snapshotMessages: ChatMessage[],
  options?: { hadSyncedPiTranscript?: boolean },
): ChatMessage[] {
  if (snapshotMessages.length === 0) {
    return [...currentMessages];
  }

  const overlapStart = findSuffixPrefixOverlapStart(currentMessages, snapshotMessages);
  if (overlapStart >= 0) {
    return [...currentMessages.slice(0, overlapStart), ...snapshotMessages];
  }

  if (!options?.hadSyncedPiTranscript && currentMessages.length > 0) {
    return [...currentMessages, ...snapshotMessages];
  }

  return [...snapshotMessages];
}
