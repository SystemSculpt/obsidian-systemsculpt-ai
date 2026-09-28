import type { DataAdapter } from "obsidian";

const PLUGIN_FOLDER_PATH = ".systemsculpt";
const GITIGNORE_PATH = `${PLUGIN_FOLDER_PATH}/.gitignore`;
/**
 * Files in which a retired feature kept API keys and sign-in tokens in plain
 * text, one folder below the plugin folder. No current feature uses these
 * names there. A pattern without a slash matches at any depth under
 * .systemsculpt, so the ignore rules never need to name the retired feature.
 */
const CREDENTIAL_FILE_NAMES = ["auth.json", "models.json"] as const;
const IGNORE_COMMENT = "# Added by SystemSculpt: keeps plain-text credential files out of Git.";

type CredentialSearch = Readonly<{
  credentialFiles: readonly string[];
  /** Why part of the plugin folder could not be searched; the rules still cover it. */
  searchError?: string;
}>;

export type LegacyCredentialProtectionResult = Readonly<
  | ({ status: "protected" } & CredentialSearch)
  | ({ status: "unprotected"; error: string } & CredentialSearch)
>;

type ProtectionAdapter = Pick<DataAdapter, "append" | "exists" | "list" | "mkdir" | "read" | "write">;

/**
 * Keeps credential files in the plugin folder out of new Git commits, and
 * finds any that a retired feature left there. The ignore rules go into the
 * plugin folder before such a file appears, so a copy that arrives later
 * through sync or a restore is covered too. A new vault gets the folder with
 * its rules, as the plugin keeps its own storage there anyway. Credential
 * files are never read.
 *
 * This cannot remove a file that Git already tracks and it does not protect
 * cloud-sync or backup copies, so the notice for a found file says so.
 */
export async function protectLegacyCredentials(
  adapter: ProtectionAdapter,
): Promise<LegacyCredentialProtectionResult> {
  // The rules go in first: they protect every copy, found or not.
  let ignoreError: string | null = null;
  try {
    await ensureIgnoreRules(adapter);
  } catch (error) {
    ignoreError = errorMessage(error);
  }
  const search = await findCredentialFiles(adapter);
  return ignoreError === null
    ? { status: "protected", ...search }
    : { status: "unprotected", error: ignoreError, ...search };
}

/** The warning for credential files found in the plugin folder, or null when there are none. */
export function legacyCredentialNotice(result: LegacyCredentialProtectionResult): string | null {
  if (result.credentialFiles.length === 0) return null;
  const files = result.credentialFiles;
  const one = files.length === 1;
  const protection = result.status === "protected"
    ? "A Git ignore rule now keeps new untracked copies out of commits, but it cannot clean up existing copies."
    : `The Git ignore rule could not be added, so ${one ? "this file" : "these files"} can still be committed.`;
  return [
    `SystemSculpt found ${one ? "a file" : "files"} from a retired feature: ${files.join(", ")}.`,
    `${one ? "It" : "They"} may hold API keys or sign-in tokens in plain text, and SystemSculpt no longer uses ${one ? "it" : "them"}.`,
    `Rotate those keys and revoke those sign-ins with each provider, delete the ${one ? "file" : "files"}, and remove ${one ? "it" : "them"} from Git history, sync history, and backups.`,
    protection,
  ].join(" ");
}

/**
 * Credential files in the plugin folder or one of its folders. A folder that
 * cannot be listed or a file that cannot be checked is skipped, so what could
 * be searched is still reported.
 */
async function findCredentialFiles(adapter: ProtectionAdapter): Promise<CredentialSearch> {
  let searchError: string | undefined;
  let folders: string[] = [];
  try {
    folders = (await adapter.list(PLUGIN_FOLDER_PATH)).folders;
  } catch (error) {
    searchError = errorMessage(error);
  }
  const credentialFiles: string[] = [];
  for (const folder of [PLUGIN_FOLDER_PATH, ...folders]) {
    for (const name of CREDENTIAL_FILE_NAMES) {
      const path = `${folder}/${name}`;
      try {
        if (await adapter.exists(path)) credentialFiles.push(path);
      } catch (error) {
        searchError ??= errorMessage(error);
      }
    }
  }
  return searchError === undefined ? { credentialFiles } : { credentialFiles, searchError };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensurePluginFolder(adapter: ProtectionAdapter): Promise<void> {
  if (await adapter.exists(PLUGIN_FOLDER_PATH)) return;
  try {
    await adapter.mkdir(PLUGIN_FOLDER_PATH);
  } catch (error) {
    // Storage initialization makes the same folder at startup, and may win.
    if (!(await adapter.exists(PLUGIN_FOLDER_PATH))) throw error;
  }
}

async function ensureIgnoreRules(adapter: ProtectionAdapter): Promise<void> {
  await ensurePluginFolder(adapter);
  if (!(await adapter.exists(GITIGNORE_PATH))) {
    await adapter.write(GITIGNORE_PATH, [IGNORE_COMMENT, ...CREDENTIAL_FILE_NAMES, ""].join("\n"));
    return;
  }
  const current = await adapter.read(GITIGNORE_PATH);
  const missing = CREDENTIAL_FILE_NAMES.filter((rule) => !gitAppliesRule(current, rule));
  if (missing.length === 0) return;
  // Appending leaves concurrent edits to the rest of the file intact.
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await adapter.append(GITIGNORE_PATH, [`${separator}${IGNORE_COMMENT}`, ...missing, ""].join("\n"));
}

/**
 * Whether Git reads `rule` from this ignore file with no negation after it.
 * Git drops a CR before each newline and trailing spaces, but keeps leading
 * whitespace and tabs, and the last matching line wins.
 */
function gitAppliesRule(content: string, rule: string): boolean {
  let applies = false;
  for (const line of content.split("\n")) {
    const pattern = line.replace(/\r$/u, "").replace(/ +$/u, "");
    if (pattern === rule) applies = true;
    else if (pattern.startsWith("!")) applies = false;
  }
  return applies;
}
