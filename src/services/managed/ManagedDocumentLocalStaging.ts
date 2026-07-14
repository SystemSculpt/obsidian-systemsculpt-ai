import type SystemSculptPlugin from "../../main";

const STAGING_DIRECTORY = ".managed-document-staging";
const MANIFEST_PATTERN = /\/manifest-(\d{6})\.json$/;
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

export class ManagedDocumentLocalStagingError extends Error {
  constructor(
    public readonly code: "local_staging_corrupt" | "invalid_staging_request",
    message: string
  ) {
    super(message);
    this.name = "ManagedDocumentLocalStagingError";
  }
}

/**
 * Adapter-only opaque staging. Immutable manifest generations provide logical
 * crash recovery; this module deliberately makes no physical flush guarantee.
 */
export class ManagedDocumentLocalStaging {
  private readonly adapter: SystemSculptPlugin["app"]["vault"]["adapter"];
  private readonly root: string;
  private readonly digest: (bytes: ArrayBuffer) => Promise<string>;

  constructor(plugin: SystemSculptPlugin, testSeam: ManagedDocumentStagingTestSeam = {}) {
    const configDirectory = normalizeRelativePath(plugin?.app?.vault?.configDir);
    const pluginId = normalizePluginId(plugin?.manifest?.id);
    if (pluginId !== "systemsculpt-ai") invalidRequest();
    const derivedDirectory = `${configDirectory}/plugins/${pluginId}`;
    if (plugin.manifest.dir !== undefined && normalizeRelativePath(plugin.manifest.dir) !== derivedDirectory) {
      throw new ManagedDocumentLocalStagingError("invalid_staging_request", "Plugin manifest directory does not match the installed plugin location.");
    }
    this.adapter = plugin.app.vault.adapter;
    this.digest = testSeam.digest ?? sha256;
    this.root = `${derivedDirectory}/${STAGING_DIRECTORY}`;
  }

  async stage(
    operationId: string,
    artifacts: ReadonlyArray<{ kind: ManagedDocumentStagedArtifactKind; bytes: ArrayBuffer }>,
    signal?: AbortSignal
  ): Promise<ManagedDocumentStagedArtifact[]> {
    throwIfAborted(signal);
    if (!operationId || artifacts.length === 0) invalidRequest();

    const operationHash = await this.digest(new TextEncoder().encode(operationId).buffer);
    throwIfAborted(signal);
    const directory = `${this.root}/${operationHash}`;
    await this.ensureDirectory(this.root, signal);
    await this.ensureDirectory(directory, signal);

    const staged: ManagedDocumentStagedArtifact[] = [];
    let sequence = await this.nextManifestSequence(directory, signal);
    await this.writeManifest(directory, { schemaVersion: 1, operationHash, sequence, phase: "staging", artifacts: [] }, signal);

    for (let index = 0; index < artifacts.length; index += 1) {
      throwIfAborted(signal);
      const artifact = artifacts[index];
      const digest = await this.digest(artifact.bytes);
      throwIfAborted(signal);
      const id = await this.digest(new TextEncoder().encode(
        `managed-document-artifact-v1\0${index}\0${artifact.kind}\0${digest}`
      ).buffer);
      throwIfAborted(signal);
      const metadata = { id, kind: artifact.kind, byteLength: artifact.bytes.byteLength, sha256: digest };
      const path = `${directory}/${id}`;
      const temporaryPath = `${path}.tmp`;
      await this.adapter.writeBinary(temporaryPath, artifact.bytes);
      throwIfAborted(signal);
      await this.adapter.rename(temporaryPath, path);
      throwIfAborted(signal);
      const verified = await this.adapter.readBinary(path);
      throwIfAborted(signal);
      const verifiedHash = await this.digest(verified);
      throwIfAborted(signal);
      if (verified.byteLength !== metadata.byteLength || verifiedHash !== digest) corrupt("Staged document artifact failed verification.");
      staged.push(metadata);
      sequence += 1;
      await this.writeManifest(directory, { schemaVersion: 1, operationHash, sequence, phase: "staging", artifacts: [...staged] }, signal);
    }

    sequence += 1;
    await this.writeManifest(directory, { schemaVersion: 1, operationHash, sequence, phase: "ready", artifacts: [...staged] }, signal);
    throwIfAborted(signal);
    return staged;
  }

