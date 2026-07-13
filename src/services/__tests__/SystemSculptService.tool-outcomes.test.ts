/**
 * @jest-environment node
 */
import { normalizeLocalToolOutcome } from "../SystemSculptService";

describe("normalizeLocalToolOutcome", () => {
  it("preserves successful resolved results", () => {
    const data = { path: "note.md", success: true };
    expect(normalizeLocalToolOutcome(data)).toEqual({ success: true, data });
  });

  it("promotes top-level resolved failures", () => {
    const data = { success: false, appliedCount: 0, error: "Nothing changed" };
    const result = normalizeLocalToolOutcome(data);

    expect(result).toMatchObject({
      success: false,
      data,
      error: { code: "TOOL_OPERATION_FAILED", message: "Nothing changed" },
    });
    expect(result.error?.details.result).toBe(data);
  });

  it("promotes aggregate partial failures and retains their details", () => {
    const data = {
      results: [
        { path: "one.md", success: true },
        { path: "two.md", success: false, error: "Denied" },
      ],
    };
    const result = normalizeLocalToolOutcome(data);

    expect(result).toMatchObject({
      success: false,
      data,
      error: {
        code: "TOOL_PARTIAL_FAILURE",
        details: {
          failures: [{ location: "results[two.md]", message: "Denied" }],
          result: data,
        },
      },
    });
  });

  it("promotes failed read entries and workspace error lists", () => {
    expect(normalizeLocalToolOutcome({
      files: [{ path: "missing.md", content: "", error: "File not found" }],
    })).toMatchObject({ success: false, error: { code: "TOOL_OPERATION_FAILED" } });

    expect(normalizeLocalToolOutcome({
      opened: [],
      errors: ["Could not open missing.md"],
    })).toMatchObject({ success: false, error: { message: "Could not open missing.md" } });
  });
});
