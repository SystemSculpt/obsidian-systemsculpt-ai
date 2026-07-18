import { TFile, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { AUDIO_PROCESSOR_OUTPUT_DIRECTORY, type AudioProcessorArtifactKind } from "./types";

type DeliveryArtifact = "full" | AudioProcessorArtifactKind;

type ArtifactSlot = Readonly<{
  path: string;
  file: TFile | null;
}>;

export type AudioProcessorDeliveryPlan = Readonly<{
  note: ArtifactSlot;
  summary: ArtifactSlot;
  transcript: ArtifactSlot;
}>;

export type AudioProcessorDeliveryFiles = Readonly<{
  note: TFile;
  transcript: TFile;
}>;

/**
 * Owns the vault-side delivery transaction for a completed server job.
 *
 * The server owns transcription and rendering. This module only validates the
 * artifact provenance, adds vault-native navigation, and durably creates the
 * two local files. Paths are deterministic so a restart after either create
 * resumes the same delivery instead of creating numbered duplicates.
 */
export class AudioProcessorDelivery {
  constructor(private readonly plugin: SystemSculptPlugin) {}

  async resolvePlan(
    artifactJobId: string,
    filename: string,
    options: Readonly<{ recoverMovedFiles: boolean }>,
    requiredArtifacts: readonly DeliveryArtifact[] = ["full", "transcript"],
  ): Promise<AudioProcessorDeliveryPlan> {
    const required = new Set(requiredArtifacts);
    if (required.size === 0) throw new Error("At least one audio artifact is required.");
    const indexed = options.recoverMovedFiles
      ? this.findIndexedArtifacts(artifactJobId)
      : {};

    const baseName = sanitizeMarkdownFilename(filename);
    const candidates = candidatePathSets(baseName, artifactJobId, indexed);
    let foundOwnedArtifact = requiredArtifacts.some((kind) => Boolean(indexed[kind]));
    for (const candidate of candidates) {
      const slots = {} as Record<DeliveryArtifact, ArtifactSlot | null>;
      for (const kind of ["full", "summary", "transcript"] as const) {
        const indexedFile = indexed[kind];
        if (indexedFile) {
          slots[kind] = { path: indexedFile.path, file: indexedFile };
          continue;
        }
        const inspected = await this.inspectSlot(candidate[kind], artifactJobId, kind);
        slots[kind] = inspected ?? (required.has(kind)
          ? null
          : { path: candidate[kind], file: null });
      }
      if (requiredArtifacts.every((kind) => slots[kind] != null)) {
        return {
          note: slots.full!,
          summary: slots.summary!,
          transcript: slots.transcript!,
        };
      }
      foundOwnedArtifact ||= requiredArtifacts.some((kind) => Boolean(slots[kind]?.file));
      if (foundOwnedArtifact) break;
    }

    if (foundOwnedArtifact) {
      throw new Error(
        "One of this audio's paired note paths is occupied. Move that file, then resume Audio Processor.",
      );
    }
    throw new Error(
      "An audio note with the same name already exists. Rename it, then resume Audio Processor.",
    );
  }

  findArtifact(artifactJobId: string, kind: DeliveryArtifact): TFile | null {
    const artifacts = this.findIndexedArtifacts(artifactJobId);
    return artifacts[kind] ?? null;
  }

  async persist(
    plan: AudioProcessorDeliveryPlan,
    artifactJobId: string,
    markdown: Readonly<{ note: string | null; transcript: string | null }>,
    signal: AbortSignal,
    options: Readonly<{ deliveryJobId: string }>,
  ): Promise<AudioProcessorDeliveryFiles> {
    if (!plan.note.file) {
      if (markdown.note == null) throw new Error("The audio note was not downloaded.");
      assertAudioArtifact(markdown.note, artifactJobId, "full");
    }
    if (!plan.transcript.file) {
      if (markdown.transcript == null) throw new Error("The audio transcript was not downloaded.");
      assertAudioArtifact(markdown.transcript, artifactJobId, "transcript");
    }

    // Create the transcript first so the primary note is never surfaced with
    // a broken transcript link during the successful path. If the second
    // create is interrupted, the deterministic plan repairs it on resume.
    const transcript = plan.transcript.file ?? await this.createArtifact(
      plan.transcript.path,
      addDeliveryJobMarker(
        addVaultNavigation(markdown.transcript!, "transcript", plan.note.path),
        options.deliveryJobId,
      ),
      artifactJobId,
      "transcript",
      signal,
    );
    const note = plan.note.file ?? await this.createArtifact(
      plan.note.path,
      addDeliveryJobMarker(
        addVaultNavigation(markdown.note!, "full", plan.transcript.path),
        options.deliveryJobId,
      ),
      artifactJobId,
      "full",
      signal,
    );
    if (plan.note.file) {
      await this.syncDeliveryAlias(
        note,
        artifactJobId,
        "full",
        options.deliveryJobId,
        plan.transcript.path,
      );
    }
    if (plan.transcript.file) {
      await this.syncDeliveryAlias(
        transcript,
        artifactJobId,
        "transcript",
        options.deliveryJobId,
        plan.note.path,
      );
    }
    return { note, transcript };
  }

  async persistOne(
    plan: AudioProcessorDeliveryPlan,
    artifactJobId: string,
    kind: DeliveryArtifact,
    markdown: string,
    signal: AbortSignal,
    options: Readonly<{
      deliveryJobId: string;
      linkedArtifactAvailable?: boolean;
    }>,
  ): Promise<TFile> {
    assertAudioArtifact(markdown, artifactJobId, kind);
    const slot = kind === "full"
      ? plan.note
      : kind === "summary"
        ? plan.summary
        : plan.transcript;
    const linkedPath = kind === "transcript" ? plan.note.path : plan.transcript.path;
    if (slot.file) {
      await this.syncDeliveryAlias(
        slot.file,
        artifactJobId,
        kind,
        options.deliveryJobId,
        options.linkedArtifactAvailable === false ? undefined : linkedPath,
      );
      return slot.file;
    }
    return await this.createArtifact(
      slot.path,
      addDeliveryJobMarker(
        options.linkedArtifactAvailable === false
          ? markdown
          : addVaultNavigation(markdown, kind, linkedPath),
        options.deliveryJobId,
      ),
      artifactJobId,
      kind,
      signal,
    );
  }

  private findIndexedArtifacts(artifactJobId: string): Partial<Record<DeliveryArtifact, TFile>> {
    const result: Partial<Record<DeliveryArtifact, TFile>> = {};
    const files = [...this.plugin.app.vault.getMarkdownFiles()]
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const file of files) {
      const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.["systemsculpt-audio-job-id"] !== artifactJobId) continue;
      const artifact: unknown = frontmatter?.["systemsculpt-audio-artifact"];
      if (artifact !== "full" && artifact !== "summary" && artifact !== "transcript") continue;
      if (!result[artifact]) result[artifact] = file;
      if (result.full && result.summary && result.transcript) break;
    }
    return result;
  }

  private async inspectSlot(
    path: string,
    artifactJobId: string,
    kind: DeliveryArtifact,
  ): Promise<ArtifactSlot | null> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!existing) return { path, file: null };
    if (!(existing instanceof TFile)) return null;
    if (await this.fileHasMarker(existing, artifactJobId, kind)) {
      return { path: existing.path, file: existing };
    }
    return null;
  }

  private async fileHasMarker(
    file: TFile,
    artifactJobId: string,
    kind: DeliveryArtifact,
  ): Promise<boolean> {
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (
      frontmatter?.["systemsculpt-audio-job-id"] === artifactJobId
      && frontmatter?.["systemsculpt-audio-artifact"] === kind
    ) return true;
    return hasAudioArtifactMarker(
      await this.plugin.app.vault.read(file),
      artifactJobId,
      kind,
    );
  }

  private async createArtifact(
    path: string,
    markdown: string,
    artifactJobId: string,
    kind: DeliveryArtifact,
    signal: AbortSignal,
  ): Promise<TFile> {
    if (signal.aborted) throw abortError();
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (directory) await this.plugin.directoryManager.ensureDirectoryByPath(directory);
    if (signal.aborted) throw abortError();

    try {
      return await this.plugin.app.vault.create(path, markdown);
    } catch (error) {
      // A concurrent retry or a create whose response was interrupted may
      // already have committed the exact artifact. Read back only this direct
      // path before deciding whether the original error is still actionable.
      const recovered = await this.inspectSlot(path, artifactJobId, kind);
      if (recovered?.file) return recovered.file;
      throw error;
    }
  }

  private async syncDeliveryAlias(
    file: TFile,
    _artifactJobId: string,
    kind: DeliveryArtifact,
    deliveryJobId: string,
    linkedPath?: string,
  ): Promise<void> {
    const current = await this.plugin.app.vault.read(file);
    const withNavigation = linkedPath
      ? addVaultNavigation(current, kind, linkedPath)
      : current;
    const updated = addDeliveryJobMarker(withNavigation, deliveryJobId);
    if (updated === current) return;
    await this.plugin.app.vault.modify(file, updated);
  }
}

