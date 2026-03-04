import { createHash } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import * as tar from "tar";
import type SystemSculptPlugin from "../main";

const MANIFEST_FILE_NAME = "studio-terminal-runtime-manifest.json";
const NODE_PTY_MODULE_NAME = "node-pty";
const MANIFEST_SCHEMA = "studio.terminal-runtime-manifest.v1";
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
  nodePtyVersion: string;
  generatedAt?: string;
  assets: Record<string, RuntimeAssetRecord>;
};

export type StudioTerminalRuntimeBootstrapResult = {
  installedRuntime: boolean;
  repairedPermissions: boolean;
  manifestUrl?: string;
  assetUrl?: string;
};

export type StudioTerminalRuntimeBootstrapOptions = {
  platform?: string;
  arch?: string;
  releaseBaseUrl?: string;
  manifestUrl?: string;
  fetchBinary?: (url: string) => Promise<Buffer>;
};

function resolveTarget(platform: string, arch: string): string {
  return `${String(platform || "").trim()}-${String(arch || "").trim()}`;
}

function resolveNativeDir(moduleRoot: string, target: string): string {
  const buildRelease = join(moduleRoot, "build", "Release", "pty.node");
  if (existsSync(buildRelease)) {
    return join(moduleRoot, "build", "Release");
  }
  const buildDebug = join(moduleRoot, "build", "Debug", "pty.node");
  if (existsSync(buildDebug)) {
    return join(moduleRoot, "build", "Debug");
  }
  return join(moduleRoot, "prebuilds", target);
}

function runtimeLooksInstalled(moduleRoot: string, target: string): boolean {
  if (!existsSync(moduleRoot)) {
    return false;
  }
  const packagePath = join(moduleRoot, "package.json");
  const indexPath = join(moduleRoot, "lib", "index.js");
  if (!existsSync(packagePath) || !existsSync(indexPath)) {
    return false;
  }

  const nativeDir = resolveNativeDir(moduleRoot, target);
  const nativeModule = join(nativeDir, "pty.node");
  return existsSync(nativeModule);
}

