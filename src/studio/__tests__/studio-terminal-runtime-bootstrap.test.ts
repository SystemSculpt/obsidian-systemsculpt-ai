import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import {
  StudioTerminalRuntimeBootstrap,
  studioTerminalRuntimeBootstrapInternals,
} from "../StudioTerminalRuntimeBootstrap";

function createPluginStub(version = "9.9.9"): any {
  return {
    manifest: {
      version,
    },
  };
}

function createNodePtySkeleton(options: {
  rootDir: string;
  target: string;
  spawnHelperMode?: number;
}): string {
  const moduleRoot = join(options.rootDir, "node_modules", "node-pty");
  const nativeDir = join(moduleRoot, "prebuilds", options.target);
  mkdirSync(join(moduleRoot, "lib"), { recursive: true });
  mkdirSync(nativeDir, { recursive: true });

  writeFileSync(
    join(moduleRoot, "package.json"),
    JSON.stringify({ name: "node-pty", version: "1.1.0" }, null, 2),
    "utf8"
  );
  writeFileSync(join(moduleRoot, "lib", "index.js"), "module.exports = {};\n", "utf8");
  writeFileSync(join(nativeDir, "pty.node"), "native-binary", "utf8");

  const helperPath = join(nativeDir, "spawn-helper");
  writeFileSync(helperPath, "#!/bin/sh\necho helper\n", "utf8");
  chmodSync(helperPath, options.spawnHelperMode ?? 0o755);

  return moduleRoot;
}

async function createRuntimeArchive(options: {
  outputPath: string;
  target: string;
  spawnHelperMode?: number;
}): Promise<Buffer> {
  const archiveRoot = join(tmpdir(), `studio-terminal-runtime-archive-${Date.now()}-${Math.random()}`);
  rmSync(archiveRoot, { recursive: true, force: true });
  mkdirSync(archiveRoot, { recursive: true });
  try {
    const moduleRoot = join(archiveRoot, "node-pty");
    const nativeDir = join(moduleRoot, "prebuilds", options.target);
    mkdirSync(join(moduleRoot, "lib"), { recursive: true });
    mkdirSync(nativeDir, { recursive: true });

    writeFileSync(
      join(moduleRoot, "package.json"),
      JSON.stringify({ name: "node-pty", version: "1.1.0" }, null, 2),
      "utf8"
    );
    writeFileSync(join(moduleRoot, "lib", "index.js"), "module.exports = {};\n", "utf8");
    writeFileSync(join(nativeDir, "pty.node"), "native-binary", "utf8");
    writeFileSync(join(nativeDir, "spawn-helper"), "#!/bin/sh\necho helper\n", "utf8");
    chmodSync(join(nativeDir, "spawn-helper"), options.spawnHelperMode ?? 0o644);

    await tar.c(
      {
        gzip: true,
        cwd: archiveRoot,
        file: options.outputPath,
      },
      ["node-pty"]
    );

    return readFileSync(options.outputPath);
  } finally {
    rmSync(archiveRoot, { recursive: true, force: true });
  }
}

