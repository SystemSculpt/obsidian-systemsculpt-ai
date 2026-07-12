/** @jest-environment node */

import { readFileSync } from "node:fs";
import path from "node:path";

jest.mock("../../constants/externalServices", () => ({
  GITHUB_API: {
    RELEASE_URL: (owner: string, repo: string) => `https://github.com/${owner}/${repo}/releases`,
  },
}));

import {
  BUNDLED_CHANGELOG_ENTRIES,
  ChangeLogService,
  GITHUB_OWNER,
  GITHUB_REPO,
} from "../ChangeLogService";

describe("ChangeLogService", () => {
  it("keeps the manual releases-page link", () => {
    expect(ChangeLogService.getReleasesPageUrl()).toBe(
      "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases",
    );
    expect(GITHUB_OWNER).toBe("SystemSculpt");
    expect(GITHUB_REPO).toBe("obsidian-systemsculpt-ai");
  });

  it("serves an explicit bundled 5.11.0 entry without reading storage", async () => {
    const storage = {
      readFile: jest.fn(() => Promise.reject(new Error("must not read"))),
      writeFile: jest.fn(() => Promise.reject(new Error("must not write"))),
    };

    const entries = await ChangeLogService.getReleases({ storage } as any, {
      forceRefresh: true,
      allowStale: false,
    });

    const entry = entries.find((candidate) => candidate.version === "5.11.0");
    expect(entry).toMatchObject({
      version: "5.11.0",
      date: "Jul 2026",
      url: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases",
    });
    expect(entry?.notes).toContain("Studio text nodes");
    expect(entry?.notes).toContain("Chat Resend");
    expect(storage.readFile).not.toHaveBeenCalled();
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("returns defensive copies of the bundled data", async () => {
    const first = await ChangeLogService.getReleases();
    first[0].notes = "mutated";
    const second = await ChangeLogService.getReleases();

    expect(second[0].notes).toBe(BUNDLED_CHANGELOG_ENTRIES[0].notes);
    expect(second[0].notes).not.toBe("mutated");
  });

  it("contains no automatic changelog transport or startup warmup", () => {
    const serviceSource = readFileSync(
      path.resolve(process.cwd(), "src/services/ChangeLogService.ts"),
      "utf8",
    );
    const mainSource = readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");

    expect(serviceSource).not.toMatch(/httpRequest|GITHUB_API\.RELEASES|api\.github\.com/);
    expect(serviceSource).not.toContain("warmCache");
    expect(mainSource).not.toContain("ChangeLogService.warmCache");
  });

  it("finds versions with or without a v prefix", () => {
    const entries = [
      { version: "2.0.0", date: "2025-02-01", notes: "", url: "" },
      { version: "v1.0.0", date: "2025-01-01", notes: "", url: "" },
    ];

    expect(ChangeLogService.findIndexByVersion(entries, "2.0.0")).toBe(0);
    expect(ChangeLogService.findIndexByVersion(entries, "1.0.0")).toBe(1);
    expect(ChangeLogService.findIndexByVersion(entries, "v1.0.0")).toBe(1);
    expect(ChangeLogService.findIndexByVersion(entries, undefined)).toBe(0);
    expect(ChangeLogService.findIndexByVersion(entries, "99.0.0")).toBe(0);
    expect(ChangeLogService.findIndexByVersion([], "1.0.0")).toBe(0);
  });
});
