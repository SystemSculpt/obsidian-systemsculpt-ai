import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import {
  clearPiRuntimeBootstrapContext,
  ensureBundledPiRuntime,
  PiRuntimeBootstrap,
  piRuntimeBootstrapInternals,
  registerPiRuntimeBootstrapContext,
} from "../PiRuntimeBootstrap";

function readInstalledPiRuntimeVersion(): string {
  const packageJsonPath = join(process.cwd(), "node_modules", "@mariozechner", "pi-coding-agent", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  const version = String(packageJson.version || "").trim();
  if (!version) {
    throw new Error(`Missing Pi runtime version in ${packageJsonPath}`);
  }
  return version;
}

const PI_RUNTIME_VERSION = readInstalledPiRuntimeVersion();

function createRuntimeArchiveName(target: string): string {
  return `studio-pi-runtime-${PI_RUNTIME_VERSION}-${target}.tgz`;
}

function createPluginStub(version = "9.9.9", pluginDir?: string): any {
  return {
    manifest: {
      version,
      id: "systemsculpt-ai",
      dir: pluginDir,
    },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          getBasePath: () => "/tmp/test-vault",
        },
      },
    },
  };
}

function createPiRuntimeSkeleton(rootDir: string): void {
  const entryRoot = join(rootDir, "node_modules", "@mariozechner", "pi-coding-agent");
  const helperRoot = join(rootDir, "node_modules", "pi-helper");

  mkdirSync(join(entryRoot, "dist"), { recursive: true });
  mkdirSync(helperRoot, { recursive: true });

  writeFileSync(
    join(entryRoot, "package.json"),
    JSON.stringify({
      name: "@mariozechner/pi-coding-agent",
      version: PI_RUNTIME_VERSION,
      dependencies: {
        "pi-helper": "^1.0.0",
      },
    }, null, 2),
    "utf8"
  );
  writeFileSync(join(entryRoot, "dist", "index.js"), "export const ok = true;\n", "utf8");
  writeFileSync(join(entryRoot, "dist", "cli.js"), "console.log('pi');\n", "utf8");

  writeFileSync(
    join(helperRoot, "package.json"),
    JSON.stringify({
      name: "pi-helper",
      version: "1.0.0",
    }, null, 2),
    "utf8"
  );
  writeFileSync(join(helperRoot, "index.js"), "module.exports = {};\n", "utf8");
}

async function createRuntimeArchive(outputPath: string): Promise<Buffer> {
  const archiveRoot = join(tmpdir(), `studio-pi-runtime-archive-${Date.now()}-${Math.random()}`);
  rmSync(archiveRoot, { recursive: true, force: true });
  mkdirSync(archiveRoot, { recursive: true });

  try {
    createPiRuntimeSkeleton(archiveRoot);
    await tar.c(
      {
        gzip: true,
        cwd: archiveRoot,
        file: outputPath,
      },
      ["node_modules"]
    );

    return readFileSync(outputPath);
  } finally {
    rmSync(archiveRoot, { recursive: true, force: true });
  }
}

