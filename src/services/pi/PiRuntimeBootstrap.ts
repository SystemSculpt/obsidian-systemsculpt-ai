import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import * as tar from "tar";
import type SystemSculptPlugin from "../../main";

const PI_RUNTIME_ENTRY_PACKAGE = "@mariozechner/pi-coding-agent";
const PI_RUNTIME_MANIFEST_FILE_NAME = "studio-pi-runtime-manifest.json";
const PI_RUNTIME_MANIFEST_SCHEMA = "studio.pi-runtime-manifest.v1";
const DEFAULT_RELEASE_REPO = "systemsculpt/obsidian-systemsculpt-ai";
const BOOTSTRAP_SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
]);

type RuntimeAssetRecord = {
  fileName: string;
  sha256: string;
  sizeBytes?: number;
  url?: string;
};

type RuntimeManifest = {
  schema: string;
  entryPackageName: string;
  entryPackageVersion: string;
  generatedAt?: string;
  packageRoots: string[];
  assets: Record<string, RuntimeAssetRecord>;
};

export type PiRuntimeBootstrapResult = {
  installedRuntime: boolean;
  packageCount: number;
  manifestUrl?: string;
  assetUrl?: string;
};

export type PiRuntimeBootstrapOptions = {
  platform?: string;
  arch?: string;
  pluginInstallDir?: string;
  releaseBaseUrl?: string;
  manifestUrl?: string;
  fetchBinary?: (url: string) => Promise<Buffer>;
};

type PiPackageRecord = {
  dir: string;
  packageJson: {
    name?: string;
    dependencies?: Record<string, string>;
  };
};

type PiRuntimeContext = {
  pluginInstallDir: string;
  pluginVersion?: string;
  pluginId?: string;
};

const installPromiseByKey = new Map<string, Promise<PiRuntimeBootstrapResult>>();
let registeredPiRuntimeContext: PiRuntimeContext | null = null;

