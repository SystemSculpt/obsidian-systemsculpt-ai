import {
  LEGACY_PI_AUTH_PATH,
  SYSTEMSCULPT_GITIGNORE_PATH,
  protectLegacyPiCredentials,
} from "../LegacyCredentialProtection";

function adapter(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: jest.fn(async (path: string) => files.has(path)),
    read: jest.fn(async (path: string) => files.get(path) ?? ""),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
  };
}

describe("protectLegacyPiCredentials", () => {
  it("creates a scoped ignore rule and reports a legacy credential file", async () => {
    const target = adapter({ [LEGACY_PI_AUTH_PATH]: "{}" });

    await expect(protectLegacyPiCredentials(target)).resolves.toEqual({
      legacyCredentialsPresent: true,
      ignoreRulePresent: true,
    });
    expect(target.files.get(SYSTEMSCULPT_GITIGNORE_PATH)).toBe("/pi-agent/\n");
  });

  it("preserves existing ignore content and is idempotent", async () => {
    const target = adapter({ [SYSTEMSCULPT_GITIGNORE_PATH]: "cache/" });

    await protectLegacyPiCredentials(target);
    await protectLegacyPiCredentials(target);

    expect(target.files.get(SYSTEMSCULPT_GITIGNORE_PATH)).toBe("cache/\n/pi-agent/\n");
    expect(target.write).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite an existing exact rule", async () => {
    const target = adapter({ [SYSTEMSCULPT_GITIGNORE_PATH]: "# local\n/pi-agent/\n" });

    await expect(protectLegacyPiCredentials(target)).resolves.toEqual({
      legacyCredentialsPresent: false,
      ignoreRulePresent: true,
    });
    expect(target.write).not.toHaveBeenCalled();
  });
});