function candidatePathSets(
  baseName: string,
  artifactJobId: string,
  indexed: Partial<Record<DeliveryArtifact, TFile>>,
): Array<Record<DeliveryArtifact, string>> {
  const indexedAnchor = indexed.full ?? indexed.summary ?? indexed.transcript;
  if (indexedAnchor) {
    const basePath = artifactBasePath(indexedAnchor.path);
    return [{
      full: indexed.full?.path ?? `${basePath}.md`,
      summary: indexed.summary?.path ?? `${basePath} — Summary.md`,
      transcript: indexed.transcript?.path ?? `${basePath} — Transcript.md`,
    }];
  }

  const defaultBase = normalizePath(`${AUDIO_PROCESSOR_OUTPUT_DIRECTORY}/${baseName}`);
  const collisionToken = stableCollisionToken(artifactJobId);
  const collisionBase = `${defaultBase} (${collisionToken})`;
  return [defaultBase, collisionBase].map((pathBase) => ({
    full: `${pathBase}.md`,
    summary: `${pathBase} — Summary.md`,
    transcript: `${pathBase} — Transcript.md`,
  }));
}

function artifactBasePath(path: string): string {
  return path
    .replace(/\.md$/i, "")
    .replace(/ — (?:Summary|Transcript)$/i, "");
}

