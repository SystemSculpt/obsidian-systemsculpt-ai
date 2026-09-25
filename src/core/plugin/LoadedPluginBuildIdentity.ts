import { normalizePath, requireApiVersion, type App, type PluginManifest } from "obsidian";
import { getDevelopmentBuildIdentity } from "./DevelopmentBuildIdentity";

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
/** Device-local memo of the last hashed bundle, keyed by its file stat. */
const BUILD_ID_CACHE_KEY = "systemsculpt-ai:loaded-bundle-identity-v2";

/**
 * The memo key. ctime changes whenever the file's metadata or bytes are
 * written, so a same-size bundle restored with its old mtime still misses;
 * an inode is included where the adapter exposes one.
 */
type BundleStat = Readonly<{ mtime: number; ctime: number; size: number; ino: number | null }>;
type CachedBuildId = BundleStat & Readonly<{ path: string; digest: string }>;

function sameStat(left: BundleStat, right: Partial<BundleStat>): boolean {
  return left.mtime === right.mtime
    && left.ctime === right.ctime
    && left.size === right.size
    && left.ino === (right.ino ?? null);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const crypto = window.crypto;
  if (!crypto?.subtle) {
    throw new Error("This Obsidian host cannot verify the loaded plugin artifact.");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function statBundle(app: App, path: string): Promise<BundleStat | null> {
  try {
    const stat = await app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") return null;
    if (
      !Number.isFinite(stat.mtime)
      || !Number.isFinite(stat.ctime)
      || !Number.isSafeInteger(stat.size)
      || stat.size < 0
    ) return null;
    const ino = (stat as { ino?: unknown }).ino;
    return {
      mtime: stat.mtime,
      ctime: stat.ctime,
      size: stat.size,
      ino: typeof ino === "number" && Number.isSafeInteger(ino) ? ino : null,
    };
  } catch {
    return null;
  }
}

/** Vault-scoped localStorage exists from Obsidian 1.8.7; older hosts always hash. */
function readCachedBuildId(app: App, path: string, stat: BundleStat): string | null {
  try {
    if (requireApiVersion("1.8.7")) {
      const cached = app.loadLocalStorage(BUILD_ID_CACHE_KEY) as Partial<CachedBuildId> | null;
      if (
        cached
        && cached.path === path
        && sameStat(stat, cached)
        && typeof cached.digest === "string"
        && SHA256_DIGEST.test(cached.digest)
      ) return cached.digest;
    }
  } catch {
    // An unreadable memo only means the bundle is hashed again.
  }
  return null;
}

function writeCachedBuildId(app: App, value: CachedBuildId): void {
  try {
    if (requireApiVersion("1.8.7")) app.saveLocalStorage(BUILD_ID_CACHE_KEY, value);
  } catch {
    // The memo only saves the next launch a read; hashing stays authoritative.
  }
}

/**
 * Returns the identity of the installed main.js bytes at agent bootstrap.
 * Development sync manifests record the expected digest, but every install is
 * independently read from the active plugin directory and hashed.
 *
 * A release install's digest is memoized per device by the bundle's mtime,
 * ctime, size, and inode where exposed, so an unchanged install is not
 * re-read and re-hashed at every launch (#343). The memo is written only when
 * the stat is identical before and after the read. A development install is
 * always re-read and hashed, because its manifest comparison must verify the
 * bytes actually installed.
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
    const memoizable = !development;
    const before = memoizable ? await statBundle(app, path) : null;
    const cached = before ? readCachedBuildId(app, path, before) : null;
    if (cached) return `sha256:${cached}`;

    const bytes = await app.vault.adapter.readBinary(path);
    const digest = await sha256(bytes);
    if (!SHA256_DIGEST.test(digest)) throw new Error("Invalid SHA-256 digest.");
    if (recorded && recorded !== digest) {
      throw new Error(
        "The installed plugin bundle does not match its development build manifest.",
      );
    }
    if (before && before.size === bytes.byteLength) {
      const after = await statBundle(app, path);
      if (after && sameStat(before, after)) writeCachedBuildId(app, { path, ...before, digest });
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
