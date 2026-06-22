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
  it("normalizes separators and trims vault-relative wrappers", () => {
    expect(normalizeVaultRelativePath(" /SystemSculpt\\Studio/Test.systemsculpt/ ")).toBe(
      "SystemSculpt/Studio/Test.systemsculpt",
    );
  });
});

describe("joinFilesystemPath", () => {
  it("joins windows filesystem bases with vault-relative segments", () => {
    expect(joinFilesystemPath("C:\\vault", ".systemsculpt/pi-agent/auth.json")).toBe(
      "C:\\vault\\.systemsculpt\\pi-agent\\auth.json",
    );
  });

  it("joins posix filesystem bases with vault-relative segments", () => {
    expect(joinFilesystemPath("/srv/obsidian/vault", ".systemsculpt/pi-agent/auth.json")).toBe(
      "/srv/obsidian/vault/.systemsculpt/pi-agent/auth.json",
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
