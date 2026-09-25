import {
  DURABLE_TOOL_LIST_LIMIT,
  DURABLE_TOOL_TEXT_LIMIT,
  durableToolResult,
} from "../DurableToolResult";

describe("durableToolResult", () => {
  it("keeps what history presents and cuts long text such as note content", () => {
    const content = "a".repeat(20_000);
    const result = {
      success: true,
      data: {
        summary: "Read 1 file",
        files: [{ path: "Projects/Plan.md", content, success: true }],
      },
    };
    const bounded = durableToolResult(result);
    const file = (bounded.data as { files: Array<Record<string, unknown>> }).files[0];
    expect(bounded.success).toBe(true);
    expect((bounded.data as { summary: string }).summary).toBe("Read 1 file");
    expect(file.path).toBe("Projects/Plan.md");
    expect(file.success).toBe(true);
    expect(file.content).toBe(
      `${"a".repeat(DURABLE_TOOL_TEXT_LIMIT)}… [${20_000 - DURABLE_TOOL_TEXT_LIMIT} more characters]`,
    );
    expect(JSON.stringify(bounded).length).toBeLessThan(1_000);
    // The live result is never modified.
    expect(result.data.files[0].content).toBe(content);
  });

  it("keeps the head of long lists, bounds depth, and bounds errors", () => {
    const matches = Array.from({ length: 500 }, (_, index) => ({ path: `Note ${index}.md` }));
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    const bounded = durableToolResult({
      success: false,
      data: { matches, nested },
      error: {
        code: "TOOL_PARTIAL_FAILURE",
        message: "x".repeat(2_000),
        details: { reasons: ["y".repeat(2_000)] },
      },
    });
    const data = bounded.data as { matches: unknown[]; nested: unknown };
    expect(data.matches).toHaveLength(DURABLE_TOOL_LIST_LIMIT);
    expect(data.matches[0]).toEqual({ path: "Note 0.md" });
    expect(JSON.stringify(data.nested)).toContain("[omitted]");
    expect(bounded.error?.code).toBe("TOOL_PARTIAL_FAILURE");
    expect(bounded.error?.message.length).toBeLessThan(600);
    expect(JSON.stringify(bounded.error?.details).length).toBeLessThan(700);
  });

  it("never splits a surrogate pair and leaves short values untouched", () => {
    const emoji = "\u{1F600}";
    const text = `${"b".repeat(DURABLE_TOOL_TEXT_LIMIT - 1)}${emoji}tail`;
    const bounded = durableToolResult({ success: true, data: text });
    expect(bounded.data).toBe(`${"b".repeat(DURABLE_TOOL_TEXT_LIMIT - 1)}… [${text.length - DURABLE_TOOL_TEXT_LIMIT + 1} more characters]`);
    expect(durableToolResult({ success: true, data: { count: 3, ok: null } }))
      .toEqual({ success: true, data: { count: 3, ok: null } });
    expect(durableToolResult({ success: true })).toEqual({ success: true });
  });
});
