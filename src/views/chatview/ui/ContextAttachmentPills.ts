import { setIcon } from "obsidian";

export type ContextAttachmentPillRenderSpec =
  | {
      kind: "file";
      wikiLink: string;
      linkText: string;
      label: string;
      icon: string;
      title?: string;
      removeAriaLabel?: string;
    }
  | {
      kind: "processing";
      processingKey: string;
      linkText: string;
      label: string;
      icon: string;
      title?: string;
      statusIcon?: string;
      spinning?: boolean;
      removeAriaLabel?: string;
    };

export function renderContextAttachmentPill(
  pill: HTMLElement,
  spec: ContextAttachmentPillRenderSpec
): void {
  pill.empty();
  pill.setAttr("role", "button");
  pill.setAttr("tabindex", "0");
  pill.dataset.kind = spec.kind;
  pill.dataset.linkText = spec.linkText;

  if (spec.kind === "file") {
    pill.className = "systemsculpt-attachment-pill";
    pill.dataset.wikiLink = spec.wikiLink;
    delete pill.dataset.processingKey;
  } else {
    pill.className = "systemsculpt-attachment-pill mod-processing";
    pill.dataset.processingKey = spec.processingKey;
    delete pill.dataset.wikiLink;
  }

  if (spec.title) {
    pill.setAttr("title", spec.title);
  } else {
    pill.removeAttribute("title");
  }

  const iconEl = pill.createSpan({ cls: "systemsculpt-attachment-pill-icon" });
  setIcon(iconEl, spec.icon);

  pill.createSpan({ cls: "systemsculpt-attachment-pill-label", text: spec.label });

  if (spec.kind === "processing") {
    const statusEl = pill.createSpan({ cls: "systemsculpt-attachment-pill-status" });
    setIcon(statusEl, spec.statusIcon || "loader-2");
    statusEl.toggleClass("is-spinning", spec.spinning ?? true);
  }

  const removeButton = pill.createEl("button", {
    cls: "clickable-icon systemsculpt-attachment-pill-remove",
    attr: {
      type: "button",
      "aria-label":
        spec.removeAriaLabel ??
        (spec.kind === "processing"
          ? "Dismiss processing status"
          : "Remove file from context"),
    },
  });
  setIcon(removeButton, "x");
}
