import type { AgentPart } from "../AgentConversation";
import {
  finalAgentAnswerPartIds,
  formatAgentActivityDuration,
  formatAgentWorkingDuration,
  groupAdjacentAgentActivity,
  isAgentActivityPart,
  splitPreviousAgentActivity,
} from "../AgentActivityPresentation";

describe("AgentActivityPresentation", () => {
  it("groups adjacent reasoning and tools without crossing text or errors", () => {
    const items = ["reasoning", "tool", "text", "tool", "reasoning", "error", "tool"];

    const timeline = groupAdjacentAgentActivity(
      items,
      (item) => item === "reasoning" || item === "tool",
    );

    expect(timeline).toEqual([
      { kind: "activity", items: ["reasoning", "tool"] },
      { kind: "item", item: "text" },
      { kind: "activity", items: ["tool", "reasoning"] },
      { kind: "item", item: "error" },
      { kind: "activity", items: ["tool"] },
    ]);
  });

  it("keeps only the newest adjacent activity row outside the overflow fold", () => {
    expect(splitPreviousAgentActivity(["reasoning", "read", "search"])).toEqual({
      previous: ["reasoning", "read"],
      latest: "search",
    });
    expect(splitPreviousAgentActivity<string>([])).toEqual({ previous: [], latest: null });
  });

  it.each([
    [undefined, null],
    [0, "1ms"],
    [949, "949ms"],
    [1_050, "1.1s"],
    [9_950, "10s"],
    [10_200, "10s"],
    [59_600, "60s"],
    [60_000, "1m"],
    [105_000, "1m 45s"],
    [119_600, "2m"],
  ])("formats %s milliseconds like the T3 activity timer", (milliseconds, expected) => {
    expect(formatAgentActivityDuration(milliseconds)).toBe(expected);
  });

  it.each([
    [undefined, null],
    [0, "0s"],
    [999, "0s"],
    [9_999, "9s"],
    [62_900, "1m 2s"],
    [3_600_000, "1h"],
    [3_660_000, "1h 1m"],
  ])("formats %s milliseconds like the T3 live Working timer", (milliseconds, expected) => {
    expect(formatAgentWorkingDuration(milliseconds)).toBe(expected);
  });

  it("classifies reasoning and tools as activity without folding text or errors", () => {
    const part = (kind: AgentPart["kind"]): AgentPart => ({ kind } as AgentPart);
    expect(isAgentActivityPart(part("reasoning"))).toBe(true);
    expect(isAgentActivityPart(part("tool"))).toBe(true);
    expect(isAgentActivityPart(part("text"))).toBe(false);
    expect(isAgentActivityPart(part("error"))).toBe(false);
  });

  it("keeps only the final answer suffix and later sources outside the fold", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "progress-1", messageId: "assistant-1", kind: "content", visible: true },
      { id: "reasoning-1", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "progress-2", messageId: "assistant-1", kind: "content", visible: true },
      { id: "tool-1", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "answer", messageId: "assistant-1", kind: "content", visible: true },
      { id: "sources", messageId: "assistant-1", kind: "sources", visible: true },
    ])]).toEqual(["answer", "sources"]);
  });

  it("keeps a terminal answer and Sources outside after late activity", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "commentary", messageId: "assistant-1", kind: "content", visible: true },
      { id: "tool-1", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "answer", messageId: "assistant-1", kind: "content", visible: true },
      { id: "late-tool", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "sources", messageId: "assistant-1", kind: "sources", visible: true },
    ])]).toEqual(["answer", "sources"]);
  });

  it("ignores invisible terminal content after late activity in a newer message", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "answer", messageId: "assistant-1", kind: "content", visible: true },
      { id: "late-tool", messageId: "assistant-2", kind: "activity", visible: true },
      { id: "blank", messageId: "assistant-2", kind: "content", visible: false },
      { id: "sources", messageId: "assistant-2", kind: "sources", visible: true },
    ])]).toEqual(["answer", "sources"]);
  });

  it("stops terminal content at an activity or durable message boundary", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "commentary", messageId: "assistant-1", kind: "content", visible: true },
      { id: "tool", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "prior-message", messageId: "assistant-1", kind: "content", visible: true },
      { id: "answer-a", messageId: "assistant-2", kind: "content", visible: true },
      { id: "answer-b", messageId: "assistant-2", kind: "content", visible: true },
    ])]).toEqual(["answer-a", "answer-b"]);
  });

  it("keeps Sources outside when no ordinary answer text exists", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "tool", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "sources", messageId: "assistant-1", kind: "sources", visible: true },
    ])]).toEqual(["sources"]);
  });
});
