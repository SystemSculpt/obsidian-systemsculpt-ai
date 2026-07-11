import { readFileSync } from "node:fs";
import path from "node:path";
import { ManagedJobClient } from "../../src/services/managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../../src/services/managed/ManagedJobRecoveryStore";

describe("managed job primitives import safety", () => {
  it("uses mobile-safe modules with no eager Node builtin or fixture import", () => {
    const sources = [ManagedJobClient.toString(), ManagedJobRecoveryStore.toString()].join("\n");
    expect(sources).not.toMatch(/node:|require\(["'](?:fs|path|crypto)["']\)/);
    expect(sources).not.toContain("testing/fixtures");
  });

  it("does not cut the additive primitives or protocol fixture into the production bundle", () => {
    const bundle = readFileSync(path.resolve(__dirname, "..", "..", "main.js"), "utf8");
    expect(bundle).not.toContain("managed-job-protocol-v1.json");
    expect(bundle).not.toContain("class ManagedJobRecoveryStore");
  });
});