function ensurePosixSpawnHelperExecutable(moduleRoot: string, target: string): boolean {
  if (!(target.startsWith("darwin-") || target.startsWith("linux-"))) {
    return false;
  }

  const helperPath = join(resolveNativeDir(moduleRoot, target), "spawn-helper");
  if (!existsSync(helperPath)) {
    return false;
  }

  const mode = statSync(helperPath).mode & 0o777;
  if ((mode & 0o111) !== 0) {
    return false;
  }

  chmodSync(helperPath, mode | 0o111);
  return true;
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

function formatLinuxUnsupportedMessage(moduleRoot: string): string {
  return [
    "node-pty runtime bootstrap does not currently support Linux desktop builds.",
    `Install node-pty manually at ${moduleRoot} and restart Obsidian.`,
  ].join(" ");
}

function formatUnsupportedTargetMessage(target: string, moduleRoot: string): string {
  return [
    `node-pty runtime bootstrap does not support target ${target}.`,
    `Install node-pty manually at ${moduleRoot} and restart Obsidian.`,
  ].join(" ");
}

export class StudioTerminalRuntimeBootstrap {
  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly options?: StudioTerminalRuntimeBootstrapOptions
  ) {}

  private resolvePluginVersion(): string {
    return String(this.plugin.manifest.version || "").trim() || "latest";
  }

  private resolveTarget(): string {
    const platform = String(this.options?.platform || process.platform || "").trim();
    const arch = String(this.options?.arch || process.arch || "").trim();
    return resolveTarget(platform, arch);
  }

  private resolveReleaseBaseUrl(): string {
    const envBase = String(process.env.SYSTEMSCULPT_STUDIO_TERMINAL_RUNTIME_BASE_URL || "").trim();
    if (envBase) {
      return envBase;
    }
    const optionBase = String(this.options?.releaseBaseUrl || "").trim();
    if (optionBase) {
      return optionBase;
    }
    const version = encodeURIComponent(this.resolvePluginVersion());
    return `https://github.com/${DEFAULT_RELEASE_REPO}/releases/download/${version}`;
  }

  private resolveManifestUrl(): string {
    const envManifest = String(process.env.SYSTEMSCULPT_STUDIO_TERMINAL_RUNTIME_MANIFEST_URL || "").trim();
    if (envManifest) {
      return envManifest;
    }
    const optionManifest = String(this.options?.manifestUrl || "").trim();
    if (optionManifest) {
      return optionManifest;
    }
    return `${this.resolveReleaseBaseUrl()}/${MANIFEST_FILE_NAME}`;
  }

  private async fetchBinary(url: string): Promise<Buffer> {
    const fetcher = this.options?.fetchBinary || defaultFetchBinary;
    return await fetcher(url);
  }

  private async loadManifest(): Promise<{ manifest: RuntimeManifest; manifestUrl: string }> {
    const primaryUrl = this.resolveManifestUrl();
    const fallbacks = [
      primaryUrl,
      `https://github.com/${DEFAULT_RELEASE_REPO}/releases/latest/download/${MANIFEST_FILE_NAME}`,
    ];

    const errors: string[] = [];
    for (const candidate of fallbacks) {
      try {
        const payload = await this.fetchBinary(candidate);
        const parsed = JSON.parse(payload.toString("utf8")) as RuntimeManifest;
        if (!parsed || parsed.schema !== MANIFEST_SCHEMA || !parsed.assets || typeof parsed.assets !== "object") {
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

    throw new Error(`node-pty runtime bootstrap failed to download manifest (${errors.join(" | ")})`);
  }

  private async installFromArchive(options: {
    archiveBytes: Buffer;
    fileName: string;
    moduleRoot: string;
    target: string;
  }): Promise<void> {
    const destinationParent = dirname(options.moduleRoot);
    await mkdir(destinationParent, { recursive: true });

    const stageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const stageRoot = join(destinationParent, `.node-pty-stage-${stageId}`);
    const backupRoot = join(destinationParent, `.node-pty-backup-${stageId}`);
    const archivePath = join(stageRoot, options.fileName || "node-pty-runtime.tgz");

    await rm(stageRoot, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
    await mkdir(stageRoot, { recursive: true });
    await writeFile(archivePath, options.archiveBytes);

    await tar.x({
      file: archivePath,
      cwd: stageRoot,
      strict: true,
    });

    const stagedModuleRoot = join(stageRoot, NODE_PTY_MODULE_NAME);
    if (!runtimeLooksInstalled(stagedModuleRoot, options.target)) {
      throw new Error(`node-pty runtime archive did not contain a valid ${options.target} runtime.`);
    }

    ensurePosixSpawnHelperExecutable(stagedModuleRoot, options.target);

    try {
      if (existsSync(options.moduleRoot)) {
        await rename(options.moduleRoot, backupRoot);
      }
      await rename(stagedModuleRoot, options.moduleRoot);
      await rm(backupRoot, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backupRoot) && !existsSync(options.moduleRoot)) {
        try {
          await rename(backupRoot, options.moduleRoot);
        } catch {}
      }
      throw error;
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }

  async ensureNodePtyRuntime(pluginInstallDir: string): Promise<StudioTerminalRuntimeBootstrapResult> {
    const target = this.resolveTarget();
    const moduleRoot = join(pluginInstallDir, "node_modules", NODE_PTY_MODULE_NAME);

    if (runtimeLooksInstalled(moduleRoot, target)) {
      let repairedPermissions = false;
      try {
        repairedPermissions = ensurePosixSpawnHelperExecutable(moduleRoot, target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`node-pty runtime exists but spawn-helper permissions could not be repaired: ${message}`);
      }
      return {
        installedRuntime: false,
        repairedPermissions,
      };
    }

    if (!BOOTSTRAP_SUPPORTED_TARGETS.has(target)) {
      if (target.startsWith("linux-")) {
        throw new Error(formatLinuxUnsupportedMessage(moduleRoot));
      }
      throw new Error(formatUnsupportedTargetMessage(target, moduleRoot));
    }

    const { manifest, manifestUrl } = await this.loadManifest();
    const asset = manifest.assets[target];
    if (!asset || !asset.fileName || !asset.sha256) {
      throw new Error(`node-pty runtime manifest did not include an asset for ${target}.`);
    }

    const assetUrl = asset.url && String(asset.url).trim().length > 0
      ? String(asset.url).trim()
      : `${this.resolveReleaseBaseUrl()}/${asset.fileName}`;
    const archiveBytes = await this.fetchBinary(assetUrl);

    if (Number.isFinite(asset.sizeBytes) && Number(asset.sizeBytes) > 0 && archiveBytes.byteLength !== Number(asset.sizeBytes)) {
      throw new Error(
        `node-pty runtime asset size mismatch for ${target}: expected ${asset.sizeBytes}, received ${archiveBytes.byteLength}.`
      );
    }

    const checksum = sha256Hex(archiveBytes);
    if (checksum !== String(asset.sha256).toLowerCase()) {
      throw new Error(
        `node-pty runtime checksum mismatch for ${target}: expected ${asset.sha256}, received ${checksum}.`
      );
    }

    await this.installFromArchive({
      archiveBytes,
      fileName: asset.fileName,
      moduleRoot,
      target,
    });

    const repairedPermissions = ensurePosixSpawnHelperExecutable(moduleRoot, target);

    return {
      installedRuntime: true,
      repairedPermissions,
      manifestUrl,
      assetUrl,
    };
  }
}

export const studioTerminalRuntimeBootstrapInternals = {
  runtimeLooksInstalled,
  ensurePosixSpawnHelperExecutable,
  resolveNativeDir,
  resolveTarget,
  sha256Hex,
  formatLinuxUnsupportedMessage,
  formatUnsupportedTargetMessage,
};
