import { normalizePath, type App, type PluginManifest } from "obsidian";
import { getDevelopmentBuildIdentity } from "./DevelopmentBuildIdentity";

const SHA256_DIGEST = /^[a-f0-9]{64}$/;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  // Artifact hashing is host-level work, not UI bound to a popout window.
  // eslint-disable-next-line obsidianmd/no-global-this
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("This Obsidian host cannot verify the loaded plugin artifact.");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns the identity of the installed main.js bytes at agent bootstrap.
 * Development sync manifests record the expected digest, but every install is
 * independently read from the active plugin directory and hashed.
 */
export async function getLoadedPluginBuildId(
  app: App,
  manifest: PluginManifest,
): Promise<`sha256:${string}`> {
  const development = getDevelopmentBuildIdentity(manifest);
  const recorded = development?.artifacts["main.js"];
  const path = normalizePath([
    app.vault.configDir,
    "plugins",
    manifest.id,
    "main.js",
  ].join("/"));
  try {
    const bytes = await app.vault.adapter.readBinary(path);
    const digest = await sha256(bytes);
    if (!SHA256_DIGEST.test(digest)) throw new Error("Invalid SHA-256 digest.");
    if (recorded && recorded !== digest) {
      throw new Error(
        "The installed plugin bundle does not match its development build manifest.",
      );
    }
    return `sha256:${digest}`;
  } catch (error) {
    const failure = new Error(
      "SystemSculpt could not verify this plugin update. Reload Obsidian and try again.",
    ) as Error & { cause?: unknown };
    failure.cause = error;
    throw failure;
  }
}
