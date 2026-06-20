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

  describe("on mobile (no Node runtime, #207)", () => {
    beforeEach(() => {
      jest
        .spyOn(PlatformContext, "get")
        .mockReturnValue({ supportsNodeApis: () => false } as unknown as PlatformContext);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("never constructs the Node-backed filesystem server", () => {
      new FilesystemAdapter({} as any, {} as any);

      expect(lastServerInstance).toBeNull();
    });

    it("degrades listTools to an empty list instead of crashing", async () => {
      const adapter = new FilesystemAdapter({} as any, {} as any);

      await expect(adapter.listTools()).resolves.toEqual([]);
    });

    it("throws a clear desktop-only error from executeTool", async () => {
      const adapter = new FilesystemAdapter({} as any, {} as any);

      await expect(adapter.executeTool("read", { path: "note.md" })).rejects.toThrow(
        /desktop runtime/i,
      );
    });

    it("treats setAllowedPaths as a no-op", () => {
      const adapter = new FilesystemAdapter({} as any, {} as any);

      expect(() => adapter.setAllowedPaths(["/vault"])).not.toThrow();
    });
  });
});
