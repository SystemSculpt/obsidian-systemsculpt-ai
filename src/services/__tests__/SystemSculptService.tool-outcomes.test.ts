/**
 * @jest-environment node
 */
import { normalizeLocalToolOutcome } from "../SystemSculptService";

const PRIVATE_FAILURE_SENTINEL = "/Users/private/SecretVault failure sentinel";

const REAL_MIXED_BATCH_OUTPUTS = [
  {
    tool: "read",
    data: {
      files: [
        { path: "Ready.md", content: "ok" },
        { path: "Missing.md", content: "", error: PRIVATE_FAILURE_SENTINEL },
      ],
    },
  },
  {
    tool: "create_folders",
    data: {
      results: [
        { path: "Ready", success: true },
        { path: "Denied", success: false, error: PRIVATE_FAILURE_SENTINEL },
      ],
    },
  },
  {
    tool: "list_items",
    data: {
      results: [
        { path: "Ready", files: [], offset: 0, totalItems: 0, nextOffset: null },
        { path: "Missing", error: PRIVATE_FAILURE_SENTINEL, offset: 0, totalItems: 0, nextOffset: null },
      ],
    },
  },
  {
    tool: "move",
    data: {
      results: [
        { source: "Ready.md", destination: "Archive/Ready.md", success: true },
        {
          source: "Missing.md",
          destination: "Archive/Missing.md",
          success: false,
          error: PRIVATE_FAILURE_SENTINEL,
        },
      ],
    },
  },
  {
    tool: "trash",
    data: {
      results: [
        { path: "Ready.md", success: true },
        { path: "Missing.md", success: false, error: PRIVATE_FAILURE_SENTINEL },
      ],
    },
  },
  {
    tool: "context",
    data: {
      action: "add",
      processed: 1,
      results: [
        { path: "Ready.md", success: true },
        { path: "Missing.md", success: false, reason: PRIVATE_FAILURE_SENTINEL },
      ],
      summary: "Pinned 1 file. 1 path succeeded, 1 failed.",
    },
  },
  {
    tool: "open",
    data: {
      opened: ["Ready.md"],
      errors: [PRIVATE_FAILURE_SENTINEL],
    },
  },
  {
    tool: "multi_edit",
    data: {
      success: false,
      requestedFiles: 2,
      appliedFiles: 1,
      preflightFailed: false,
      results: [
        {
          path: "Ready.md",
          success: true,
          appliedCount: 1,
          requestedCount: 1,
          skipped: [],
        },
        {
          path: "Conflict.md",
          success: false,
          appliedCount: 0,
          requestedCount: 1,
          skipped: [],
          error: PRIVATE_FAILURE_SENTINEL,
        },
      ],
    },
  },
] as const;

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

  it.each(REAL_MIXED_BATCH_OUTPUTS)(
    "normalizes the actual $tool mixed-result schema as partial",
    ({ data }) => {
      expect(normalizeLocalToolOutcome(data)).toMatchObject({
        success: false,
        data,
        error: { code: "TOOL_PARTIAL_FAILURE" },
      });
    },
  );

  it("distinguishes successful, mixed, and failed workspace-open batches", () => {
    const successful = { opened: ["One.md", "Two.md"], errors: [] };
    expect(normalizeLocalToolOutcome(successful)).toEqual({
      success: true,
      data: successful,
    });

    expect(normalizeLocalToolOutcome({
      opened: ["One.md"],
      errors: [PRIVATE_FAILURE_SENTINEL],
    })).toMatchObject({
      success: false,
      error: { code: "TOOL_PARTIAL_FAILURE" },
    });

    expect(normalizeLocalToolOutcome({
      opened: [],
      errors: [PRIVATE_FAILURE_SENTINEL, PRIVATE_FAILURE_SENTINEL],
    })).toMatchObject({
      success: false,
      error: { code: "TOOL_OPERATION_FAILED" },
    });
  });

  it("counts only valid opened paths when classifying a workspace-open batch", () => {
    expect(normalizeLocalToolOutcome({
      opened: ["One.md", "", { path: "not-an-opened-path" }],
      errors: [PRIVATE_FAILURE_SENTINEL],
    }, "open")).toMatchObject({
      success: false,
      error: { code: "TOOL_PARTIAL_FAILURE" },
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
