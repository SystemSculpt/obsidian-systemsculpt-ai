import { requestUrl } from "obsidian";
import { postJsonStreaming } from "../streaming";

jest.mock("obsidian", () => ({ requestUrl: jest.fn() }));

describe("postJsonStreaming", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps managed SSE on fetch when available", async () => {
    const response = new Response("data: ok\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    global.fetch = jest.fn().mockResolvedValue(response) as jest.Mock;

    await expect(postJsonStreaming("https://api.systemsculpt.com/api/v1/chat", {}, {}, false))
      .resolves.toBe(response);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("preserves a buffered managed SSE fallback", async () => {
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      text: "data: ok\n\ndata: [DONE]\n\n",
      headers: { "content-type": "text/event-stream" },
    });

    const response = await postJsonStreaming("https://api.systemsculpt.com/api/v1/chat", {}, {}, true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("[DONE]");
  });
});
