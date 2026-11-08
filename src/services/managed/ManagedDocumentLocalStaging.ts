import type SystemSculptPlugin from "../../main";
import { sha256HexFromArrayBuffer } from "../../utils/sha256";
import { throwIfManagedAborted } from "./ManagedAbort";
import { ManagedLocalStaging } from "./ManagedLocalStaging";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type ManagedDocumentStagedArtifactKind = "markdown" | "image";

export interface ManagedDocumentStagedArtifact {
  id: string;
  kind: ManagedDocumentStagedArtifactKind;
  byteLength: number;
  sha256: string;
}

interface ManagedDocumentStagingManifest {
  schemaVersion: 1;
  operationHash: string;
  sequence: number;
  phase: "staging" | "ready";
  artifacts: ManagedDocumentStagedArtifact[];
}

export interface ManagedDocumentStagingTestSeam {
  digest?: (bytes: ArrayBuffer) => Promise<string>;
}

/** @internal Tests match this error class. */
export class ManagedDocumentLocalStagingError extends Error {
  constructor(
    public readonly code: "local_staging_corrupt" | "invalid_staging_request",
    message: string
  ) {
    super(message);
    this.name = "ManagedDocumentLocalStagingError";
  }
}

/** Owns the historical document staging format and recovery metadata. */
export class ManagedDocumentLocalStaging {
  private readonly storage: ManagedLocalStaging<ManagedDocumentStagingManifest>;
  private readonly digest: (bytes: ArrayBuffer) => Promise<string>;

  constructor(plugin: SystemSculptPlugin, testSeam: ManagedDocumentStagingTestSeam = {}) {
    this.digest = testSeam.digest ?? sha256HexFromArrayBuffer;
    this.storage = new ManagedLocalStaging(plugin, {
      directory: ".managed-document-staging",
      isManifest,
      digest: this.digest,
      error: (code, message) => new ManagedDocumentLocalStagingError(
        code === "staging_corrupt" ? "local_staging_corrupt" : code,
        message ?? "Invalid document staging request.",
      ),
    });
  }

  async stage(
    operationId: string,
    artifacts: ReadonlyArray<{ kind: ManagedDocumentStagedArtifactKind; bytes: ArrayBuffer }>,
    signal?: AbortSignal
  ): Promise<ManagedDocumentStagedArtifact[]> {
    throwIfManagedAborted(signal);
    if (!operationId || artifacts.length === 0) invalidRequest();
    const operationHash = await this.operationHash(operationId, signal);
    const manifest = await this.storage.stage(
      operationHash,
      this.artifacts(artifacts, signal),
      (sequence, phase, metadata) => ({ schemaVersion: 1, operationHash, sequence, phase, artifacts: metadata }),
      { signal },
    );
    return manifest.artifacts;
  }

  async readVerified(
    operationId: string,
    expected: ReadonlyArray<ManagedDocumentStagedArtifact>,
    signal?: AbortSignal
  ): Promise<ArrayBuffer[]> {
    const operationHash = await this.operationHash(operationId, signal);
    if (expected.length === 0 || !expected.every(isArtifact)) corrupt("Document staging metadata is invalid.");
    let manifest: ManagedDocumentStagingManifest | null;
    try {
      manifest = await this.storage.findManifest(operationHash, candidate =>
        candidate.phase === "ready" && JSON.stringify(candidate.artifacts) === JSON.stringify(expected), signal);
    } catch (error) {
      throwIfManagedAborted(signal);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      corrupt("Document staging manifest is missing or corrupt.");
    }
    if (!manifest) corrupt("Document staging manifest does not match recovery metadata.");

    const bytes: ArrayBuffer[] = [];
    for (const artifact of expected) {
      bytes.push(await this.storage.readVerified(operationHash, artifact.id, artifact, signal));
    }
    return bytes;
  }

  async cleanup(operationId: string, signal?: AbortSignal): Promise<void> {
    const operationHash = await this.operationHash(operationId, signal);
    await this.storage.cleanup(operationHash, signal);
  }

  private async operationHash(operationId: string, signal?: AbortSignal): Promise<string> {
    throwIfManagedAborted(signal);
    const operationHash = await this.digest(new TextEncoder().encode(operationId).buffer);
    throwIfManagedAborted(signal);
    return operationHash;
  }

  private async *artifacts(
    artifacts: ReadonlyArray<{ kind: ManagedDocumentStagedArtifactKind; bytes: ArrayBuffer }>,
    signal?: AbortSignal,
  ) {
    for (let index = 0; index < artifacts.length; index += 1) {
      throwIfManagedAborted(signal);
      const artifact = artifacts[index];
      if (artifact.kind !== "markdown" && artifact.kind !== "image") invalidRequest();
      const sha256 = await this.digest(artifact.bytes);
      throwIfManagedAborted(signal);
      const id = await this.digest(new TextEncoder().encode(
        `managed-document-artifact-v1\0${index}\0${artifact.kind}\0${sha256}`
      ).buffer);
      throwIfManagedAborted(signal);
      const metadata = { id, kind: artifact.kind, byteLength: artifact.bytes.byteLength, sha256 };
      yield { name: id, bytes: artifact.bytes, metadata };
    }
  }
}

function isManifest(value: unknown, operationHash: string): value is ManagedDocumentStagingManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<ManagedDocumentStagingManifest>;
  return manifest.schemaVersion === 1
    && manifest.operationHash === operationHash
    && Number.isInteger(manifest.sequence)
    && (manifest.sequence as number) > 0
    && (manifest.phase === "staging" || manifest.phase === "ready")
    && Array.isArray(manifest.artifacts)
    && manifest.artifacts.every(isArtifact);
}

function isArtifact(value: unknown): value is ManagedDocumentStagedArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Partial<ManagedDocumentStagedArtifact>;
  return typeof artifact.id === "string" && HASH_PATTERN.test(artifact.id)
    && typeof artifact.sha256 === "string" && HASH_PATTERN.test(artifact.sha256)
    && (artifact.kind === "markdown" || artifact.kind === "image")
    && Number.isInteger(artifact.byteLength) && (artifact.byteLength as number) >= 0;
}

function invalidRequest(): never {
  throw new ManagedDocumentLocalStagingError("invalid_staging_request", "Invalid document staging request.");
}

function corrupt(message: string): never {
  throw new ManagedDocumentLocalStagingError("local_staging_corrupt", message);
}
