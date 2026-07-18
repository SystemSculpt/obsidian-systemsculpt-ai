import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { ManagedLocalCommitReceipt } from "../managed/ManagedTypes";
import { sha256HexFromBytesPortable } from "../../studio/hash";

const UTF8 = new TextEncoder();

/**
 * The durable output named by a managed receipt was removed or changed after
 * it was committed. Callers may safely preserve the user's version and begin
 * a fresh operation; transport and vault-read failures must continue to
 * propagate instead of being mistaken for an intentional local edit.
 */
export class LocalCommitReceiptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalCommitReceiptMismatchError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Transcription was cancelled locally.", "AbortError");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createLocalCommitReceipt(
  outputPath: string,
  storedContent: string,
  marker?: string | null,
): ManagedLocalCommitReceipt {
  const contentSha256 = sha256HexFromBytesPortable(UTF8.encode(storedContent));
  return marker
    ? { kind: "marker", outputPath, contentSha256, marker }
    : { kind: "exact", outputPath, contentSha256 };
}

export async function verifyLocalCommitReceipt(
  app: App,
  receipt: ManagedLocalCommitReceipt,
  signal?: AbortSignal,
): Promise<Readonly<{ file: TFile; storedContent: string }>> {
  throwIfAborted(signal);
  const file = app.vault.getAbstractFileByPath(receipt.outputPath);
  if (!(file instanceof TFile)) {
    throw new LocalCommitReceiptMismatchError("The saved transcript output is missing.");
  }

  const storedContent = await app.vault.read(file);
  throwIfAborted(signal);
  const digest = sha256HexFromBytesPortable(UTF8.encode(storedContent));
  if (digest !== receipt.contentSha256) {
    throw new LocalCommitReceiptMismatchError(
      "The saved transcript output no longer matches its recovery receipt.",
    );
  }
  if (receipt.kind === "marker") {
    if (!receipt.marker || !storedContent.includes(receipt.marker)) {
      throw new LocalCommitReceiptMismatchError(
        "The saved transcript output lost its recovery marker.",
      );
    }
  }
  return { file, storedContent };
}

export function stripLocalCommitMarker(
  storedContent: string,
  receipt: ManagedLocalCommitReceipt,
): string {
  if (receipt.kind !== "marker") return storedContent;
  if (!receipt.marker) throw new Error("The local recovery marker is missing.");
  const markerSuffix = new RegExp(`\\n*${escapeRegExp(receipt.marker)}\\n?$`);
  return storedContent.replace(markerSuffix, "").trimEnd();
}
