/**
 * @jest-environment node
 */

import { createToolCallIdState, sanitizeToolCallId } from "@/utils/toolCallId";

describe("Jest runtime sanity (SWC)", () => {
  it("resolves @/ alias and executes TS modules", () => {
    const state = createToolCallIdState();
    const id = sanitizeToolCallId("call_abc123", 0, state);
    expect(id).toBe("call_abc123");
  });
});

