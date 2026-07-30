import { createHash } from "node:crypto";
import { getLoadedPluginBuildId } from "../LoadedPluginBuildIdentity";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function app(readBinary: jest.Mock) {
  return {
    vault: {
      configDir: ".obsidian",
      adapter: { readBinary },
    },
  };
}

function manifest(recordedMainHash?: string) {
  const base = {
    id: "systemsculpt-ai",
    name: "SystemSculpt AI",
    version: "6.2.7",
    minAppVersion: "1.7.2",
    isDesktopOnly: false,
  };
  if (!recordedMainHash) return base;
  return {
    ...base,
    systemsculptDevBuild: {
      schemaVersion: 1,
      id: "12345678-dirty-20260730T120000000Z",
      revision: "1234567890abcdef1234567890abcdef12345678",
      branch: "test/build",
      dirty: true,
      syncedAt: "2026-07-30T12:00:00.000Z",
      sourcePath: "/test/plugin",
      artifacts: {
        "main.js": recordedMainHash,
        "manifest.json": "b".repeat(64),
        "styles.css": "c".repeat(64),
      },
    },
  };
}

describe("loaded plugin build identity", () => {
  const installedBytes = Uint8Array.from(Buffer.from("installed main bundle\n"));
  const installedDigest = sha256(installedBytes);

  it("hashes the installed main.js bytes for a released manifest", async () => {
    const readBinary = jest.fn(async () => asArrayBuffer(installedBytes));

    await expect(getLoadedPluginBuildId(
      app(readBinary) as never,
      manifest() as never,
    )).resolves.toBe(`sha256:${installedDigest}`);
    expect(readBinary).toHaveBeenCalledWith(
      ".obsidian/plugins/systemsculpt-ai/main.js",
    );
  });

  it("reads installed bytes and verifies a matching development manifest claim", async () => {
    const readBinary = jest.fn(async () => asArrayBuffer(installedBytes));

    await expect(getLoadedPluginBuildId(
      app(readBinary) as never,
      manifest(installedDigest) as never,
    )).resolves.toBe(`sha256:${installedDigest}`);
    expect(readBinary).toHaveBeenCalledTimes(1);
  });

  it("rejects a development manifest claim that does not match installed bytes", async () => {
    const readBinary = jest.fn(async () => asArrayBuffer(installedBytes));

    await expect(getLoadedPluginBuildId(
      app(readBinary) as never,
      manifest("d".repeat(64)) as never,
    )).rejects.toThrow(
      "SystemSculpt could not verify this plugin update. Reload Obsidian and try again.",
    );
    expect(readBinary).toHaveBeenCalledTimes(1);
  });

  it("keeps hostile read details out of user-facing copy while preserving the cause", async () => {
    const cause = new Error(
      "ENOENT /Users/private/Vault/.obsidian/plugins/systemsculpt-ai/main.js connection.ticket transport",
    );
    const readBinary = jest.fn(async () => {
      throw cause;
    });

    let failure: unknown;
    try {
      await getLoadedPluginBuildId(
        app(readBinary) as never,
        manifest(installedDigest) as never,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "SystemSculpt could not verify this plugin update. Reload Obsidian and try again.",
    );
    expect((failure as Error).message).not.toContain("/Users/private");
    expect((failure as Error).message).not.toContain("connection");
    expect((failure as Error & { cause?: unknown }).cause).toBe(cause);
  });
});