describe("PiRuntimeBootstrap", () => {
  beforeEach(() => {
    clearPiRuntimeBootstrapContext();
  });

  afterEach(() => {
    clearPiRuntimeBootstrapContext();
  });

  it("reuses an already installed bundled runtime without downloading", async () => {
    const pluginRoot = join(tmpdir(), `studio-pi-runtime-existing-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });

    try {
      createPiRuntimeSkeleton(pluginRoot);

      const fetchBinary = jest.fn(async () => {
        throw new Error("fetch should not run when runtime already exists");
      });
      const bootstrap = new PiRuntimeBootstrap(createPluginStub(), {
        platform: "darwin",
        arch: "arm64",
        pluginInstallDir: pluginRoot,
        fetchBinary,
      });

      const result = await bootstrap.ensureRuntimeInstalled(pluginRoot);
      expect(result.installedRuntime).toBe(false);
      expect(result.packageCount).toBe(2);
      expect(fetchBinary).not.toHaveBeenCalled();
      expect(piRuntimeBootstrapInternals.runtimeLooksInstalled(pluginRoot)).toBe(true);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("downloads and installs the bundled runtime from the manifest asset", async () => {
    const pluginRoot = join(tmpdir(), `studio-pi-runtime-missing-${Date.now()}`);
    const assetsRoot = join(tmpdir(), `studio-pi-runtime-assets-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(assetsRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(assetsRoot, { recursive: true });

    try {
      const target = "darwin-arm64";
      const archiveName = "studio-pi-runtime-0.56.2-darwin-arm64.tgz";
      const archivePath = join(assetsRoot, archiveName);
      const archiveBytes = await createRuntimeArchive(archivePath);

      const manifestUrl = "https://example.com/runtime/studio-pi-runtime-manifest.json";
      const assetUrl = `https://example.com/runtime/${archiveName}`;
      const manifest = {
        schema: "studio.pi-runtime-manifest.v1",
        entryPackageName: "@mariozechner/pi-coding-agent",
        entryPackageVersion: "0.56.2",
        packageRoots: [
          "node_modules/@mariozechner/pi-coding-agent",
          "node_modules/pi-helper",
        ],
        assets: {
          [target]: {
            fileName: archiveName,
            sha256: piRuntimeBootstrapInternals.sha256Hex(archiveBytes),
            sizeBytes: archiveBytes.byteLength,
            url: assetUrl,
          },
        },
      };

      const fetchBinary = jest.fn(async (url: string) => {
        if (url === manifestUrl) {
          return Buffer.from(JSON.stringify(manifest), "utf8");
        }
        if (url === assetUrl) {
          return archiveBytes;
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const bootstrap = new PiRuntimeBootstrap(createPluginStub(), {
        platform: "darwin",
        arch: "arm64",
        pluginInstallDir: pluginRoot,
        manifestUrl,
        fetchBinary,
      });

      const result = await bootstrap.ensureRuntimeInstalled(pluginRoot);
      expect(result.installedRuntime).toBe(true);
      expect(result.packageCount).toBe(2);
      expect(result.manifestUrl).toBe(manifestUrl);
      expect(result.assetUrl).toBe(assetUrl);
      expect(piRuntimeBootstrapInternals.runtimeLooksInstalled(pluginRoot)).toBe(true);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when the runtime asset checksum does not match", async () => {
    const pluginRoot = join(tmpdir(), `studio-pi-runtime-checksum-${Date.now()}`);
    const assetsRoot = join(tmpdir(), `studio-pi-runtime-assets-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(assetsRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(assetsRoot, { recursive: true });

    try {
      const target = "darwin-arm64";
      const archiveName = "studio-pi-runtime-0.56.2-darwin-arm64.tgz";
      const archivePath = join(assetsRoot, archiveName);
      const archiveBytes = await createRuntimeArchive(archivePath);
      const manifestUrl = "https://example.com/runtime/studio-pi-runtime-manifest.json";
      const assetUrl = `https://example.com/runtime/${archiveName}`;

      const fetchBinary = jest.fn(async (url: string) => {
        if (url === manifestUrl) {
          return Buffer.from(JSON.stringify({
            schema: "studio.pi-runtime-manifest.v1",
            entryPackageName: "@mariozechner/pi-coding-agent",
            entryPackageVersion: "0.56.2",
            packageRoots: [
              "node_modules/@mariozechner/pi-coding-agent",
              "node_modules/pi-helper",
            ],
            assets: {
              [target]: {
                fileName: archiveName,
                sha256: "deadbeef",
                sizeBytes: archiveBytes.byteLength,
                url: assetUrl,
              },
            },
          }), "utf8");
        }
        if (url === assetUrl) {
          return archiveBytes;
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const bootstrap = new PiRuntimeBootstrap(createPluginStub(), {
        platform: "darwin",
        arch: "arm64",
        pluginInstallDir: pluginRoot,
        manifestUrl,
        fetchBinary,
      });

      await expect(bootstrap.ensureRuntimeInstalled(pluginRoot)).rejects.toThrow("checksum mismatch");
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });

  it("returns a clear unsupported-target error for Linux", async () => {
    const pluginRoot = join(tmpdir(), `studio-pi-runtime-linux-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });

    try {
      const fetchBinary = jest.fn(async () => {
        throw new Error("should not fetch for unsupported target");
      });

      const bootstrap = new PiRuntimeBootstrap(createPluginStub(), {
        platform: "linux",
        arch: "x64",
        pluginInstallDir: pluginRoot,
        fetchBinary,
      });

      await expect(bootstrap.ensureRuntimeInstalled(pluginRoot)).rejects.toThrow(
        "does not currently support Linux desktop builds"
      );
      expect(fetchBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("reuses the registered plugin runtime context when bootstrap runs without a plugin instance", async () => {
    const pluginRoot = join(tmpdir(), `studio-pi-runtime-context-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });

    try {
      createPiRuntimeSkeleton(pluginRoot);
      const registered = registerPiRuntimeBootstrapContext({
        plugin: createPluginStub("9.9.9", pluginRoot),
      });

      expect(registered).toBe(pluginRoot);
      expect(piRuntimeBootstrapInternals.resolvePiPluginInstallDir()).toBe(pluginRoot);

      const result = await ensureBundledPiRuntime();
      expect(result.pluginInstallDir).toBe(pluginRoot);
      expect(result.result.installedRuntime).toBe(false);
      expect(result.result.packageCount).toBe(2);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});
