import {
  legacyCredentialNotice,
  protectLegacyCredentials,
} from "../LegacyCredentialProtection";

const IGNORE_FILE = ".systemsculpt/.gitignore";
const LEFT_BEHIND_AUTH = ".systemsculpt/retired-agent/auth.json";
const LEFT_BEHIND_MODELS = ".systemsculpt/retired-agent/models.json";
const BACKUP = ".systemsculpt/settings-backups/latest.json";
const IGNORE_RULES = [
  "# Added by SystemSculpt: keeps plain-text credential files out of Git.",
  "auth.json",
  "models.json",
  "",
].join("\n");

/** An in-memory vault adapter whose folders are made or implied by its file paths. */
function adapter(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const folders = new Set<string>();
  const isFolder = (path: string) =>
    folders.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
  return {
    files,
    exists: jest.fn(async (path: string) => files.has(path) || isFolder(path)),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    list: jest.fn(async (path: string) => {
      const children = [...files.keys()]
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1).split("/"));
      return {
        files: children.filter((parts) => parts.length === 1).map(([name]) => `${path}/${name}`),
        folders: [...new Set(children.filter((parts) => parts.length > 1).map(([name]) => `${path}/${name}`))],
      };
    }),
    read: jest.fn(async (path: string) => files.get(path) ?? ""),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
    append: jest.fn(async (path: string, content: string) => { files.set(path, `${files.get(path) ?? ""}${content}`); }),
  };
}

describe("protectLegacyCredentials", () => {
  it("ignores credential files in the plugin folder before any appears", async () => {
    const target = adapter({ [BACKUP]: "{}" });

    await expect(protectLegacyCredentials(target)).resolves.toEqual({
      status: "protected",
      credentialFiles: [],
    });
    expect(target.files.get(IGNORE_FILE)).toBe(IGNORE_RULES);
  });

  it("reports credential files a retired feature left in a plugin subfolder without reading them", async () => {
    const target = adapter({
      [LEFT_BEHIND_AUTH]: "{}",
      [LEFT_BEHIND_MODELS]: "{}",
      [BACKUP]: "{}",
      [IGNORE_FILE]: "cache/\n",
    });

    await expect(protectLegacyCredentials(target)).resolves.toEqual({
      status: "protected",
      credentialFiles: [LEFT_BEHIND_AUTH, LEFT_BEHIND_MODELS],
    });
    expect(target.read.mock.calls).toEqual([[IGNORE_FILE]]);
  });

  it("appends to an existing ignore file once, leaving its content in place", async () => {
    const target = adapter({ [LEFT_BEHIND_AUTH]: "{}", [IGNORE_FILE]: "cache/" });

    await protectLegacyCredentials(target);
    await protectLegacyCredentials(target);

    expect(target.files.get(IGNORE_FILE)).toBe(`cache/\n${IGNORE_RULES}`);
    expect(target.append).toHaveBeenCalledTimes(1);
    expect(target.write).not.toHaveBeenCalled();
  });

  it("leaves rules that Git already applies alone, whatever their line endings", async () => {
    const target = adapter({
      [BACKUP]: "{}",
      [IGNORE_FILE]: "# local\r\n!keep.md\r\nauth.json  \r\nmodels.json\r\n",
    });

    await protectLegacyCredentials(target);

    expect(target.append).not.toHaveBeenCalled();
    expect(target.write).not.toHaveBeenCalled();
  });

  it.each([
    ["a commented-out rule", "# auth.json\nmodels.json\n", "auth.json\n"],
    ["leading whitespace", "  auth.json\nmodels.json\n", "auth.json\n"],
    ["a trailing tab", "auth.json\t\nmodels.json\n", "auth.json\n"],
    ["a later negation", "auth.json\nmodels.json\n!*.json\n", "auth.json\nmodels.json\n"],
  ])("adds rules Git would not apply because of %s", async (_case, existing, added) => {
    const target = adapter({ [BACKUP]: "{}", [IGNORE_FILE]: existing });

    await protectLegacyCredentials(target);

    expect(target.append).toHaveBeenCalledWith(
      IGNORE_FILE,
      `# Added by SystemSculpt: keeps plain-text credential files out of Git.\n${added}`,
    );
  });

  it("gives a new vault the plugin folder with its rules, and looks nowhere else", async () => {
    const target = adapter({ "Notes/auth.json": "{}" });

    await expect(protectLegacyCredentials(target)).resolves.toEqual({
      status: "protected",
      credentialFiles: [],
    });
    expect(target.mkdir).toHaveBeenCalledWith(".systemsculpt");
    expect(target.files.get(IGNORE_FILE)).toBe(IGNORE_RULES);
  });

  it("adds the rules when storage makes the plugin folder at the same moment", async () => {
    const target = adapter();
    target.mkdir.mockImplementationOnce(async (path: string) => {
      target.files.set(`${path}/settings/.keep`, "");
      throw new Error("Directory exists");
    });

    await expect(protectLegacyCredentials(target)).resolves.toEqual({
      status: "protected",
      credentialFiles: [],
    });
    expect(target.files.get(IGNORE_FILE)).toBe(IGNORE_RULES);
  });

  it("reports a plugin folder that cannot be made", async () => {
    const target = adapter();
    target.mkdir.mockRejectedValueOnce(new Error("read only"));

    await expect(protectLegacyCredentials(target)).resolves.toMatchObject({
      status: "unprotected",
      error: "read only",
      credentialFiles: [],
    });
  });

  it("does not remake a plugin folder that exists", async () => {
    const target = adapter({ [BACKUP]: "{}" });

    await protectLegacyCredentials(target);

    expect(target.mkdir).not.toHaveBeenCalled();
  });

  it("adds the rules and reports what it could search when the plugin folder cannot be listed", async () => {
    const target = adapter({ ".systemsculpt/auth.json": "{}", [LEFT_BEHIND_AUTH]: "{}" });
    target.list.mockRejectedValueOnce(new Error("permission denied"));

    await expect(protectLegacyCredentials(target)).resolves.toEqual({
      status: "protected",
      credentialFiles: [".systemsculpt/auth.json"],
      searchError: "permission denied",
    });
    expect(target.files.get(IGNORE_FILE)).toBe(IGNORE_RULES);
  });

  it("still reports credential files when the ignore file cannot be written", async () => {
    const target = adapter({ [LEFT_BEHIND_AUTH]: "{}" });
    target.write.mockRejectedValueOnce(new Error("read only"));

    await expect(protectLegacyCredentials(target)).resolves.toEqual({
      status: "unprotected",
      credentialFiles: [LEFT_BEHIND_AUTH],
      error: "read only",
    });
  });
});

