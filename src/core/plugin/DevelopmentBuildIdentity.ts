import type { PluginManifest } from "obsidian";

export const DEVELOPMENT_BUILD_MANIFEST_KEY = "systemsculptDevBuild" as const;

export type DevelopmentBuildIdentity = Readonly<{
  schemaVersion: 1;
  id: string;
  revision: string;
  branch: string;
  dirty: boolean;
  syncedAt: string;
  sourcePath: string;
  artifacts: Readonly<Record<"main.js" | "manifest.json" | "styles.css", string>>;
}>;

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[A-Za-z0-9._+-]{1,96}$/;

export function getDevelopmentBuildIdentity(
  manifest: PluginManifest | Record<string, unknown>,
): DevelopmentBuildIdentity | null {
  const candidate = (manifest as unknown as Record<string, unknown>)[DEVELOPMENT_BUILD_MANIFEST_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;

  const value = candidate as Record<string, unknown>;
  const artifacts = value.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return null;
  const artifactRecord = artifacts as Record<string, unknown>;
  if (
    value.schemaVersion !== 1
    || typeof value.id !== "string"
    || !BUILD_ID.test(value.id)
    || typeof value.revision !== "string"
    || !/^[a-f0-9]{7,64}$/.test(value.revision)
    || typeof value.branch !== "string"
    || value.branch.length < 1
    || value.branch.length > 256
    || typeof value.dirty !== "boolean"
    || typeof value.syncedAt !== "string"
    || !Number.isFinite(Date.parse(value.syncedAt))
    || typeof value.sourcePath !== "string"
    || value.sourcePath.length < 1
    || value.sourcePath.length > 2048
    || Object.keys(artifactRecord).sort().join(",") !== "main.js,manifest.json,styles.css"
    || !HEX_DIGEST.test(String(artifactRecord["main.js"] ?? ""))
    || !HEX_DIGEST.test(String(artifactRecord["manifest.json"] ?? ""))
    || !HEX_DIGEST.test(String(artifactRecord["styles.css"] ?? ""))
  ) {
    return null;
  }

  return Object.freeze({
    schemaVersion: 1,
    id: value.id,
    revision: value.revision,
    branch: value.branch,
    dirty: value.dirty,
    syncedAt: value.syncedAt,
    sourcePath: value.sourcePath,
    artifacts: Object.freeze({
      "main.js": artifactRecord["main.js"] as string,
      "manifest.json": artifactRecord["manifest.json"] as string,
      "styles.css": artifactRecord["styles.css"] as string,
    }),
  });
}

export function formatDevelopmentBuildLabel(
  manifest: PluginManifest | Record<string, unknown>,
): string | null {
  const build = getDevelopmentBuildIdentity(manifest);
  return build ? `DEV ${build.id}` : null;
}
