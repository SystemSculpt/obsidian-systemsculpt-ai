import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { StudioPermissionManager } from "../StudioPermissionManager";
import { StudioSandboxRunner } from "../StudioSandboxRunner";
import {
  generateImageWithLocalMacProvider,
  STUDIO_LOCAL_MAC_IMAGE_COMMAND,
} from "../nodes/localMacImageGeneration";
import type {
  StudioAssetRef,
  StudioNodeExecutionContext,
  StudioPermissionPolicyV1,
} from "../types";
import { STUDIO_POLICY_SCHEMA_V1 } from "../types";

function toArrayBuffer(value: Buffer | Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

describe("local macOS image generation e2e", () => {
  let tempRoot = "";
  let originalPath = "";
  let originalBackendMode = "";
  let tempCounter = 0;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "studio-local-image-e2e-"));
    originalPath = String(process.env.PATH || "");
    originalBackendMode = String(process.env.SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND || "");
    process.env.SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND = "mock";

    const commandShimPath = join(tempRoot, STUDIO_LOCAL_MAC_IMAGE_COMMAND);
    const repoCommandPath = resolve(process.cwd(), "scripts/systemsculpt-local-imagegen");
    await symlink(repoCommandPath, commandShimPath);
    await chmod(commandShimPath, 0o755);

    process.env.PATH = `${tempRoot}:${originalPath}`;
    tempCounter = 0;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalBackendMode) {
      process.env.SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND = originalBackendMode;
    } else {
      delete process.env.SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND;
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("executes local provider command through Studio sandbox and stores PNG assets", async () => {
    const policy: StudioPermissionPolicyV1 = {
      schema: STUDIO_POLICY_SCHEMA_V1,
      version: 1,
      updatedAt: new Date().toISOString(),
      grants: [
        {
          id: "grant_fs",
          capability: "filesystem",
          scope: { allowedPaths: ["/"] },
          grantedAt: new Date().toISOString(),
          grantedByUser: true,
        },
        {
          id: "grant_cli",
          capability: "cli",
          scope: { allowedCommandPatterns: [STUDIO_LOCAL_MAC_IMAGE_COMMAND] },
          grantedAt: new Date().toISOString(),
          grantedByUser: true,
        },
      ],
    };
    const permissions = new StudioPermissionManager(policy);
    const sandbox = new StudioSandboxRunner(permissions);

    const storedAssets: StudioAssetRef[] = [];
    const context = {
      runId: "run_local_e2e",
      projectPath: "Studio/Local.e2e.systemsculpt",
      node: {
        id: "image-node",
        kind: "studio.image_generation",
        version: "1.0.0",
        title: "Image Generation",
        position: { x: 0, y: 0 },
        config: {},
      },
      inputs: {},
      signal: new AbortController().signal,
      services: {
        api: {
          estimateRunCredits: async () => ({ ok: true }),
          generateText: async () => ({ text: "", modelId: "unused" }),
          generateImage: async () => ({ images: [], modelId: "unused" }),
          transcribeAudio: async () => ({ text: "" }),
        },
        secretStore: {
          isAvailable: () => false,
          getSecret: async () => "",
        },
        storeAsset: async (bytes, mimeType) => {
          const buffer = Buffer.from(bytes);
          const hash = createHash("sha256").update(buffer).digest("hex");
          const path = join(tempRoot, `${hash}.png`);
          await writeFile(path, buffer);
          const asset: StudioAssetRef = {
            hash,
            mimeType,
            sizeBytes: buffer.byteLength,
            path,
          };
          storedAssets.push(asset);
          return asset;
        },
        readAsset: async (asset) => {
          const bytes = await readFile(asset.path);
          return toArrayBuffer(bytes);
        },
        resolveAbsolutePath: (path) => path,
        readVaultBinary: async () => new ArrayBuffer(0),
        readLocalFileBinary: async (absolutePath) => {
          const bytes = await readFile(absolutePath);
          return toArrayBuffer(bytes);
        },
        writeTempFile: async (bytes, options) => {
          tempCounter += 1;
          const prefix = String(options?.prefix || "tmp");
          const ext = String(options?.extension || "").trim();
          const suffix = ext ? `.${ext.replace(/^[.]+/, "")}` : "";
          const path = join(tempRoot, `${prefix}-${tempCounter}${suffix}`);
          await writeFile(path, Buffer.from(bytes));
          return path;
        },
        deleteLocalFile: async (absolutePath) => {
          await rm(absolutePath, { force: true });
        },
        runCli: async (request) => sandbox.runCli(request),
        assertFilesystemPath: (path) => permissions.assertFilesystemPath(path),
        assertNetworkUrl: () => {},
      },
      log: () => {},
    } as StudioNodeExecutionContext;

    const result = await generateImageWithLocalMacProvider(context, {
      prompt: "High-contrast futuristic skyline",
      count: 2,
      aspectRatio: "1:1",
      inputImages: [],
      runId: "run_local_e2e",
    });

    expect(result.modelId).toBe("local/macos-procedural-v1");
    expect(result.images).toHaveLength(2);
    expect(storedAssets).toHaveLength(2);
    for (const asset of result.images) {
      expect(asset.mimeType).toBe("image/png");
      expect(asset.sizeBytes).toBeGreaterThan(1000);
      const bytes = await readFile(asset.path);
      expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  it("supports local reference-image input and non-square ratios through the command path", async () => {
    const policy: StudioPermissionPolicyV1 = {
      schema: STUDIO_POLICY_SCHEMA_V1,
      version: 1,
      updatedAt: new Date().toISOString(),
      grants: [
        {
          id: "grant_fs",
          capability: "filesystem",
          scope: { allowedPaths: ["/"] },
          grantedAt: new Date().toISOString(),
          grantedByUser: true,
        },
        {
          id: "grant_cli",
          capability: "cli",
          scope: { allowedCommandPatterns: [STUDIO_LOCAL_MAC_IMAGE_COMMAND] },
          grantedAt: new Date().toISOString(),
          grantedByUser: true,
        },
      ],
    };
    const permissions = new StudioPermissionManager(policy);
    const sandbox = new StudioSandboxRunner(permissions);

    const context = {
      runId: "run_local_e2e_reference",
      projectPath: "Studio/Local.e2e.systemsculpt",
      node: {
        id: "image-node",
        kind: "studio.image_generation",
        version: "1.0.0",
        title: "Image Generation",
        position: { x: 0, y: 0 },
        config: {},
      },
      inputs: {},
      signal: new AbortController().signal,
      services: {
        api: {
          estimateRunCredits: async () => ({ ok: true }),
          generateText: async () => ({ text: "", modelId: "unused" }),
          generateImage: async () => ({ images: [], modelId: "unused" }),
          transcribeAudio: async () => ({ text: "" }),
        },
        secretStore: {
          isAvailable: () => false,
          getSecret: async () => "",
        },
        storeAsset: async (bytes, mimeType) => {
          const buffer = Buffer.from(bytes);
          const hash = createHash("sha256").update(buffer).digest("hex");
          const path = join(tempRoot, `${hash}.png`);
          await writeFile(path, buffer);
          const asset: StudioAssetRef = {
            hash,
            mimeType,
            sizeBytes: buffer.byteLength,
            path,
          };
          return asset;
        },
        readAsset: async (asset) => {
          const bytes = await readFile(asset.path);
          return toArrayBuffer(bytes);
        },
        resolveAbsolutePath: (path) => path,
        readVaultBinary: async () => new ArrayBuffer(0),
        readLocalFileBinary: async (absolutePath) => {
          const bytes = await readFile(absolutePath);
          return toArrayBuffer(bytes);
        },
        writeTempFile: async (bytes, options) => {
          tempCounter += 1;
          const prefix = String(options?.prefix || "tmp");
          const ext = String(options?.extension || "").trim();
          const suffix = ext ? `.${ext.replace(/^[.]+/, "")}` : "";
          const path = join(tempRoot, `${prefix}-${tempCounter}${suffix}`);
          await writeFile(path, Buffer.from(bytes));
          return path;
        },
        deleteLocalFile: async (absolutePath) => {
          await rm(absolutePath, { force: true });
        },
        runCli: async (request) => sandbox.runCli(request),
        assertFilesystemPath: (path) => permissions.assertFilesystemPath(path),
        assertNetworkUrl: () => {},
      },
      log: () => {},
    } as StudioNodeExecutionContext;

    const referencePathA = join(tempRoot, "reference-a.png");
    const referencePathB = join(tempRoot, "reference-b.png");
    await writeFile(
      referencePathA,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    );
    await writeFile(
      referencePathB,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 1, 1, 1])
    );

    const result = await generateImageWithLocalMacProvider(context, {
      prompt: "Wide cinematic scene with practical lighting",
      count: 1,
      aspectRatio: "16:9",
      inputImages: [
        {
          hash: "hash-reference-a",
          mimeType: "image/png",
          sizeBytes: 12,
          path: referencePathA,
        },
        {
          hash: "hash-reference-b",
          mimeType: "image/png",
          sizeBytes: 12,
          path: referencePathB,
        },
      ],
      qualityPreset: "balanced",
      referenceInfluence: "strong",
      runId: "run_local_e2e_reference",
    });

    expect(result.modelId).toBe("local/macos-procedural-v1");
    expect(result.images).toHaveLength(1);
    const bytes = await readFile(result.images[0].path);
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