describe("StudioTerminalRuntimeBootstrap", () => {
  it("repairs non-executable spawn-helper when runtime already exists", async () => {
    const pluginRoot = join(tmpdir(), `studio-terminal-runtime-existing-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });

    try {
      const target = "darwin-arm64";
      const moduleRoot = createNodePtySkeleton({
        rootDir: pluginRoot,
        target,
        spawnHelperMode: 0o644,
      });

      const fetchBinary = jest.fn(async () => {
        throw new Error("fetch should not run when runtime already exists");
      });

      const bootstrap = new StudioTerminalRuntimeBootstrap(createPluginStub(), {
        platform: "darwin",
        arch: "arm64",
        fetchBinary,
      });

      const result = await bootstrap.ensureNodePtyRuntime(pluginRoot);
      expect(result.installedRuntime).toBe(false);
      expect(result.repairedPermissions).toBe(true);
      expect(fetchBinary).not.toHaveBeenCalled();

      const helperPath = join(moduleRoot, "prebuilds", target, "spawn-helper");
      const mode = statSync(helperPath).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("downloads and installs runtime from manifest asset when missing", async () => {
    const pluginRoot = join(tmpdir(), `studio-terminal-runtime-missing-${Date.now()}`);
    const assetsRoot = join(tmpdir(), `studio-terminal-runtime-assets-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(assetsRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(assetsRoot, { recursive: true });

    try {
      const target = "darwin-arm64";
      const archiveName = "studio-terminal-runtime-node-pty-1.1.0-darwin-arm64.tgz";
      const archivePath = join(assetsRoot, archiveName);
      const archiveBytes = await createRuntimeArchive({
        outputPath: archivePath,
        target,
        spawnHelperMode: 0o644,
      });

      const manifestUrl = "https://example.com/runtime/manifest.json";
      const assetUrl = `https://example.com/runtime/${archiveName}`;
      const manifest = {
        schema: "studio.terminal-runtime-manifest.v1",
        nodePtyVersion: "1.1.0",
        assets: {
          [target]: {
            fileName: archiveName,
            sha256: studioTerminalRuntimeBootstrapInternals.sha256Hex(archiveBytes),
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

      const bootstrap = new StudioTerminalRuntimeBootstrap(createPluginStub(), {
        platform: "darwin",
        arch: "arm64",
        manifestUrl,
        fetchBinary,
      });

      const result = await bootstrap.ensureNodePtyRuntime(pluginRoot);
      expect(result.installedRuntime).toBe(true);
      expect(result.repairedPermissions).toBe(false);
      expect(result.manifestUrl).toBe(manifestUrl);
      expect(result.assetUrl).toBe(assetUrl);

      const moduleRoot = join(pluginRoot, "node_modules", "node-pty");
      expect(studioTerminalRuntimeBootstrapInternals.runtimeLooksInstalled(moduleRoot, target)).toBe(true);

      const helperPath = join(moduleRoot, "prebuilds", target, "spawn-helper");
      const mode = statSync(helperPath).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });

  it("fails fast on runtime checksum mismatch", async () => {
    const pluginRoot = join(tmpdir(), `studio-terminal-runtime-checksum-${Date.now()}`);
    const assetsRoot = join(tmpdir(), `studio-terminal-runtime-assets-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(assetsRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(assetsRoot, { recursive: true });

    try {
      const target = "darwin-arm64";
      const archiveName = "studio-terminal-runtime-node-pty-1.1.0-darwin-arm64.tgz";
      const archivePath = join(assetsRoot, archiveName);
      const archiveBytes = await createRuntimeArchive({
        outputPath: archivePath,
        target,
      });

      const manifestUrl = "https://example.com/runtime/manifest.json";
      const assetUrl = `https://example.com/runtime/${archiveName}`;
      const manifest = {
        schema: "studio.terminal-runtime-manifest.v1",
        nodePtyVersion: "1.1.0",
        assets: {
          [target]: {
            fileName: archiveName,
            sha256: "deadbeef",
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

      const bootstrap = new StudioTerminalRuntimeBootstrap(createPluginStub(), {
        platform: "darwin",
        arch: "arm64",
        manifestUrl,
        fetchBinary,
      });

      await expect(bootstrap.ensureNodePtyRuntime(pluginRoot)).rejects.toThrow("checksum mismatch");
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });

  it("returns a clear Linux unsupported message when runtime is missing", async () => {
    const pluginRoot = join(tmpdir(), `studio-terminal-runtime-linux-${Date.now()}`);
    rmSync(pluginRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });

    try {
      const fetchBinary = jest.fn(async () => {
        throw new Error("should not fetch for unsupported target");
      });
      const bootstrap = new StudioTerminalRuntimeBootstrap(createPluginStub(), {
        platform: "linux",
        arch: "x64",
        fetchBinary,
      });

      await expect(bootstrap.ensureNodePtyRuntime(pluginRoot)).rejects.toThrow(
        "does not currently support Linux desktop builds"
      );
      expect(fetchBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});
