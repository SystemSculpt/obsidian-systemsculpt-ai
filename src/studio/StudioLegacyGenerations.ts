import { Notice, type DataAdapter } from "obsidian";
import { askInNotice } from "../core/ui/notifications";
import { readStudioProjectFile } from "./document/StudioProjectDocument";
import { resolveStudioEntry } from "./StudioEntry";
import { STUDIO_PROJECT_EXTENSION } from "./types";

/**
 * Studio before 6.10 saved a snapshot of every save, with full copies of each
 * binary asset, under .systemsculpt/studio/projects/<project id>/generations.
 * Nothing reads them now. Studio offers once to delete the folders of
 * projects that open in the current format. A folder whose project is missing
 * or fails to open stays as it is.
 * @internal Tests assert against this value.
 */
export const STUDIO_LEGACY_PROJECTS_DIR = ".systemsculpt/studio/projects";
/**
 * The recorded check. It sits beside the folders it covers, so it syncs exactly when they do.
 * @internal Tests assert against this value.
 */
export const STUDIO_LEGACY_CHECK_PATH = ".systemsculpt/studio/legacy-generations-check.json";

type Adapter = Pick<DataAdapter, "exists" | "list" | "stat" | "read" | "write" | "rmdir">;
type Vault = { adapter: Adapter; getFiles(): ReadonlyArray<{ path: string }> };
/** @internal Tests type their fixtures with this. */
export type StudioLegacyGenerationsOffer = Readonly<{ folders: readonly string[]; bytes: number }>;
export type StudioLegacyGenerationsResult =
  | { status: "none" | "checked" | "unanswered" }
  | { status: "kept"; offer: StudioLegacyGenerationsOffer }
  | { status: "deleted"; offer: StudioLegacyGenerationsOffer; deletedBytes: number; failed: string[] };

/** The identity a file claims, read without validating it. */
function claimedProjectId(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const { id, projectId } = value as { id?: unknown; projectId?: unknown };
    const claimed = id ?? projectId;
    return typeof claimed === "string" ? claimed : undefined;
  } catch {
    return undefined;
  }
}

/** Project IDs Studio opens now, and those claimed by a file it can't open. */
async function projectIdsByOutcome(vault: Vault): Promise<{ opens: Set<string>; fails: Set<string> }> {
  const opens = new Set<string>(), fails = new Set<string>();
  for (const { path } of vault.getFiles()) {
    if (!path.toLowerCase().endsWith(STUDIO_PROJECT_EXTENSION)) continue;
    try {
      const entry = await resolveStudioEntry(vault.adapter, path);
      opens.add(readStudioProjectFile(entry.raw, entry.path).project.projectId);
    } catch {
      const claimed = claimedProjectId(await vault.adapter.read(path).catch(() => ""));
      if (claimed) fails.add(claimed);
    }
  }
  return { opens, fails };
}

async function folderBytes(adapter: Adapter, folder: string): Promise<number> {
  const listing = await adapter.list(folder);
  const sizes = await Promise.all(listing.files.map(async (file) => (await adapter.stat(file))?.size ?? 0));
  let bytes = sizes.reduce((total, size) => total + size, 0);
  for (const child of listing.folders) bytes += await folderBytes(adapter, child);
  return bytes;
}

/** Delete each folder whole, counting the bytes freed and the folders that remain. */
async function deleteLegacyFolders(adapter: Adapter, sizes: ReadonlyMap<string, number>): Promise<{ deletedBytes: number; failed: string[] }> {
  let deletedBytes = 0;
  const failed: string[] = [];
  for (const [folder, size] of sizes) {
    try {
      await adapter.rmdir(folder, true);
      deletedBytes += size;
    } catch {
      failed.push(folder);
    }
  }
  return { deletedBytes, failed };
}

async function recordCheck(adapter: Adapter, outcome: "deleted" | "kept" | "nothing to offer", at: Date): Promise<void> {
  await adapter.write(STUDIO_LEGACY_CHECK_PATH, `${JSON.stringify({ outcome, at: at.toISOString() }, null, 2)}\n`);
}

