import { isAbsoluteFilesystemPath, resolveAbsoluteVaultPath } from "../vaultPathUtils";

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
