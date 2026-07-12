import type { DataAdapter } from "obsidian";

const STAGING_DIRECTORY = ".managed-document-staging";
const MANIFEST_FILE = "manifest.json";
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
  phase: "staging" | "ready";
  artifacts: ManagedDocumentStagedArtifact[];
}

export class ManagedDocumentLocalStagingError extends Error {
  constructor(
    public readonly code: "local_staging_corrupt" | "invalid_staging_request",
    message: string
  ) {
    super(message);
    this.name = "ManagedDocumentLocalStagingError";
  }
}

/** Adapter-only, opaque storage for document output bytes awaiting local commit. */
export class ManagedDocumentLocalStaging {
  private readonly root: string;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDirectory: string
  ) {
    const normalized = normalizePluginDirectory(pluginDirectory);
    this.root = `${normalized}/${STAGING_DIRECTORY}`;
  }

  async stage(
    operationId: string,
    artifacts: ReadonlyArray<{ kind: ManagedDocumentStagedArtifactKind; bytes: ArrayBuffer }>,
    signal?: AbortSignal
  ): Promise<ManagedDocumentStagedArtifact[]> {
    throwIfAborted(signal);
    if (!operationId || artifacts.length === 0) {
      throw new ManagedDocumentLocalStagingError("invalid_staging_request", "Invalid document staging request.");
    }

    const operationHash = await sha256(new TextEncoder().encode(operationId).buffer);
    const directory = `${this.root}/${operationHash}`;
    await this.ensureDirectory(this.root);
    await this.ensureDirectory(directory);

    const staged: ManagedDocumentStagedArtifact[] = [];
    await this.writeManifest(directory, { schemaVersion: 1, operationHash, phase: "staging", artifacts: [] });

    for (let index = 0; index < artifacts.length; index += 1) {
      throwIfAborted(signal);
      const artifact = artifacts[index];
      const digest = await sha256(artifact.bytes);
      throwIfAborted(signal);
      const id = await sha256(
        new TextEncoder().encode(`managed-document-artifact-v1\0${index}\0${artifact.kind}\0${digest}`).buffer
      );
      const metadata = { id, kind: artifact.kind, byteLength: artifact.bytes.byteLength, sha256: digest };
      const path = `${directory}/${id}`;
      const temporaryPath = `${path}.tmp`;
      await this.adapter.writeBinary(temporaryPath, artifact.bytes);
      throwIfAborted(signal);
      await this.adapter.rename(temporaryPath, path);
      const verified = await this.adapter.readBinary(path);
      if (verified.byteLength !== metadata.byteLength || (await sha256(verified)) !== digest) {
        throw new ManagedDocumentLocalStagingError("local_staging_corrupt", "Staged document artifact failed verification.");
      }
      staged.push(metadata);
      await this.writeManifest(directory, { schemaVersion: 1, operationHash, phase: "staging", artifacts: staged });
    }

    throwIfAborted(signal);
    await this.writeManifest(directory, { schemaVersion: 1, operationHash, phase: "ready", artifacts: staged });
    return staged;
  }

  async readVerified(
    operationId: string,
    expected: ReadonlyArray<ManagedDocumentStagedArtifact>,
    signal?: AbortSignal
  ): Promise<ArrayBuffer[]> {
    throwIfAborted(signal);
    const operationHash = await sha256(new TextEncoder().encode(operationId).buffer);
    const directory = `${this.root}/${operationHash}`;
    const manifest = await this.readManifest(directory, operationHash);
    if (manifest.phase !== "ready" || JSON.stringify(manifest.artifacts) !== JSON.stringify(expected)) {
      throw new ManagedDocumentLocalStagingError("local_staging_corrupt", "Document staging manifest does not match recovery metadata.");
    }

    const bytes: ArrayBuffer[] = [];
    for (const artifact of expected) {
      throwIfAborted(signal);
      if (!HASH_PATTERN.test(artifact.id) || !HASH_PATTERN.test(artifact.sha256)) {
        throw new ManagedDocumentLocalStagingError("local_staging_corrupt", "Document staging metadata is invalid.");
      }
      const value = await this.adapter.readBinary(`${directory}/${artifact.id}`);
      throwIfAborted(signal);
      if (value.byteLength !== artifact.byteLength || (await sha256(value)) !== artifact.sha256) {
        throw new ManagedDocumentLocalStagingError("local_staging_corrupt", "Staged document artifact failed verification.");
      }
      bytes.push(value);
    }
    return bytes;
  }

  async cleanup(operationId: string): Promise<void> {
    const operationHash = await sha256(new TextEncoder().encode(operationId).buffer);
    const directory = `${this.root}/${operationHash}`;
    if (await this.adapter.exists(directory)) {
      await this.adapter.rmdir(directory, true);
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
  }

  private async writeManifest(directory: string, manifest: ManagedDocumentStagingManifest): Promise<void> {
    const path = `${directory}/${MANIFEST_FILE}`;
    const temporaryPath = `${path}.tmp`;
    await this.adapter.write(temporaryPath, JSON.stringify(manifest));
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    await this.adapter.rename(temporaryPath, path);
  }

  private async readManifest(directory: string, operationHash: string): Promise<ManagedDocumentStagingManifest> {
    try {
      const value = JSON.parse(await this.adapter.read(`${directory}/${MANIFEST_FILE}`)) as ManagedDocumentStagingManifest;
      if (value.schemaVersion !== 1 || value.operationHash !== operationHash || !Array.isArray(value.artifacts)) throw new Error();
      return value;
    } catch {
      throw new ManagedDocumentLocalStagingError("local_staging_corrupt", "Document staging manifest is missing or corrupt.");
    }
  }
}

function normalizePluginDirectory(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new ManagedDocumentLocalStagingError("invalid_staging_request", "Invalid plugin data directory.");
  }
  return normalized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