describe("legacyCredentialNotice", () => {
  it("stays quiet when no credential file was found", () => {
    expect(legacyCredentialNotice({ status: "protected", credentialFiles: [] })).toBeNull();
    expect(legacyCredentialNotice({ status: "unprotected", credentialFiles: [], error: "read only" })).toBeNull();
  });

  it("names the file, covers sign-in tokens and states what the ignore rule cannot do", () => {
    expect(legacyCredentialNotice({ status: "protected", credentialFiles: [LEFT_BEHIND_AUTH] })).toBe(
      `SystemSculpt found a file from a retired feature: ${LEFT_BEHIND_AUTH}. ` +
        "It may hold API keys or sign-in tokens in plain text, and SystemSculpt no longer uses it. " +
        "Rotate those keys and revoke those sign-ins with each provider, delete the file, " +
        "and remove it from Git history, sync history, and backups. " +
        "A Git ignore rule now keeps new untracked copies out of commits, but it cannot clean up existing copies.",
    );
  });

  it("warns that the files can still be committed when the ignore rule is missing", () => {
    const notice = legacyCredentialNotice({
      status: "unprotected",
      credentialFiles: [LEFT_BEHIND_AUTH, LEFT_BEHIND_MODELS],
      error: "read only",
    });

    expect(notice).toContain(`files from a retired feature: ${LEFT_BEHIND_AUTH}, ${LEFT_BEHIND_MODELS}.`);
    expect(notice).toContain("They may hold API keys or sign-in tokens");
    expect(notice).toContain("delete the files, and remove them");
    expect(notice).toMatch(/The Git ignore rule could not be added, so these files can still be committed\.$/u);
  });
});
