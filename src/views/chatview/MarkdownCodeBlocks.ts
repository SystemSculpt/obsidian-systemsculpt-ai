import { setTooltip } from "obsidian";
import { DiffViewer } from "../../components/DiffViewer";
import { createUiAction, updateUiAction } from "../../core/ui/surface";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { parseUnifiedDiff, type DiffResult } from "../../utils/diffUtils";

export type MarkdownCodeBlockOptions = Readonly<{
  onCopyFeedback: (button: HTMLButtonElement, copied: boolean) => void;
  beginLayoutMutation?: (
    control?: HTMLElement,
    target?: HTMLElement,
  ) => (() => void) | undefined;
}>;

let codeContentSequence = 0;

function languageOf(pre: HTMLPreElement, code: HTMLElement): string {
  for (const element of [code, pre]) {
    const language = Array.from(element.classList).find((name) => name.startsWith("language-"));
    if (language) return language.slice("language-".length);
  }
  return pre.getAttribute("data-language") ?? "text";
}

/** A headerless fenced example is presentation, not a patch to apply to a file. */
function fencedDiff(source: string): DiffResult | null {
  const patch = parseUnifiedDiff(source);
  if (patch) return patch;
  // Keep incomplete or malformed unified patches as readable code while streaming.
  if (/^(?:@@|diff |--- |\+\+\+ )/mu.test(source)) return null;
  const stats = { additions: 0, deletions: 0 };
  const lines = source.replace(/\r?\n$/u, "").split(/\r?\n/u).map((line) => {
    if (line.startsWith("+")) {
      stats.additions += 1;
      return { type: "added" as const, content: line.slice(1) };
    }
    if (line.startsWith("-")) {
      stats.deletions += 1;
      return { type: "removed" as const, content: line.slice(1) };
    }
    return { type: "unchanged" as const, content: line.startsWith(" ") ? line.slice(1) : line };
  });
  return stats.additions || stats.deletions ? { lines, stats, isTruncated: false } : null;
}

/** Also used when streaming restores a reader's disclosure state after a render. */
export function setMarkdownCodeExpanded(pre: HTMLElement, expanded: boolean): void {
  pre.classList.toggle("is-code-expanded", expanded);
  const showAll = pre.querySelector<HTMLButtonElement>(".systemsculpt-agent-code-show-all");
  if (!showAll) return;
  showAll.setAttribute("aria-expanded", String(expanded));
  updateUiAction(showAll, {
    label: expanded ? "Show less" : `Show all ${pre.dataset.codeLines ?? ""} lines`,
  });
}

/** Adds chat affordances without replacing Obsidian's rendered code or highlighting. */
export function enhanceMarkdownCodeBlocks(
  parent: HTMLElement,
  options: MarkdownCodeBlockOptions,
): void {
  for (const pre of Array.from(parent.querySelectorAll<HTMLPreElement>("pre"))) {
    const code = pre.querySelector<HTMLElement>(":scope > code");
    if (!code) continue;
    pre.addClass("systemsculpt-agent-code-block");
    pre.tabIndex = 0;
    const language = languageOf(pre, code);
    pre.setAttribute("aria-label", `${language} code`);
    const source = code.textContent ?? "";
    const lines = source.replace(/\r?\n$/u, "").split(/\r?\n/u).length;
    pre.dataset.codeLines = String(lines);

    let label = pre.querySelector<HTMLElement>(":scope > .systemsculpt-agent-code-language");
    if (!label) label = pre.createSpan({ cls: "systemsculpt-agent-code-language" });
    label.textContent = language;
    label.setAttribute("aria-hidden", "true");

    let copy = pre.querySelector<HTMLButtonElement>(".systemsculpt-agent-code-copy");
    if (!copy) {
      // Retain the native copy-code-button so Obsidian themes still style it.
      copy = pre.querySelector<HTMLButtonElement>(".copy-code-button");
      if (copy) {
        copy.replaceChildren();
        copy.createSpan({ cls: "ss-button__label", text: "Copy" });
        copy.addClass("ss-button", "ss-button--small");
        copy.dataset.ssAction = "small";
        copy.dataset.testid = "chat.code.copy";
        updateUiAction(copy, { icon: "copy" });
      } else {
        copy = createUiAction(pre, {
          label: "Copy", testId: "chat.code.copy", icon: "copy", size: "small", tooltip: false,
        });
      }
      copy.type = "button";
      copy.addClass("copy-code-button", "systemsculpt-agent-code-copy");
      copy.setAttribute("aria-label", "Copy code");
      copy.removeAttribute("aria-live");
      setTooltip(copy, "Copy code");
      const copyButton = copy;
      copy.addEventListener("click", (event) => {
        // Native handlers otherwise copy a second time and race our feedback.
        event.preventDefault();
        event.stopImmediatePropagation();
        const current = pre.querySelector<HTMLElement>(":scope > code");
        void tryCopyToClipboard(current?.textContent ?? "", pre).then((copied) => {
          options.onCopyFeedback(copyButton, copied);
        });
      }, true);
    }

    const previousDiff = pre.querySelector<HTMLElement>(":scope > .systemsculpt-agent-fenced-diff");
    const diff = language.toLowerCase() === "diff" ? fencedDiff(source) : null;
    if (diff) {
      const display = previousDiff ?? pre.createDiv({ cls: "systemsculpt-agent-fenced-diff" });
      new DiffViewer({
        container: display,
        diffResult: diff,
        fileName: "Changes",
        hideHeader: true,
        maxContextLines: Number.POSITIVE_INFINITY,
        maxVisibleLines: Number.POSITIVE_INFINITY,
        showLineNumbers: false,
      }).render();
      // The outer pre is the keyboard scroll surface for a fenced block.
      display.querySelector(".systemsculpt-diff-content")?.removeAttribute("tabindex");
      pre.addClass("is-fenced-diff");
      code.setAttribute("aria-hidden", "true");
    } else {
      previousDiff?.remove();
      pre.removeClass("is-fenced-diff");
      code.removeAttribute("aria-hidden");
    }

    const collapsible = lines > 30;
    pre.classList.toggle("is-code-collapsible", collapsible);
    let showAll = pre.querySelector<HTMLButtonElement>(":scope > .systemsculpt-agent-code-show-all");
    if (collapsible && !showAll) {
      showAll = createUiAction(pre, {
        label: `Show all ${lines} lines`, testId: "chat.code.show-all", size: "small",
      });
      showAll.addClass("systemsculpt-agent-code-show-all");
      const control = showAll;
      showAll.addEventListener("click", () => {
        const finish = options.beginLayoutMutation?.(control, pre);
        try {
          setMarkdownCodeExpanded(pre, !pre.classList.contains("is-code-expanded"));
        } finally {
          finish?.();
        }
      });
    } else if (!collapsible) {
      showAll?.remove();
    }
    setMarkdownCodeExpanded(pre, pre.classList.contains("is-code-expanded"));
    if (showAll && collapsible) {
      const content = pre.querySelector<HTMLElement>(":scope > .systemsculpt-agent-fenced-diff") ?? code;
      if (!content.id) content.id = `ss-code-content-${++codeContentSequence}`;
      showAll.setAttribute("aria-controls", content.id);
      // An incomplete patch may have just become a rendered diff.
      pre.appendChild(showAll);
    }
  }
}