function stableCollisionToken(jobId: string): string {
  const token = jobId.replace(/[^A-Za-z0-9]/g, "").slice(-10);
  return token || "audio";
}

function sanitizeMarkdownFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "Audio note";
  const withoutExtension = basename.replace(/\.md$/i, "");
  const sanitized = withoutExtension
    .replace(/[\x00-\x1f<>:"/\\|?*#[\]^]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return sanitized || "Audio note";
}

function addVaultNavigation(
  markdown: string,
  kind: DeliveryArtifact,
  linkedPath: string,
): string {
  const marker = kind !== "transcript"
    ? "<!-- systemsculpt-audio-transcript-link -->"
    : "<!-- systemsculpt-audio-note-link -->";
  if (markdown.includes(marker)) return markdown;

  const linkTarget = linkedPath
    .replace(/\.md$/i, "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\]/g, "\\]");
  const navigation = kind !== "transcript"
    ? [
      marker,
      "> [!info] Timestamped transcript",
      `> [[${linkTarget}|Open the full timestamped transcript]]`,
    ].join("\n")
    : [
      marker,
      "> [!info] Audio note",
      `> [[${linkTarget}|Back to the audio note]]`,
    ].join("\n");
  return insertAfterFrontmatter(markdown, navigation);
}

function addDeliveryJobMarker(markdown: string, deliveryJobId: string): string {
  const normalized = deliveryJobId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(normalized)) {
    throw new Error("The audio delivery job ID was invalid.");
  }
  const field = "systemsculpt-audio-delivery-job-id";
  const marker = `${field}: ${normalized}`;
  const existing = new RegExp(`^${field}:\\s*.+$`, "im");
  if (existing.test(markdown)) return markdown.replace(existing, marker);
  if (!markdown.startsWith("---\n")) return `---\n${marker}\n---\n\n${markdown}`;
  return `---\n${marker}\n${markdown.slice(4)}`;
}

function insertAfterFrontmatter(markdown: string, block: string): string {
  if (!markdown.startsWith("---\n")) return `${block}\n\n${markdown}`;
  const closing = markdown.indexOf("\n---", 4);
  if (closing < 0) return `${block}\n\n${markdown}`;
  const afterClosing = markdown.indexOf("\n", closing + 4);
  if (afterClosing < 0) return `${markdown}\n\n${block}\n`;
  return `${markdown.slice(0, afterClosing + 1)}\n${block}\n${markdown.slice(afterClosing + 1)}`;
}

export function assertAudioArtifact(
  markdown: string,
  artifactJobId: string,
  kind: DeliveryArtifact,
): void {
  if (!hasAudioArtifactMarker(markdown, artifactJobId, kind)) {
    throw new Error(`The audio ${kind} was missing its job marker.`);
  }
  if (kind === "transcript" && !/(?:\*\*|\[)(?:\d+:)?\d{2}:\d{2}\b/m.test(markdown)) {
    throw new Error("The audio transcript did not contain timestamps.");
  }
}

function hasAudioArtifactMarker(
  markdown: string,
  artifactJobId: string,
  kind: DeliveryArtifact,
): boolean {
  const escapedJobId = escapeRegExp(artifactJobId);
  const escapedKind = escapeRegExp(kind);
  return new RegExp(
    `^systemsculpt-audio-job-id:\\s*["']?${escapedJobId}["']?\\s*$`,
    "im",
  ).test(markdown) && new RegExp(
    `^systemsculpt-audio-artifact:\\s*["']?${escapedKind}["']?\\s*$`,
    "im",
  ).test(markdown);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function abortError(): DOMException {
  return new DOMException("Audio processing was cancelled.", "AbortError");
}
