/** @jest-environment jsdom */

import { enhanceMarkdownCodeBlocks, setMarkdownCodeExpanded } from "../MarkdownCodeBlocks";

function fence(source: string, language = "ts"): { host: HTMLElement; pre: HTMLPreElement; code: HTMLElement } {
  const host = document.body.createDiv();
  const pre = host.createEl("pre");
  const code = pre.createEl("code", { text: source, cls: `language-${language}` });
  return { host, pre, code };
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
}

describe("chat markdown code blocks", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("keeps Obsidian highlighting and its copy surface, with a language label and keyboard scrolling", () => {
    const { host, pre, code } = fence("const answer = 42;");
    const keyword = document.createElement("span");
    keyword.className = "token keyword";
    keyword.textContent = "const";
    code.replaceChildren(keyword, document.createTextNode(" answer = 42;"));
    const nativeCopy = pre.createEl("button", { cls: "copy-code-button", text: "Copy code" });
    enhanceMarkdownCodeBlocks(host, { onCopyFeedback: jest.fn() });
    expect(pre.querySelector(".token.keyword")).toBe(keyword);
    expect(pre.querySelector(".systemsculpt-agent-code-copy")).toBe(nativeCopy);
    expect(nativeCopy.dataset.testid).toBe("chat.code.copy");
    expect(nativeCopy.getAttribute("aria-label")).toBe("Copy code");
    expect(nativeCopy.hasAttribute("aria-live")).toBe(false);
    expect(pre.querySelector(".systemsculpt-agent-code-language")?.textContent).toBe("ts");
    expect(pre.tabIndex).toBe(0);
  });

  it("copies the complete source once, even from a collapsed block with a native copy handler", async () => {
    const source = numberedLines(31);
    const { host, pre } = fence(source);
    const nativeCopy = pre.createEl("button", { cls: "copy-code-button" });
    const nativeHandler = jest.fn();
    nativeCopy.addEventListener("click", nativeHandler);
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const feedback = jest.fn();
    enhanceMarkdownCodeBlocks(host, { onCopyFeedback: feedback });
    nativeCopy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeHandler).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(source);
    expect(feedback).toHaveBeenCalledWith(nativeCopy, true);
  });

  it.each([30, 31])("only collapses blocks over 30 lines (%i)", (count) => {
    const { host, pre } = fence(`${numberedLines(count)}\n`);
    const finish = jest.fn();
    const begin = jest.fn(() => finish);
    enhanceMarkdownCodeBlocks(host, { onCopyFeedback: jest.fn(), beginLayoutMutation: begin });
    expect(pre.dataset.codeLines).toBe(String(count));
    expect(pre.classList.contains("is-code-collapsible")).toBe(count > 30);
    const control = pre.querySelector<HTMLButtonElement>('[data-testid="chat.code.show-all"]');
    if (count === 30) {
      expect(control).toBeNull();
    } else {
      expect(control?.textContent).toBe("Show all 31 lines");
      expect(control?.getAttribute("aria-expanded")).toBe("false");
      control!.focus();
      control!.click();
      expect(pre.classList.contains("is-code-expanded")).toBe(true);
      expect(control?.textContent).toBe("Show less");
      expect(control?.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(control);
      expect(begin).toHaveBeenCalledWith(control, pre);
      expect(finish).toHaveBeenCalledTimes(1);
      control!.click();
      expect(pre.classList.contains("is-code-expanded")).toBe(false);
    }
  });

  it("uses the shared DiffViewer for headerless fenced diffs with textual gutters and no line numbers", () => {
    const { host, pre, code } = fence("-before\n+after", "diff");
    enhanceMarkdownCodeBlocks(host, { onCopyFeedback: jest.fn() });
    expect(pre.classList.contains("is-fenced-diff")).toBe(true);
    expect(code.textContent).toBe("-before\n+after");
    expect(code.getAttribute("aria-hidden")).toBe("true");
    expect(pre.querySelector(".systemsculpt-diff-viewer")).not.toBeNull();
    expect(pre.querySelector(".systemsculpt-diff-header")).toBeNull();
    expect(pre.querySelector(".systemsculpt-diff-line-number")).toBeNull();
    expect(Array.from(pre.querySelectorAll(".systemsculpt-diff-prefix"), (line) => line.textContent))
      .toEqual(["−", "+"]);
  });

  it("renders complete unified patches but leaves incomplete streamed patches readable", () => {
    const { host, pre, code } = fence("@@ -7 +7 @@\n-before", "diff");
    enhanceMarkdownCodeBlocks(host, { onCopyFeedback: jest.fn() });
    expect(pre.querySelector(".systemsculpt-diff-viewer")).toBeNull();
    expect(code.textContent).toBe("@@ -7 +7 @@\n-before");
    code.textContent += "\n+after";
    enhanceMarkdownCodeBlocks(host, { onCopyFeedback: jest.fn() });
    expect(pre.querySelector(".systemsculpt-diff-viewer")).not.toBeNull();
    expect(pre.querySelectorAll(".systemsculpt-diff-line")).toHaveLength(2);
    expect(pre.querySelector(".systemsculpt-diff-line-number")).toBeNull();
  });

  it("enhances idempotently and restores an expanded disclosure without losing its label", () => {
    const { host, pre, code } = fence(numberedLines(31));
    const options = { onCopyFeedback: jest.fn() };
    enhanceMarkdownCodeBlocks(host, options);
    setMarkdownCodeExpanded(pre, true);
    code.textContent = numberedLines(32);
    enhanceMarkdownCodeBlocks(host, options);
    expect(pre.querySelectorAll('[data-testid="chat.code.copy"]')).toHaveLength(1);
    expect(pre.querySelectorAll('[data-testid="chat.code.show-all"]')).toHaveLength(1);
    expect(pre.querySelectorAll(".systemsculpt-agent-code-language")).toHaveLength(1);
    expect(pre.classList.contains("is-code-expanded")).toBe(true);
    expect(pre.querySelector('[data-testid="chat.code.show-all"]')?.textContent).toBe("Show less");
    setMarkdownCodeExpanded(pre, false);
    expect(pre.querySelector('[data-testid="chat.code.show-all"]')?.textContent).toBe("Show all 32 lines");
  });
});
