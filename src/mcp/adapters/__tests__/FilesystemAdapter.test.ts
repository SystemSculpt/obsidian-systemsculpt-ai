/**
 * @jest-environment node
 */
let lastServerInstance: { getTools: jest.Mock; executeTool: jest.Mock } | null = null;

jest.mock("../../../mcp-tools/filesystem/MCPFilesystemServer", () => ({
  MCPFilesystemServer: jest.fn().mockImplementation(() => {
    const instance = { getTools: jest.fn(), executeTool: jest.fn() };
    lastServerInstance = instance;
    return instance;
  }),
}));

import { FilesystemAdapter } from "../FilesystemAdapter";
import { PlatformContext } from "../../../services/PlatformContext";

const getLastServerInstance = () => {
  if (!lastServerInstance) {
    throw new Error("MCPFilesystemServer mock was not constructed");
  }
  return lastServerInstance;
};

describe("FilesystemAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastServerInstance = null;
  });

  it("lists tools via MCPFilesystemServer", async () => {
    const adapter = new FilesystemAdapter({} as any, {} as any);
    const server = getLastServerInstance();
    server.getTools.mockResolvedValue([{ name: "read" }]);

    const result = await adapter.listTools();

    expect(server.getTools).toHaveBeenCalled();
    expect(result).toEqual([{ name: "read" }]);
  });

  it("executes tools via MCPFilesystemServer", async () => {
    const adapter = new FilesystemAdapter({} as any, {} as any);
    const server = getLastServerInstance();
    server.executeTool.mockResolvedValue({ ok: true });

    const result = await adapter.executeTool("read", { path: "note.md" }, { view: true });

    expect(server.executeTool).toHaveBeenCalledWith("read", { path: "note.md" }, { view: true });
    expect(result).toEqual({ ok: true });
  });

  // Since #142 the filesystem tool graph is pure Vault-API code (no Node), so it
  // runs on mobile too. The adapter must NOT gate the server off when the
  // runtime reports mobile — agent file tools must work on a phone.
  describe("on mobile (no Node runtime, #142)", () => {
    beforeEach(() => {
      jest
        .spyOn(PlatformContext, "get")
        .mockReturnValue({ supportsNodeApis: () => false } as unknown as PlatformContext);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("still constructs the filesystem server (no desktop-only gate)", () => {
      new FilesystemAdapter({} as any, {} as any);

      expect(lastServerInstance).not.toBeNull();
    });

    it("delegates listTools to the server instead of degrading", async () => {
      const adapter = new FilesystemAdapter({} as any, {} as any);
      const server = getLastServerInstance();
      server.getTools.mockResolvedValue([{ name: "write" }]);

      await expect(adapter.listTools()).resolves.toEqual([{ name: "write" }]);
    });

    it("executes tools on mobile instead of throwing a desktop-only error", async () => {
      const adapter = new FilesystemAdapter({} as any, {} as any);
      const server = getLastServerInstance();
      server.executeTool.mockResolvedValue({ ok: true });

      await expect(adapter.executeTool("write", { path: "note.md" })).resolves.toEqual({
        ok: true,
      });
      expect(server.executeTool).toHaveBeenCalledWith("write", { path: "note.md" }, undefined);
    });

    it("forwards setAllowedPaths to the server", () => {
      const adapter = new FilesystemAdapter({} as any, {} as any);
      const server = getLastServerInstance() as unknown as { setAllowedPaths?: jest.Mock };
      server.setAllowedPaths = jest.fn();

      adapter.setAllowedPaths(["/vault"]);

      expect(server.setAllowedPaths).toHaveBeenCalledWith(["/vault"]);
    });
  });
});
