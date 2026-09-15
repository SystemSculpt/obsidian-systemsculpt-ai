import type { DataAdapter } from "obsidian";

export const LEGACY_PI_AUTH_PATH = ".systemsculpt/pi-agent/auth.json";
export const SYSTEMSCULPT_GITIGNORE_PATH = ".systemsculpt/.gitignore";
const PI_AGENT_IGNORE_RULE = "/pi-agent/";

export type LegacyCredentialProtectionResult = Readonly<{
  legacyCredentialsPresent: boolean;
  ignoreRulePresent: boolean;
}>;

/**
 * Hardens the retired Pi credential location against new Git commits.
 *
 * This cannot remove a file that Git already tracks and it does not protect
 * cloud-sync or backup copies. Callers must surface those limits whenever a
 * legacy credential file is still present.
 */
export async function protectLegacyPiCredentials(
  adapter: Pick<DataAdapter, "exists" | "read" | "write">,
): Promise<LegacyCredentialProtectionResult> {
  const legacyCredentialsPresent = await adapter.exists(LEGACY_PI_AUTH_PATH);
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

  return { legacyCredentialsPresent, ignoreRulePresent: true };
}
