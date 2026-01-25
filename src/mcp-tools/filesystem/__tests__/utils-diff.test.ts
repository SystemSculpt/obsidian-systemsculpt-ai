/**
 * @jest-environment node
 */

import { createSimpleDiff } from "../utils";
import { FILESYSTEM_LIMITS } from "../constants";

describe("createSimpleDiff – bounded output", () => {
  test("stays within transport budget and includes headers + summary", () => {
    const original = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const modified = Array.from({ length: 100 }, (_, i) => `line ${i} changed`).join("\n");

    const diff = createSimpleDiff(original, modified, "test.txt");

    expect(diff.startsWith(`--- test.txt\n+++ test.txt`)).toBe(true);
    expect(diff).toMatch(/\n\nSummary: \+\d+ -\d+ lines( \(truncated to \d+ chars\))?$/);
    expect(diff.length).toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS);
    expect(diff).not.toContain("diff truncated");
  });

  test("truncates output when exceeding MAX_RESPONSE_CHARS", () => {
    // Create very large diff that will exceed the limit
    const lineCount = 10000;
    const original = Array.from({ length: lineCount }, (_, i) => `original line ${i} with some additional content to make it longer`).join("\n");
    const modified = Array.from({ length: lineCount }, (_, i) => `modified line ${i} with different content that is also quite long`).join("\n");

    const diff = createSimpleDiff(original, modified, "large.txt");

    expect(diff.length).toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS);
    expect(diff).toContain("truncated");
  });

  test("counts added and removed lines correctly", () => {
    const original = "line1\nline2\nline3";
    const modified = "line1\nnew\nline3\nextra";

    const diff = createSimpleDiff(original, modified, "test.txt");

    // line2 removed (-1), new added (+1), extra added (+1)
    expect(diff).toContain("+2");
    expect(diff).toContain("-1");
  });

  test("handles only removals", () => {
    const original = "line1\nline2\nline3";
    const modified = "line1";

    const diff = createSimpleDiff(original, modified, "test.txt");

    expect(diff).toContain("- line2");
    expect(diff).toContain("- line3");
    expect(diff).toContain("-2");
  });

  test("handles only additions", () => {
    const original = "line1";
    const modified = "line1\nline2\nline3";

    const diff = createSimpleDiff(original, modified, "test.txt");

    expect(diff).toContain("+ line2");
    expect(diff).toContain("+ line3");
    expect(diff).toContain("+2");
  });
});
