/** @jest-environment jsdom */
import { FirstPartyToolService } from "../FirstPartyToolService";
import { FIRST_PARTY_TOOL_NAMES } from "../toolNames";

const vaultDefinitions = FIRST_PARTY_TOOL_NAMES
  .filter((name) => name !== "youtube_transcript")
  .map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  }));
const youtubeDefinitions = [{
  name: "youtube_transcript",
  description: "youtube description",
  inputSchema: { type: "object", properties: {} },
}];
const executeVaultTool = jest.fn();
const executeYouTubeTool = jest.fn();
const setAllowedPaths = jest.fn();

jest.mock("../vault/VaultToolModule", () => ({
  VaultToolModule: jest.fn().mockImplementation(() => ({
    getTools: () => vaultDefinitions,
    executeTool: executeVaultTool,
    setAllowedPaths,
  })),
}));

jest.mock("../youtube/YouTubeToolModule", () => ({
  YouTubeToolModule: jest.fn().mockImplementation(() => ({
    getTools: () => youtubeDefinitions,
    executeTool: executeYouTubeTool,
  })),
}));

describe("FirstPartyToolService", () => {
  let service: FirstPartyToolService;
  let plugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    plugin = { settings: { mcpServers: [{ id: "retired" }] } };
    service = new FirstPartyToolService(plugin, {} as any);
    executeVaultTool.mockResolvedValue({ result: "vault" });
    executeYouTubeTool.mockResolvedValue({ result: "youtube" });
  });

  it("advertises only canonical first-party wire names", async () => {
    const tools = await service.getAvailableTools();

    expect(tools.map((tool) => tool.function.name)).toEqual(FIRST_PARTY_TOOL_NAMES);
    expect(tools.every((tool) => !tool.function.name.includes("mcp"))).toBe(true);
    expect(tools.every((tool) => !tool.function.description?.startsWith("["))).toBe(true);
  });

  it("executes canonical vault and YouTube names directly", async () => {
    await expect(service.executeTool("read", { paths: ["Inbox.md"] }))
      .resolves.toEqual({ result: "vault" });
    expect(executeVaultTool).toHaveBeenCalledWith("read", { paths: ["Inbox.md"] });

    await expect(service.executeTool("youtube_transcript", { url: "https://youtu.be/abcdefghijk" }))
      .resolves.toEqual({ result: "youtube" });
    expect(executeYouTubeTool).toHaveBeenCalledWith(
      "youtube_transcript",
      { url: "https://youtu.be/abcdefghijk" },
    );
  });

  it("rejects persisted legacy aliases on the live execution boundary", async () => {
    await expect(service.executeTool("mcp-filesystem_read", { paths: ["Legacy.md"] }))
      .rejects.toThrow("Unknown first-party tool");
    await expect(service.executeTool("mcp-youtube_youtube_transcript", { url: "legacy" }))
      .rejects.toThrow("Unknown first-party tool");
    expect(executeVaultTool).not.toHaveBeenCalled();
    expect(executeYouTubeTool).not.toHaveBeenCalled();
  });

  it("rejects unknown and retired external tool names", async () => {
    await expect(service.executeTool("unknown", {})).rejects.toThrow("Unknown first-party tool");
    await expect(service.executeTool("mcp-external_write", {})).rejects.toThrow("Unknown first-party tool");
    expect(executeVaultTool).not.toHaveBeenCalled();
    expect(executeYouTubeTool).not.toHaveBeenCalled();
  });

  it("maps every canonical vault path under an optional root", async () => {
    const root = ".systemsculpt/temp/runtime-smoke";
    service.setVaultRoot(root, ["SandboxRoot"]);

    await service.executeTool("multi_edit", {
      files: [
        { path: "SandboxRoot/Inbox/One.md", edits: [] },
        { path: `/${root}/Inbox/Two.md`, edits: [] },
      ],
    });

    expect(executeVaultTool).toHaveBeenCalledWith("multi_edit", {
      files: [
        { path: `${root}/Inbox/One.md`, edits: [] },
        { path: `${root}/Inbox/Two.md`, edits: [] },
      ],
    });
  });

  it("forwards allowed vault paths directly", () => {
    service.setVaultAllowedPaths(["Inbox"]);
    expect(setAllowedPaths).toHaveBeenCalledWith(["Inbox"]);
  });

  it("does not mutate retired settings", async () => {
    const before = JSON.stringify(plugin.settings);
    await service.getAvailableTools();
    expect(JSON.stringify(plugin.settings)).toBe(before);
  });

  it("does not start an already-cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(service.executeTool("read", {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "TOOL_CANCELLED_BEFORE_START" });
    expect(executeVaultTool).not.toHaveBeenCalled();
  });

  it("reports an unknown outcome when cancellation follows execution start", async () => {
    executeVaultTool.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();

    const execution = service.executeTool("write", {}, { signal: controller.signal });
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
    });
    expect(executeVaultTool).toHaveBeenCalledTimes(1);
  });
});
