import {
  isAbsoluteFilesystemPath,
  joinFilesystemPath,
  normalizeVaultRelativePath,
  resolveAbsoluteVaultPath,
} from "../vaultPathUtils";

describe("resolveAbsoluteVaultPath", () => {
  it("uses adapter getFullPath when available", () => {
    const absolute = resolveAbsoluteVaultPath(
      {
        getFullPath: (path: string) => `/vault/${path}`,
      },
      "SystemSculpt/Studio/Test.systemsculpt"
    );

    expect(absolute).toBe("/vault/SystemSculpt/Studio/Test.systemsculpt");
  });

  it("falls back to adapter basePath when getFullPath is unavailable", () => {
    const absolute = resolveAbsoluteVaultPath(
      {
        basePath: "/vault",
      },
      "SystemSculpt/Studio/Test.systemsculpt"
    );

    expect(absolute).toBe("/vault/SystemSculpt/Studio/Test.systemsculpt");
  });

  it("supports windows base paths", () => {
    const absolute = resolveAbsoluteVaultPath(
      {
        basePath: "C:\\vault",
      },
      "SystemSculpt/Studio/Test.systemsculpt"
    );

    expect(absolute).toBe("C:\\vault\\SystemSculpt\\Studio\\Test.systemsculpt");
  });

  it("returns null for empty vault paths", () => {
    const absolute = resolveAbsoluteVaultPath(
      {
        basePath: "/vault",
      },
      "  "
    );

    expect(absolute).toBeNull();
  });
});

describe("isAbsoluteFilesystemPath", () => {
  it("detects unix-style absolute paths", () => {
    expect(isAbsoluteFilesystemPath("/tmp/file.txt")).toBe(true);
  });

  it("detects windows-style absolute paths", () => {
    expect(isAbsoluteFilesystemPath("C:\\tmp\\file.txt")).toBe(true);
  });

  it("returns false for relative paths", () => {
    expect(isAbsoluteFilesystemPath("SystemSculpt/Studio/Test.systemsculpt")).toBe(false);
  });
});

describe("normalizeVaultRelativePath", () => {
  it.each([
    ["", ""],
    [" \t\n ", ""],
    ["/", ""],
    ["///", ""],
    [" /SystemSculpt\\Studio/Test.systemsculpt/ ", "SystemSculpt/Studio/Test.systemsculpt"],
    ["Notes//nested///note.md", "Notes/nested/note.md"],
    ["\\Notes\\\\nested\\note.md\\", "Notes/nested/note.md"],
    [".systemsculpt/cache.json", ".systemsculpt/cache.json"],
    ["./Notes/../note.md", "./Notes/../note.md"],
    ["My%20Folder/note%2520name.md", "My%20Folder/note%2520name.md"],
    ["café.md", "café.md"],
    ["My Notes/narrow space.md", "My Notes/narrow space.md"],
    ["CON/trailing. /note.md", "CON/trailing. /note.md"],
    ["笔记/日本語 café 📝.md", "笔记/日本語 café 📝.md"],
    ["Notes/ internal spaces /note.md", "Notes/ internal spaces /note.md"],
    ["Notes/Title (23:11) #tag [link] ^id.md", "Notes/Title (23:11) #tag [link] ^id.md"],
  ])("normalizes %j to %j without sanitizing filenames", (input, expected) => {
    expect(normalizeVaultRelativePath(input)).toBe(expected);
    expect(normalizeVaultRelativePath(expected)).toBe(expected);
  });
});

