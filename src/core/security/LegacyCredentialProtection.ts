import type { DataAdapter } from "obsidian";

export const LEGACY_PI_AUTH_PATH = ".systemsculpt/pi-agent/auth.json";
export const SYSTEMSCULPT_GITIGNORE_PATH = ".systemsculpt/.gitignore";
const PI_AGENT_IGNORE_RULE = "/pi-agent/";

export type LegacyCredentialProtectionResult = Readonly<
  | { legacyCredentialsPresent: false }
  | { legacyCredentialsPresent: true; ignoreRulePresent: boolean; protectionError?: string }
>;

/**
 * Finds the retired Pi credential file and, while it is still in the vault,
 * keeps its folder out of new Git commits with an ignore rule. Vaults without
 * the file are left untouched.
 *
 * This cannot remove a file that Git already tracks and it does not protect
 * cloud-sync or backup copies. Callers must surface those limits whenever a
 * legacy credential file is still present.
 */
export async function protectLegacyPiCredentials(
  adapter: Pick<DataAdapter, "exists" | "read" | "write">,
): Promise<LegacyCredentialProtectionResult> {
  if (!(await adapter.exists(LEGACY_PI_AUTH_PATH))) return { legacyCredentialsPresent: false };
  try {
    const ignoreExists = await adapter.exists(SYSTEMSCULPT_GITIGNORE_PATH);
    const current = ignoreExists ? await adapter.read(SYSTEMSCULPT_GITIGNORE_PATH) : "";
    const lines = current.split(/\r?\n/u);
    const ignoreRulePresent = lines.some((line) => line.trim() === PI_AGENT_IGNORE_RULE);

    if (!ignoreRulePresent) {
      const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
      await adapter.write(
        SYSTEMSCULPT_GITIGNORE_PATH,
        `${prefix}${PI_AGENT_IGNORE_RULE}\n`,
      );
    }

    return { legacyCredentialsPresent: true, ignoreRulePresent: true };
  } catch (error) {
    return {
      legacyCredentialsPresent: true,
      ignoreRulePresent: false,
      protectionError: error instanceof Error ? error.message : String(error),
    };
  }
}