function readJsonFile<T>(absolutePath: string): T {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function packageNameToPath(packageName: string): string[] {
  return packageName.split("/");
}

function resolveTarget(platform: string, arch: string): string {
  return `${String(platform || "").trim()}-${String(arch || "").trim()}`;
}

function resolvePiPackageRoot(pluginInstallDir: string): string {
  return join(pluginInstallDir, "node_modules", ...packageNameToPath(PI_RUNTIME_ENTRY_PACKAGE));
}

function resolvePiEntryPath(pluginInstallDir: string): string {
  return join(resolvePiPackageRoot(pluginInstallDir), "dist", "index.js");
}

function resolvePiCliPath(pluginInstallDir: string): string {
  return join(resolvePiPackageRoot(pluginInstallDir), "dist", "cli.js");
}

function ensureExists(absolutePath: string, message?: string): void {
  if (!existsSync(absolutePath)) {
    throw new Error(message || `Missing required path: ${absolutePath}`);
  }
}

function toRelativeSegments(relativePath: string): string[] {
  return String(relativePath || "")
    .split(/[\\/]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPackageRecord(packageDir: string): PiPackageRecord {
  const packageJsonPath = join(packageDir, "package.json");
  ensureExists(packageJsonPath, `Pi runtime package metadata missing: ${packageJsonPath}`);
  return {
    dir: packageDir,
    packageJson: readJsonFile(packageJsonPath),
  };
}

function resolveInstalledPackageDir(packageName: string, issuerDir: string, pluginInstallDir: string): string | null {
  const segments = packageNameToPath(packageName);
  const normalizedRoot = resolvePath(pluginInstallDir);
  let current = resolvePath(issuerDir);

  while (true) {
    const candidate = join(current, "node_modules", ...segments);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }

    if (current === normalizedRoot) {
      break;
    }

    const parent = dirname(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }

  const fallback = join(normalizedRoot, "node_modules", ...segments);
  if (existsSync(join(fallback, "package.json"))) {
    return fallback;
  }

  return null;
}

function collectInstalledRuntimePackages(pluginInstallDir: string): PiPackageRecord[] | null {
  const entryPackageDir = resolvePiPackageRoot(pluginInstallDir);
  if (!existsSync(join(entryPackageDir, "package.json"))) {
    return null;
  }
  if (!existsSync(resolvePiEntryPath(pluginInstallDir)) || !existsSync(resolvePiCliPath(pluginInstallDir))) {
    return null;
  }

  const queue = [entryPackageDir];
  const seenDirs = new Set<string>();
  const packages: PiPackageRecord[] = [];

  while (queue.length > 0) {
    const packageDir = resolvePath(String(queue.shift() || ""));
    if (!packageDir || seenDirs.has(packageDir)) {
      continue;
    }
    seenDirs.add(packageDir);

    const packageRecord = readPackageRecord(packageDir);
    packages.push(packageRecord);

    const dependencyNames = Object.keys(packageRecord.packageJson.dependencies || {}).sort();
    for (const dependencyName of dependencyNames) {
      const dependencyDir = resolveInstalledPackageDir(dependencyName, packageDir, pluginInstallDir);
      if (!dependencyDir) {
        return null;
      }
      queue.push(dependencyDir);
    }
  }

  return packages;
}

function runtimeLooksInstalled(pluginInstallDir: string): boolean {
  return Array.isArray(collectInstalledRuntimePackages(pluginInstallDir));
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function defaultFetchBinary(url: string, redirects = 0): Promise<Buffer> {
  const maxRedirects = 5;
  if (redirects > maxRedirects) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  const get = url.startsWith("https://") ? httpsGet : httpGet;
  return await new Promise<Buffer>((resolve, reject) => {
    const request = get(url, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const location = new URL(response.headers.location, url).toString();
        void defaultFetchBinary(location, redirects + 1).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} while downloading ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
    });

    request.on("error", reject);
  });
}

function resolveVaultBasePath(plugin: SystemSculptPlugin): string {
  const adapter = plugin.app?.vault?.adapter as {
    getBasePath?: () => string;
    basePath?: string;
  };
  const fromGetter =
    typeof adapter?.getBasePath === "function" ? String(adapter.getBasePath() || "").trim() : "";
  if (fromGetter) {
    return fromGetter;
  }
  const fromBasePath = String(adapter?.basePath || "").trim();
  if (fromBasePath) {
    return fromBasePath;
  }
  return "";
}

function resolvePiPluginInstallDirFromPlugin(plugin?: SystemSculptPlugin): string {
  if (!plugin) {
    return "";
  }

  const manifestDir = String((plugin.manifest as { dir?: unknown })?.dir || "").trim();
  if (manifestDir) {
    if (isAbsolute(manifestDir)) {
      return resolvePath(manifestDir);
    }
    const vaultBasePath = resolveVaultBasePath(plugin);
    if (vaultBasePath) {
      return join(vaultBasePath, manifestDir);
    }
  }

  const vaultBasePath = resolveVaultBasePath(plugin);
  const configDir = String(plugin.app?.vault?.configDir || "").trim();
  const pluginId = String(plugin.manifest.id || "").trim();
  if (vaultBasePath && configDir && pluginId) {
    return join(vaultBasePath, configDir, "plugins", pluginId);
  }

  return "";
}

export function registerPiRuntimeBootstrapContext(options: {
  plugin?: SystemSculptPlugin;
  pluginInstallDir?: string;
  pluginVersion?: string;
  pluginId?: string;
}): string | null {
  const explicitInstallDir = String(options.pluginInstallDir || "").trim();
  const pluginInstallDir = explicitInstallDir
    ? resolvePath(explicitInstallDir)
    : resolvePiPluginInstallDirFromPlugin(options.plugin);
  if (!pluginInstallDir) {
    return null;
  }

  const pluginVersion = String(options.pluginVersion || options.plugin?.manifest.version || "").trim();
  const pluginId = String(options.pluginId || options.plugin?.manifest.id || "").trim();
  registeredPiRuntimeContext = {
    pluginInstallDir,
    pluginVersion: pluginVersion || undefined,
    pluginId: pluginId || undefined,
  };
  return pluginInstallDir;
}

export function clearPiRuntimeBootstrapContext(): void {
  registeredPiRuntimeContext = null;
}

function derivePluginInstallDirFromPiPaths(value: string): string {
  const normalized = resolvePath(String(value || "").trim());
  if (!normalized) {
    return "";
  }
  if (normalized.includes(`${join("node_modules", "@mariozechner", "pi-coding-agent")}${join("dist", "")}`)) {
    return dirname(dirname(dirname(dirname(dirname(normalized)))));
  }
  if (normalized.endsWith(join("node_modules", "@mariozechner", "pi-coding-agent"))) {
    return dirname(dirname(dirname(normalized)));
  }
  return "";
}

function findPluginInstallDirFromRoot(rootDir: string): string {
  let current = resolvePath(rootDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "manifest.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }
  return "";
}

export function resolvePiPluginInstallDir(options?: {
  plugin?: SystemSculptPlugin;
  pluginInstallDir?: string;
}): string {
  const explicitInstallDir = String(options?.pluginInstallDir || "").trim();
  if (explicitInstallDir) {
    return resolvePath(explicitInstallDir);
  }

  const pluginInstallDirFromPlugin = resolvePiPluginInstallDirFromPlugin(options?.plugin);
  if (pluginInstallDirFromPlugin) {
    return pluginInstallDirFromPlugin;
  }

  const registeredInstallDir = String(registeredPiRuntimeContext?.pluginInstallDir || "").trim();
  if (registeredInstallDir) {
    return resolvePath(registeredInstallDir);
  }

  const envInstallDir = String(process.env.SYSTEMSCULPT_PI_PLUGIN_INSTALL_DIR || "").trim();
  if (envInstallDir) {
    return resolvePath(envInstallDir);
  }

  const envDerived = [
    String(process.env.SYSTEMSCULPT_PI_PACKAGE_ROOT || "").trim(),
    String(process.env.SYSTEMSCULPT_PI_PACKAGE_ENTRY || "").trim(),
  ]
    .map((value) => derivePluginInstallDirFromPiPaths(value))
    .find(Boolean);
  if (envDerived) {
    return envDerived;
  }

  const candidateRoots = new Set<string>();
  if (typeof __dirname === "string" && __dirname.trim()) {
    candidateRoots.add(__dirname);
  }
  if (typeof process?.cwd === "function") {
    try {
      const cwd = String(process.cwd() || "").trim();
      if (cwd) {
        candidateRoots.add(cwd);
      }
    } catch {
      // Ignore cwd lookup failures and fall through.
    }
  }

  for (const candidateRoot of candidateRoots) {
    const resolved = findPluginInstallDirFromRoot(candidateRoot);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("Unable to resolve the SystemSculpt plugin installation directory for Pi runtime bootstrap.");
}

function readPluginVersion(pluginInstallDir: string, plugin?: SystemSculptPlugin): string {
  const manifestVersion = String(plugin?.manifest.version || "").trim();
  if (manifestVersion) {
    return manifestVersion;
  }
  const registeredVersion = String(registeredPiRuntimeContext?.pluginVersion || "").trim();
  if (registeredVersion) {
    return registeredVersion;
  }
  const envVersion = String(process.env.SYSTEMSCULPT_PI_PLUGIN_VERSION || "").trim();
  if (envVersion) {
    return envVersion;
  }
  const manifestPath = join(pluginInstallDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = readJsonFile<{ version?: string }>(manifestPath);
    const version = String(manifest.version || "").trim();
    if (version) {
      return version;
    }
  }
  return "latest";
}

function formatUnsupportedTargetMessage(target: string): string {
  if (target.startsWith("linux-")) {
    return "Pi runtime bootstrap does not currently support Linux desktop builds.";
  }
  return `Pi runtime bootstrap does not support target ${target}.`;
}

export class PiRuntimeBootstrap {
  constructor(
    private readonly plugin?: SystemSculptPlugin,
    private readonly options?: PiRuntimeBootstrapOptions
  ) {}

  private resolveTarget(): string {
    const platform = String(this.options?.platform || process.platform || "").trim();
    const arch = String(this.options?.arch || process.arch || "").trim();
    return resolveTarget(platform, arch);
  }

  private resolvePluginInstallDir(): string {
    return resolvePiPluginInstallDir({
      plugin: this.plugin,
      pluginInstallDir: this.options?.pluginInstallDir,
    });
  }

  private resolveReleaseBaseUrl(pluginInstallDir: string): string {
    const envBase = String(process.env.SYSTEMSCULPT_PI_RUNTIME_BASE_URL || "").trim();
    if (envBase) {
      return envBase;
    }
    const optionBase = String(this.options?.releaseBaseUrl || "").trim();
    if (optionBase) {
      return optionBase;
    }
    const version = readPluginVersion(pluginInstallDir, this.plugin);
    if (version === "latest") {
      return `https://github.com/${DEFAULT_RELEASE_REPO}/releases/latest/download`;
    }
    return `https://github.com/${DEFAULT_RELEASE_REPO}/releases/download/${encodeURIComponent(version)}`;
  }

  private resolveManifestUrl(pluginInstallDir: string): string {
    const envManifest = String(process.env.SYSTEMSCULPT_PI_RUNTIME_MANIFEST_URL || "").trim();
    if (envManifest) {
      return envManifest;
    }
    const optionManifest = String(this.options?.manifestUrl || "").trim();
    if (optionManifest) {
      return optionManifest;
    }
    return `${this.resolveReleaseBaseUrl(pluginInstallDir)}/${PI_RUNTIME_MANIFEST_FILE_NAME}`;
  }

  private async fetchBinary(url: string): Promise<Buffer> {
    const fetcher = this.options?.fetchBinary || defaultFetchBinary;
    return await fetcher(url);
  }

  private async loadManifest(pluginInstallDir: string): Promise<{ manifest: RuntimeManifest; manifestUrl: string }> {
    const primaryUrl = this.resolveManifestUrl(pluginInstallDir);
    const fallbacks = [
      primaryUrl,
      `https://github.com/${DEFAULT_RELEASE_REPO}/releases/latest/download/${PI_RUNTIME_MANIFEST_FILE_NAME}`,
    ];

    const errors: string[] = [];
    for (const candidate of fallbacks) {
      try {
        const payload = await this.fetchBinary(candidate);
        const parsed = JSON.parse(payload.toString("utf8")) as RuntimeManifest;
        if (
          !parsed ||
          parsed.schema !== PI_RUNTIME_MANIFEST_SCHEMA ||
          parsed.entryPackageName !== PI_RUNTIME_ENTRY_PACKAGE ||
          !Array.isArray(parsed.packageRoots) ||
          !parsed.assets ||
          typeof parsed.assets !== "object"
        ) {
          throw new Error(`Invalid manifest schema from ${candidate}`);
        }
        return {
          manifest: parsed,
          manifestUrl: candidate,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${candidate}: ${message}`);
      }
    }

    throw new Error(`Pi runtime bootstrap failed to download manifest (${errors.join(" | ")})`);
  }

  private async installFromArchive(options: {
    archiveBytes: Buffer;
    fileName: string;
    pluginInstallDir: string;
    packageRoots: string[];
  }): Promise<void> {
    const destinationParent = options.pluginInstallDir;
    const stageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const stageRoot = join(destinationParent, `.pi-runtime-stage-${stageId}`);
    const archivePath = join(stageRoot, options.fileName || "studio-pi-runtime.tgz");

    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(stageRoot, { recursive: true });
    await writeFile(archivePath, options.archiveBytes);

    try {
      await tar.x({
        file: archivePath,
        cwd: stageRoot,
        strict: true,
      });

      for (const relativePath of options.packageRoots) {
        const segments = toRelativeSegments(relativePath);
        const stagedPackagePath = join(stageRoot, ...segments);
        const destinationPath = join(destinationParent, ...segments);
        ensureExists(stagedPackagePath, `Pi runtime archive did not contain ${relativePath}.`);
        await mkdir(dirname(destinationPath), { recursive: true });
        await rm(destinationPath, { recursive: true, force: true });
        await rename(stagedPackagePath, destinationPath);
      }
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }

  async ensureRuntimeInstalled(pluginInstallDir?: string): Promise<PiRuntimeBootstrapResult> {
    const resolvedPluginInstallDir = resolvePath(String(pluginInstallDir || this.resolvePluginInstallDir()));
    const target = this.resolveTarget();
    const installKey = `${resolvedPluginInstallDir}::${target}`;
    const existingPromise = installPromiseByKey.get(installKey);
    if (existingPromise) {
      return await existingPromise;
    }

    const installPromise = (async (): Promise<PiRuntimeBootstrapResult> => {
      const installedPackages = collectInstalledRuntimePackages(resolvedPluginInstallDir);
      if (installedPackages) {
        return {
          installedRuntime: false,
          packageCount: installedPackages.length,
        };
      }

      if (!BOOTSTRAP_SUPPORTED_TARGETS.has(target)) {
        throw new Error(formatUnsupportedTargetMessage(target));
      }

      const { manifest, manifestUrl } = await this.loadManifest(resolvedPluginInstallDir);
      const asset = manifest.assets[target];
      if (!asset || !asset.fileName || !asset.sha256) {
        throw new Error(`Pi runtime manifest did not include an asset for ${target}.`);
      }

      const assetUrl = asset.url && String(asset.url).trim().length > 0
        ? String(asset.url).trim()
        : new URL(asset.fileName, manifestUrl).toString();
      const archiveBytes = await this.fetchBinary(assetUrl);

      if (Number.isFinite(asset.sizeBytes) && Number(asset.sizeBytes) > 0 && archiveBytes.byteLength !== Number(asset.sizeBytes)) {
        throw new Error(
          `Pi runtime asset size mismatch for ${target}: expected ${asset.sizeBytes}, received ${archiveBytes.byteLength}.`
        );
      }

      const checksum = sha256Hex(archiveBytes);
      if (checksum !== String(asset.sha256).toLowerCase()) {
        throw new Error(
          `Pi runtime checksum mismatch for ${target}: expected ${asset.sha256}, received ${checksum}.`
        );
      }

      await this.installFromArchive({
        archiveBytes,
        fileName: asset.fileName,
        pluginInstallDir: resolvedPluginInstallDir,
        packageRoots: manifest.packageRoots,
      });

      const verifiedPackages = collectInstalledRuntimePackages(resolvedPluginInstallDir);
      if (!verifiedPackages) {
        throw new Error("Pi runtime bootstrap completed, but the bundled runtime could not be verified.");
      }

      return {
        installedRuntime: true,
        packageCount: verifiedPackages.length,
        manifestUrl,
        assetUrl,
      };
    })();

    installPromiseByKey.set(installKey, installPromise);
    try {
      return await installPromise;
    } finally {
      installPromiseByKey.delete(installKey);
    }
  }
}

export async function ensureBundledPiRuntime(options?: {
  plugin?: SystemSculptPlugin;
  pluginInstallDir?: string;
  bootstrap?: PiRuntimeBootstrap;
}): Promise<{ pluginInstallDir: string; result: PiRuntimeBootstrapResult }> {
  const pluginInstallDir = resolvePiPluginInstallDir({
    plugin: options?.plugin,
    pluginInstallDir: options?.pluginInstallDir,
  });
  const bootstrap = options?.bootstrap || new PiRuntimeBootstrap(options?.plugin, {
    pluginInstallDir,
  });
  const result = await bootstrap.ensureRuntimeInstalled(pluginInstallDir);
  return {
    pluginInstallDir,
    result,
  };
}

export const piRuntimeBootstrapInternals = {
  clearPiRuntimeBootstrapContext,
  collectInstalledRuntimePackages,
  runtimeLooksInstalled,
  registerPiRuntimeBootstrapContext,
  resolveTarget,
  resolvePiPluginInstallDir,
  resolvePiPackageRoot,
  resolvePiEntryPath,
  resolvePiCliPath,
  sha256Hex,
  formatUnsupportedTargetMessage,
};
