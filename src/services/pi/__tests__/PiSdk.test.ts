import {
  buildPiSdkModuleImportSpecifier,
  shouldRetryPiSdkRequireWithDynamicImport,
} from "../PiSdk";

describe("PiSdk", () => {
  describe("buildPiSdkModuleImportSpecifier", () => {
    it("builds a POSIX file URL for local bundled entries", () => {
      expect(buildPiSdkModuleImportSpecifier("/tmp/pi runtime/dist/index.js")).toBe(
        "file:///tmp/pi%20runtime/dist/index.js"
      );
    });

    it("builds a Windows-safe file URL for bundled entries", () => {
      expect(buildPiSdkModuleImportSpecifier("C:\\Users\\mike\\Pi Runtime\\dist\\index.js")).toBe(
        "file:///C:/Users/mike/Pi%20Runtime/dist/index.js"
      );
    });
  });

  describe("shouldRetryPiSdkRequireWithDynamicImport", () => {
    it("retries for ERR_REQUIRE_ESM-style Node errors", () => {
      const error = new Error(
        "require() of ES Module C:\\Users\\mike\\.obsidian\\plugins\\systemsculpt-ai\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\index.js not supported."
      ) as Error & { code?: string };
      error.code = "ERR_REQUIRE_ESM";

      expect(shouldRetryPiSdkRequireWithDynamicImport(error)).toBe(true);
    });

    it("retries when the error message explicitly recommends import()", () => {
      expect(
        shouldRetryPiSdkRequireWithDynamicImport(
          new Error(
            "Must use import to load ES Module. Instead change the require of index.js to a dynamic import() which is available in all CommonJS modules."
          )
        )
      ).toBe(true);
    });

    it("does not hide unrelated runtime resolution errors", () => {
      expect(
        shouldRetryPiSdkRequireWithDynamicImport(new Error("Cannot find module '@mariozechner/pi-coding-agent'"))
      ).toBe(false);
    });
  });
});