  async readVerified(
    operationId: string,
    expected: ReadonlyArray<ManagedDocumentStagedArtifact>,
    signal?: AbortSignal
  ): Promise<ArrayBuffer[]> {
    throwIfAborted(signal);
    const operationHash = await this.digest(new TextEncoder().encode(operationId).buffer);
    throwIfAborted(signal);
    const directory = `${this.root}/${operationHash}`;
    const manifests = await this.readManifests(directory, operationHash, signal);
    const manifest = manifests.find((candidate) =>
      candidate.phase === "ready" && JSON.stringify(candidate.artifacts) === JSON.stringify(expected)
    );
    if (!manifest) corrupt("Document staging manifest does not match recovery metadata.");

    const bytes: ArrayBuffer[] = [];
    for (const artifact of expected) {
      throwIfAborted(signal);
      if (!HASH_PATTERN.test(artifact.id) || !HASH_PATTERN.test(artifact.sha256)) corrupt("Document staging metadata is invalid.");
      const value = await this.adapter.readBinary(`${directory}/${artifact.id}`);
      throwIfAborted(signal);
      const digest = await this.digest(value);
      throwIfAborted(signal);
      if (value.byteLength !== artifact.byteLength || digest !== artifact.sha256) corrupt("Staged document artifact failed verification.");
      bytes.push(value);
    }
    return bytes;
  }

  async cleanup(operationId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const operationHash = await this.digest(new TextEncoder().encode(operationId).buffer);
    throwIfAborted(signal);
    const directory = `${this.root}/${operationHash}`;
    const exists = await this.adapter.exists(directory);
    throwIfAborted(signal);
    if (exists) {
      await this.adapter.rmdir(directory, true);
      throwIfAborted(signal);
    }
  }

  private async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    const exists = await this.adapter.exists(path);
    throwIfAborted(signal);
    if (!exists) {
      await this.adapter.mkdir(path);
      throwIfAborted(signal);
    }
  }

  private async nextManifestSequence(directory: string, signal?: AbortSignal): Promise<number> {
    const listing = await this.adapter.list(directory);
    throwIfAborted(signal);
    const maximum = listing.files.reduce((current, path) => {
      const match = path.match(MANIFEST_PATTERN);
      return match ? Math.max(current, Number(match[1])) : current;
    }, 0);
    return maximum + 1;
  }

  private async writeManifest(
    directory: string,
    manifest: ManagedDocumentStagingManifest,
    signal?: AbortSignal
  ): Promise<void> {
    const suffix = String(manifest.sequence).padStart(6, "0");
    const path = `${directory}/manifest-${suffix}.json`;
    const temporaryPath = `${path}.tmp`;
    await this.adapter.write(temporaryPath, JSON.stringify(manifest));
    throwIfAborted(signal);
    await this.adapter.rename(temporaryPath, path);
    throwIfAborted(signal);
  }

  private async readManifests(
    directory: string,
    operationHash: string,
    signal?: AbortSignal
  ): Promise<ManagedDocumentStagingManifest[]> {
    try {
      const listing = await this.adapter.list(directory);
      throwIfAborted(signal);
      const paths = listing.files.filter((path) => MANIFEST_PATTERN.test(path)).sort().reverse();
      const manifests: ManagedDocumentStagingManifest[] = [];
      for (const path of paths) {
        const raw = await this.adapter.read(path);
        throwIfAborted(signal);
        try {
          const value = JSON.parse(raw) as ManagedDocumentStagingManifest;
          if (
            value.schemaVersion === 1 && value.operationHash === operationHash &&
            Number.isInteger(value.sequence) && value.sequence > 0 && Array.isArray(value.artifacts) &&
            (value.phase === "staging" || value.phase === "ready")
          ) manifests.push(value);
        } catch {
          // An incomplete immutable generation is ignored; older valid generations remain selectable.
        }
      }
      return manifests;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      corrupt("Document staging manifest is missing or corrupt.");
    }
  }
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "." || !part)) invalidRequest();
  return normalized;
}

function normalizePluginId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) invalidRequest();
  return value;
}

function invalidRequest(): never {
  throw new ManagedDocumentLocalStagingError("invalid_staging_request", "Invalid document staging request.");
}

function corrupt(message: string): never {
  throw new ManagedDocumentLocalStagingError("local_staging_corrupt", message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
