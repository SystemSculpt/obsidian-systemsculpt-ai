import type { UrlCitation } from "../../../types";

const getCitationTitle = (citation: UrlCitation): string => {
  if (citation.title?.trim()) {
    return citation.title;
  }

  try {
    return new URL(citation.url).hostname;
  } catch {
    return citation.url;
  }
};

export function renderCitationFooter(
  contentEl: HTMLElement,
  citations: readonly UrlCitation[]
): void {
  if (citations.length === 0) {
    return;
  }

  const citationsContainer = contentEl.createEl("div", {
    cls: "systemsculpt-citations-container",
  });

  citationsContainer.createEl("hr", { cls: "systemsculpt-citations-divider" });

  citationsContainer.createEl("div", {
    cls: "systemsculpt-citations-header",
    text: "Sources",
  });

  const citationsList = citationsContainer.createEl("ol", {
    cls: "systemsculpt-citations-list",
  });

  citations.forEach((citation) => {
    const li = citationsList.createEl("li", { cls: "systemsculpt-citation-item" });

    li.createEl("a", {
      cls: "systemsculpt-citation-title",
      text: getCitationTitle(citation),
      attr: {
        href: citation.url,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });

    li.createEl("div", {
      cls: "systemsculpt-citation-url",
      text: citation.url,
    });

    if (citation.content?.trim()) {
      li.createEl("div", {
        cls: "systemsculpt-citation-snippet",
        text: citation.content,
      });
    }
  });
}
