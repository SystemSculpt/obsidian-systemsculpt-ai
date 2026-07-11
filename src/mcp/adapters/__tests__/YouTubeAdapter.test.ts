/** @jest-environment node */

const executeTool = jest.fn();
const getTools = jest.fn();

jest.mock("../../../mcp-tools/youtube/MCPYouTubeServer", () => ({
  MCPYouTubeServer: jest.fn().mockImplementation(() => ({ executeTool, getTools })),
}));

import { YouTubeAdapter } from "../YouTubeAdapter";

describe("YouTubeAdapter cancellation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not invoke a tool when the caller is already aborted", async () => {
    const adapter = new YouTubeAdapter({} as any, {} as any);
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.executeTool("transcript", {}, undefined, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "TOOL_CANCELLED_BEFORE_START" });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("reports an unknown outcome when abort is requested after execution starts", async () => {
    const adapter = new YouTubeAdapter({} as any, {} as any);
    executeTool.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();

    const execution = adapter.executeTool("transcript", {}, undefined, { signal: controller.signal });
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN" });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
