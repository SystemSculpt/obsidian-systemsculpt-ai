import { describe, expect, it } from "@jest/globals";
import { StreamingService } from "../StreamingService";

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
}

describe("StreamingService.streamResponse abort behavior", () => {
  it("stops promptly when aborted while reader.read() is pending", async () => {
    const svc = new StreamingService();
    const controller = new AbortController();

    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue/close: keeps reader.read() pending indefinitely.
      },
    });
    const response = new Response(stream);

    const gen = svc.streamResponse(response, {
      model: "systemsculpt@@systemsculpt/ai-agent",
      isCustomProvider: false,
      signal: controller.signal,
    });

    const pending = gen.next();
    // Give the generator a moment to reach reader.read().
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const result = await Promise.race([pending, timeout(1000)]);
    expect(result.done).toBe(true);
  });
});