describe("normalization policies", () => {
  it.each([null, undefined])("accepts nullish UI input %j as the root", (input) => {
    expect(normalizeVaultRelativePath(input as unknown as string)).toBe("");
  });

  it("can preserve whitespace in paths supplied by the vault", () => {
    expect(normalizeVaultRelativePath(" Notes//note.md ", { trim: false })).toBe(" Notes/note.md ");
  });

  it.each([
    ["My%20Folder%2FNote.md", "My Folder/Note.md"],
    ["My%2520Folder%255CNote.md", "My Folder/Note.md"],
    ["%252520", "%20"],
    ["%20Name.md%20", " Name.md "],
    ["%E6%97%A5%E6%9C%AC%E8%AA%9E.md", "日本語.md"],
    ["%252E%252E%252FNote.md", "../Note.md"],
    ["%E0%A4%A", "%E0%A4%A"],
    ["%25E0%25A4%25A", "%E0%A4%A"],
    ["bad%zz%20name.md", "bad%zz%20name.md"],
    ["100%/Note.md", "100%/Note.md"],
  ])("decodes only opted-in tool input %j to %j", (input, expected) => {
    expect(normalizeVaultRelativePath(input, { decodeUri: true })).toBe(expected);
  });

  it("preserves literal character identity when the caller opts out of host normalization", () => {
    const literal = "café/with space here.md";
    expect(normalizeVaultRelativePath(literal)).toBe("café/with space here.md");
    expect(normalizeVaultRelativePath(literal, { preserveCharacters: true })).toBe(literal);
    expect(normalizeVaultRelativePath(encodeURIComponent(literal), {
      decodeUri: true,
      preserveCharacters: true,
    })).toBe(literal);
  });

  const staging = { trim: false, preserveCharacters: true, validateRelative: { allowLeadingDot: true } };
  const cleanup = { validateRelative: { allowRepeatedSeparators: true } };

  it.each([
    [".obsidian", ".obsidian"],
    ["./.obsidian/", ".obsidian"],
    [".\\.obsidian\\plugins\\systemsculpt-ai\\", ".obsidian/plugins/systemsculpt-ai"],
    [".obsidian///", ".obsidian"],
    [" config /plugins ", " config /plugins "],
    ["%2E%2E/config", "%2E%2E/config"],
    ["C:/config", "C:/config"],
  ])("preserves installed-directory acceptance for %j", (input, expected) => {
    expect(normalizeVaultRelativePath(input, staging)).toBe(expected);
  });

  it.each([
    "", "/", "\\", "//server/config", "/.obsidian", "\\.obsidian", ".", "..",
    "./", "././config", "config/./plugins", "config/../plugins", "config//plugins",
    "config\\\\plugins", null, undefined,
  ])("rejects invalid installed directory %j before repairing it", (input) => {
    expect(() => normalizeVaultRelativePath(input as string, staging)).toThrow("Invalid vault-relative directory path.");
  });

  it.each([
    "", " ", "/", ".", "..", "./Chats", "Chats/./old", "Chats/../old",
    " /Chats/ ", "\\Chats", "//server/Chats",
  ])("rejects unsafe cleanup scope %j before removing its root", (input) => {
    expect(() => normalizeVaultRelativePath(input, cleanup)).toThrow("Invalid vault-relative directory path.");
  });

  it.each([
    [" Chats//nested/// ", "Chats/nested"],
    ["Chats\\nested\\", "Chats/nested"],
    ["%2E%2E/Chats", "%2E%2E/Chats"],
    ["C:/Chats", "C:/Chats"],
  ])("normalizes accepted cleanup scope %j", (input, expected) => {
    expect(normalizeVaultRelativePath(input, cleanup)).toBe(expected);
  });

  it("validates after optional decoding, not before", () => {
    expect(() => normalizeVaultRelativePath("%252E%252E%252FNotes", {
      decodeUri: true,
      validateRelative: {},
    })).toThrow("Invalid vault-relative directory path.");
  });
});

describe("joinFilesystemPath", () => {
  it("joins windows filesystem bases with vault-relative segments", () => {
    expect(joinFilesystemPath("C:\\vault", ".systemsculpt/runtime/cache.json")).toBe(
      "C:\\vault\\.systemsculpt\\runtime\\cache.json",
    );
  });

  it("joins posix filesystem bases with vault-relative segments", () => {
    expect(joinFilesystemPath("/srv/obsidian/vault", ".systemsculpt/runtime/cache.json")).toBe(
      "/srv/obsidian/vault/.systemsculpt/runtime/cache.json",
    );
  });

  it("trims a trailing separator off the base instead of doubling it", () => {
    expect(joinFilesystemPath("/vault/", "notes/today.md")).toBe("/vault/notes/today.md");
    expect(joinFilesystemPath("C:\\vault\\", "a/b")).toBe("C:\\vault\\a\\b");
  });

  it("returns the base unchanged when no segments are provided", () => {
    expect(joinFilesystemPath("/vault")).toBe("/vault");
  });
});
