export type StudioNotePathStateTone = "missing" | "invalid" | "ready";

export function resolveStudioNotePathState(path: string): {
  tone: StudioNotePathStateTone;
  message: string;
} {
  const trimmed = String(path || "").trim();
  if (!trimmed) {
    return {
      tone: "missing",
      message: "Select a markdown file to continue.",
    };
  }
  if (!trimmed.toLowerCase().endsWith(".md")) {
    return {
      tone: "invalid",
      message: "Use a .md file path.",
    };
  }
  return {
    tone: "ready",
    message: "",
  };
}

export function appendStudioPathBrowseButtonIcon(
  buttonEl: HTMLElement,
  iconClassName: string
): void {
  const iconEl = buttonEl.createSpan({ cls: iconClassName });
  iconEl.setAttr("aria-hidden", "true");
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const folderPath = document.createElementNS(namespace, "path");
  folderPath.setAttribute(
    "d",
    "M1.75 4.75a1 1 0 0 1 1-1h3l1.1 1.2h6.4a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"
  );
  const linePath = document.createElementNS(namespace, "path");
  linePath.setAttribute("d", "M6.25 8.4h4.1m-2.05-2.05V10.5");
  svg.append(folderPath, linePath);
  iconEl.appendChild(svg);
}
