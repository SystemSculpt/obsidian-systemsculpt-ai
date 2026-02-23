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

const describeLive = process.env.SYSTEMSCULPT_LOCAL_IMAGEGEN_LIVE === "1" ? describe : describe.skip;

function toArrayBuffer(value: Buffer | Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

describeLive("local macOS image generation live e2e", () => {
  let tempRoot = "";
  let originalPath = "";
  let tempCounter = 0;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "studio-local-image-live-e2e-"));
    originalPath = String(process.env.PATH || "");

    const commandShimPath = join(tempRoot, STUDIO_LOCAL_MAC_IMAGE_COMMAND);
    const repoCommandPath = resolve(process.cwd(), "scripts/systemsculpt-local-imagegen");
    await symlink(repoCommandPath, commandShimPath);
    await chmod(commandShimPath, 0o755);

    process.env.PATH = `${tempRoot}:${originalPath}`;
    tempCounter = 0;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs real Core ML diffusion command and stores PNG output", async () => {
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
      runId: "run_local_live_e2e",
      projectPath: "Studio/Local.live.e2e.systemsculpt",
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
      prompt: "A cinematic black-and-white portrait with dramatic side lighting",
      count: 1,
      aspectRatio: "1:1",
      inputImages: [],
      runId: "run_local_live_e2e",
    });

    expect(result.modelId).toContain("local/macos-coreml-stable-diffusion-2-1-base-palettized");
    expect(result.images).toHaveLength(1);
    expect(storedAssets).toHaveLength(1);
    for (const asset of result.images) {
      expect(asset.mimeType).toBe("image/png");
      expect(asset.sizeBytes).toBeGreaterThan(10_000);
      const bytes = await readFile(asset.path);
      expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  }, 120_000);

  it("runs real Core ML image-to-image flow using the first generated image as reference", async () => {
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
      runId: "run_local_live_e2e_img2img",
      projectPath: "Studio/Local.live.e2e.systemsculpt",
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

    const base = await generateImageWithLocalMacProvider(context, {
      prompt: "Studio portrait of a modern product design workspace",
      count: 1,
      aspectRatio: "1:1",
      inputImages: [],
      runId: "run_local_live_e2e_img2img_base",
    });
    expect(base.images).toHaveLength(1);

    const refined = await generateImageWithLocalMacProvider(context, {
      prompt: "Refine into a high-contrast editorial style while preserving layout",
      count: 1,
      aspectRatio: "1:1",
      inputImages: [base.images[0]],
      qualityPreset: "balanced",
      referenceInfluence: "strong",
      runId: "run_local_live_e2e_img2img_refined",
    });

    expect(refined.modelId).toContain("local/macos-coreml-stable-diffusion-2-1-base-palettized");
    expect(refined.images).toHaveLength(1);
    const bytes = await readFile(refined.images[0].path);
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(storedAssets.length).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
