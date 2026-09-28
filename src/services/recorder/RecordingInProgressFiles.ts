import { TFile, type App, type DataAdapter, type TAbstractFile } from "obsidian";

/**
 * A recording streams here, not into the recordings folder. Obsidian Sync
 * skips dot-folders, so a growing file is never re-uploaded while recording;
 * only the finished file is moved to where Sync and the vault see it.
 */
export const RECORDINGS_IN_PROGRESS_DIRECTORY = ".systemsculpt/recordings-in-progress";
/**
 * An in-progress file the capture abandoned, renamed so recovery never
 * mistakes it for an interrupted recording. Recovery deletes it.
 */
export const DISCARDED_RECORDING_SUFFIX = ".discarded";
/** How long a moved recording may take to appear in the vault index. */
const VAULT_INDEX_WAIT_MS = 5_000;

type InProgressAdapter = Pick<DataAdapter, "exists" | "mkdir" | "rename" | "copy" | "remove">;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The hidden file a capture streams into, named like its final file. */
export function inProgressRecordingPath(finalPath: string): string {
  return `${RECORDINGS_IN_PROGRESS_DIRECTORY}/${fileName(finalPath)}`;
}

export function isInProgressRecordingPath(path: string): boolean {
  return path.startsWith(`${RECORDINGS_IN_PROGRESS_DIRECTORY}/`);
}

export function isDiscardedRecordingPath(path: string): boolean {
  return path.endsWith(DISCARDED_RECORDING_SUFFIX);
}

/** The final path for a recovered in-progress file, in the given recordings folder. */
export function recordingPathIn(directory: string, inProgressPath: string): string {
  const base = directory.replace(/\/+$/, "");
  return base ? `${base}/${fileName(inProgressPath)}` : fileName(inProgressPath);
}

export async function ensureAdapterDirectory(adapter: Pick<DataAdapter, "exists" | "mkdir">, path: string): Promise<void> {
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if (!(await adapter.exists(current))) throw error;
    }
  }
}

/** `desired`, or the first free `name-1.ext`, `name-2.ext`, … sibling. */
export async function availableRecordingPath(
  adapter: Pick<DataAdapter, "exists">,
  desired: string,
): Promise<string> {
  if (!(await adapter.exists(desired))) return desired;
  const slash = desired.lastIndexOf("/");
  const directory = slash >= 0 ? desired.slice(0, slash + 1) : "";
  const name = desired.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const candidate = `${directory}${stem}-${suffix}${extension}`;
    if (!(await adapter.exists(candidate))) return candidate;
  }
  throw new Error("Could not find an available filename for the captured audio.");
}

/**
 * Move a finished in-progress recording to its final vault path and return
 * the path used. A taken name gets a numbered sibling. If the rename fails,
 * the file is copied and the hidden original removed. The move is complete
 * once the file is on disk at its final path; the wait for the vault index
 * only lets transcription find it straight away.
 */
export async function moveRecordingIntoVault(
  app: App,
  fromPath: string,
  desiredPath: string,
  hostWindow: Pick<Window, "setTimeout" | "clearTimeout"> = window,
): Promise<string> {
  const adapter = app.vault.adapter as unknown as InProgressAdapter;
  const target = await availableRecordingPath(adapter, desiredPath);
  try {
    await adapter.rename(fromPath, target);
  } catch (renameError) {
    try {
      await adapter.copy(fromPath, target);
    } catch {
      throw renameError;
    }
    try {
      await adapter.remove(fromPath);
    } catch {
      // The copy is in place; a leftover hidden original is harmless.
    }
  }
  await waitForVaultFile(app, target, hostWindow);
  return target;
}

async function waitForVaultFile(
  app: App,
  path: string,
  hostWindow: Pick<Window, "setTimeout" | "clearTimeout">,
): Promise<void> {
  const vault = app.vault as Partial<Pick<App["vault"], "getAbstractFileByPath" | "on" | "offref">>;
  const indexed = (): boolean => vault.getAbstractFileByPath?.(path) instanceof TFile;
  if (indexed() || typeof vault.on !== "function") return;
  await new Promise<void>((resolve) => {
    let timer = 0;
    const ref = vault.on!("create", (file: TAbstractFile) => {
      if (file.path === path) finish();
    });
    const finish = (): void => {
      hostWindow.clearTimeout(timer);
      vault.offref?.(ref);
      resolve();
    };
    timer = hostWindow.setTimeout(finish, VAULT_INDEX_WAIT_MS);
    if (indexed()) finish();
  });
}
