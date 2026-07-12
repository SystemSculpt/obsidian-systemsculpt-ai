import * as fs from "node:fs";
import * as path from "node:path";

const srcRoot = path.resolve(__dirname, "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
}

describe("retired Readwise integration", () => {
  it("has no production service, widget, settings screen, or centralized endpoint", () => {
    expect(fs.existsSync(path.join(srcRoot, "services/readwise"))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, "components/ReadwiseSyncWidget.ts"))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, "settings/DataTabContent.ts"))).toBe(false);

    expect(readSource("main.ts")).not.toMatch(/Readwise|readwise/);
    expect(readSource("settings/SettingsTabRegistry.ts")).not.toMatch(/Readwise|readwise/);
    expect(readSource("constants/externalServices.ts")).not.toMatch(/Readwise|readwise/);
  });

  it("keeps legacy settings inert while omitting the retired token from backups", () => {
    const settingsTypes = readSource("types.ts");
    expect(settingsTypes).toContain('readwiseApiToken: ""');

    const runtimeSources = [
      "main.ts",
      "settings/SettingsTabRegistry.ts",
      "core/settings/backupSanitizer.ts",
    ].map(readSource).join("\n");
    expect(runtimeSources).not.toContain(".systemsculpt/readwise");
  });
});
