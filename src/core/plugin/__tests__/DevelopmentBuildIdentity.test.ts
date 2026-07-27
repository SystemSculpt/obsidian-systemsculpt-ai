import {
  formatDevelopmentBuildLabel,
  getDevelopmentBuildIdentity,
} from "../DevelopmentBuildIdentity";

const digest = "a".repeat(64);
const manifest = {
  id: "systemsculpt-ai",
  version: "6.2.2",
  systemsculptDevBuild: {
    schemaVersion: 1,
    id: "310f308f-dirty-20260726T205500Z",
    revision: "310f308f062877899ca0f3247b9d5531f3413a3c",
    branch: "codex/systemsculpt-dev-auto-build",
    dirty: true,
    syncedAt: "2026-07-26T20:55:00.000Z",
    sourcePath: "/workspace/plugin",
    artifacts: {
      "main.js": digest,
      "manifest.json": digest,
      "styles.css": digest,
    },
  },
};

describe("development build identity", () => {
  it("parses the local-only manifest identity and formats a visible label", () => {
    expect(getDevelopmentBuildIdentity(manifest as never)).toEqual(
      expect.objectContaining({
        id: "310f308f-dirty-20260726T205500Z",
        dirty: true,
      }),
    );
    expect(formatDevelopmentBuildLabel(manifest as never))
      .toBe("DEV 310f308f-dirty-20260726T205500Z");
  });

  it.each([
    {},
    { ...manifest, systemsculptDevBuild: { ...manifest.systemsculptDevBuild, id: "bad id" } },
    {
      ...manifest,
      systemsculptDevBuild: {
        ...manifest.systemsculptDevBuild,
        artifacts: { ...manifest.systemsculptDevBuild.artifacts, "main.js": "short" },
      },
    },
  ])("rejects absent or malformed development identity", (value) => {
    expect(getDevelopmentBuildIdentity(value as never)).toBeNull();
    expect(formatDevelopmentBuildLabel(value as never)).toBeNull();
  });
});