/**
 * Offer once to delete the legacy folders of projects that open now. `ask`
 * returns true to delete, false to keep, or null when no answer came, which
 * leaves the offer for the next check.
 * @internal Unit-tested directly.
 */
export async function checkStudioLegacyGenerations(options: {
  vault: Vault;
  ask: (offer: StudioLegacyGenerationsOffer) => Promise<boolean | null>;
  now?: () => Date;
}): Promise<StudioLegacyGenerationsResult> {
  const { vault, ask } = options, adapter = vault.adapter, now = options.now ?? (() => new Date());
  if (!await adapter.exists(STUDIO_LEGACY_PROJECTS_DIR)) return { status: "none" };
  if (await adapter.exists(STUDIO_LEGACY_CHECK_PATH)) return { status: "checked" };
  const legacy: string[] = [];
  for (const folder of (await adapter.list(STUDIO_LEGACY_PROJECTS_DIR)).folders) {
    if (await adapter.exists(`${folder}/generations`)) legacy.push(folder);
  }
  if (!legacy.length) return { status: "none" };
  const { opens, fails } = await projectIdsByOutcome(vault);
  const folders = legacy.filter((folder) => {
    const id = folder.slice(STUDIO_LEGACY_PROJECTS_DIR.length + 1);
    return opens.has(id) && !fails.has(id);
  });
  if (!folders.length) {
    await recordCheck(adapter, "nothing to offer", now());
    return { status: "none" };
  }
  // Nothing writes these folders any more, so the sizes offered are the sizes freed.
  const sizes = new Map<string, number>();
  for (const folder of folders) sizes.set(folder, await folderBytes(adapter, folder));
  const offer = { folders, bytes: [...sizes.values()].reduce((total, size) => total + size, 0) };
  const answer = await ask(offer);
  if (answer === null) return { status: "unanswered" };
  if (!answer) {
    await recordCheck(adapter, "kept", now());
    return { status: "kept", offer };
  }
  const { deletedBytes, failed } = await deleteLegacyFolders(adapter, sizes);
  await recordCheck(adapter, "deleted", now());
  return { status: "deleted", offer, deletedBytes, failed };
}

/**
 * Decimal units, as a file manager shows sizes.
 * @internal Unit-tested directly.
 */
export function formatStudioLegacyBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** @internal Unit-tested directly. */
export function studioLegacyGenerationsOfferMessage(offer: StudioLegacyGenerationsOffer): string {
  return `SystemSculpt Studio no longer uses the project history saved before version 6.10. Delete it to free ${formatStudioLegacyBytes(offer.bytes)}? Your projects stay as they are.`;
}

/** @internal Unit-tested directly. */
export function studioLegacyGenerationsResultMessage(result: Extract<StudioLegacyGenerationsResult, { status: "deleted" }>): string {
  const count = result.failed.length;
  if (count === result.offer.folders.length) return `Studio couldn't delete its old project history in ${STUDIO_LEGACY_PROJECTS_DIR}.`;
  const deleted = `Deleted ${formatStudioLegacyBytes(result.deletedBytes)} of old Studio history.`;
  if (!count) return deleted;
  return `${deleted} ${count === 1 ? "1 folder" : `${count} folders`} in ${STUDIO_LEGACY_PROJECTS_DIR} couldn't be deleted.`;
}

/** The startup check: one notice asks, and a second one reports what was deleted. */
export async function offerStudioLegacyGenerationsCleanup(vault: Vault, signal?: AbortSignal): Promise<StudioLegacyGenerationsResult> {
  const result = await checkStudioLegacyGenerations({
    vault,
    ask: (offer) => askInNotice(studioLegacyGenerationsOfferMessage(offer), { confirm: "Delete", cancel: "Keep" }, signal),
  });
  if (result.status === "deleted") new Notice(studioLegacyGenerationsResultMessage(result), 8000);
  return result;
}
