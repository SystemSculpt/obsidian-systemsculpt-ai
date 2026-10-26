/** @jest-environment jsdom */

import { DiffViewer } from "../DiffViewer";
import { generateDiff, parseUnifiedDiff, type DiffResult } from "../../utils/diffUtils";

function newFile(lines: number): DiffResult {
  return generateDiff("", Array.from({ length: lines }, (_, index) => `Line ${index + 1}`).join("\n"));
}

describe("DiffViewer", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("preserves the default file header and real patch line numbers", () => {
    const host = document.body.createDiv();
    new DiffViewer({
      container: host,
      diffResult: parseUnifiedDiff("@@ -21 +21 @@\n-before\n+after")!,
      fileName: "Plan.md",
      showLineNumbers: true,
    }).render();
    expect(host.querySelector(".systemsculpt-diff-filename")?.textContent).toBe("Plan.md");
    expect(host.querySelector(".systemsculpt-diff-line-number-old")?.textContent).toBe("21");
    expect(Array.from(host.querySelectorAll(".systemsculpt-diff-prefix"), (line) => line.textContent))
      .toEqual(["−", "+"]);
  });

  it("hides duplicate file headers without hiding an unmatched-edit warning", () => {
    const host = document.body.createDiv();
    new DiffViewer({
      container: host, diffResult: generateDiff("same", "same"), fileName: "Plan.md",
      hideHeader: true, emptyReason: "unmatched", emptyDetail: "One requested edit was not found.",
    }).render();
    expect(host.querySelector(".systemsculpt-diff-header")).toBeNull();
    expect(host.textContent).toContain("This change could not be matched in the file");
    expect(host.textContent).toContain("One requested edit was not found.");
    expect(host.classList.contains("is-blocked")).toBe(true);
  });

  it("discloses all remaining lines without silently dropping or mutating the diff", () => {
    const host = document.body.createDiv();
    const diff = newFile(31);
    new DiffViewer({ container: host, diffResult: diff, fileName: "Plan.md", maxVisibleLines: 12 }).render();
    expect(host.querySelectorAll(".systemsculpt-diff-line")).toHaveLength(12);
    const showAll = host.querySelector<HTMLButtonElement>('[data-testid="chat.diff.show-all"]')!;
    expect(showAll.textContent).toBe("Show full diff (31 lines)");
    expect(showAll.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(showAll.getAttribute("aria-controls")!)).not.toBeNull();
    showAll.focus();
    showAll.click();
    expect(host.querySelectorAll(".systemsculpt-diff-line")).toHaveLength(31);
    expect(showAll.getAttribute("aria-expanded")).toBe("true");
    expect(showAll.textContent).toBe("Show less");
    expect(document.activeElement).toBe(showAll);
    expect(host.textContent).toContain("Line 31");
    showAll.click();
    expect(host.querySelectorAll(".systemsculpt-diff-line")).toHaveLength(12);
    expect(diff.lines).toHaveLength(31);
  });

  it("counts across hunks and preserves every hunk when expanded", () => {
    const host = document.body.createDiv();
    const patch = "@@ -1 +1 @@\n-a\n+b\n@@ -100 +100 @@\n-c\n+d";
    new DiffViewer({
      container: host, diffResult: parseUnifiedDiff(patch)!, fileName: "Plan.md", maxVisibleLines: 2,
    }).render();
    expect(host.querySelectorAll(".systemsculpt-diff-hunk")).toHaveLength(1);
    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(host.querySelectorAll(".systemsculpt-diff-hunk")).toHaveLength(2);
    expect(host.textContent).toContain("-100 +100");
  });

  it("keeps a short preview completely visible without a redundant disclosure", () => {
    const host = document.body.createDiv();
    new DiffViewer({ container: host, diffResult: newFile(12), fileName: "Plan.md", maxVisibleLines: 12 }).render();
    expect(host.querySelectorAll(".systemsculpt-diff-line")).toHaveLength(12);
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector(".systemsculpt-diff-content")?.classList.contains("is-disclosed")).toBe(true);
  });

  it("keeps an explicit truncated-preview warning when a file header is hidden", () => {
    const host = document.body.createDiv();
    new DiffViewer({
      container: host, diffResult: { ...newFile(2), isTruncated: true }, fileName: "Plan.md", hideHeader: true,
    }).render();
    expect(host.textContent).toContain("Preview shortened — open the file to review the full change.");
  });
});
