import { createStudioAction } from "../StudioAction";

function updateStudioMessage(root: HTMLElement, className: string, text: string | null): void {
  const existing = root.querySelector<HTMLElement>(`:scope > .${className}`);
  if (!text) {
    existing?.remove();
    return;
  }
  const element = existing ?? root.createDiv({ cls: className });
  element.setText(text);
  if (!existing) root.prepend(element);
}

/** The view's one error line; announced when it appears or changes. */
export function updateStudioError(root: HTMLElement, error: string | null): void {
  updateStudioMessage(root, "ss-studio-error", error);
  root.querySelector(":scope > .ss-studio-error")?.setAttribute("role", "alert");
}

export function refreshStudioMessages(root: HTMLElement, error: string | null, warning: string | null, recovery?: { reason: string; retrying: boolean; retry: () => void }): void {
  updateStudioMessage(root, "ss-studio-warning", recovery?.reason ?? warning);
  if (recovery) {
    const notice = root.querySelector<HTMLElement>(":scope > .ss-studio-warning")!;
    notice.setAttribute("role", "status");
    createStudioAction(notice, { label: "Try again", testId: "studio.migration.retry", disabled: recovery.retrying, onSelect: recovery.retry });
  }
  updateStudioError(root, error);
}

export function logStudioConsoleError(label: string, details: Record<string, unknown>): void {
  console.error(label, details);
  const serialized = serializeStudioConsoleDetails(details);
  if (serialized) {
    console.error(`${label} JSON ${serialized}`);
  }
}

function serializeStudioConsoleDetails(details: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      details,
      (_key, value: unknown) => {
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack || null,
          };
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (value && typeof value === "object") {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        return value;
      },
      2
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      message: "Failed to serialize console details.",
      serializationError: message,
    });
  }
}

export function normalizeEscapedNewlines(message: string): string {
  return String(message || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export function summarizeMessageForNotice(message: string): string {
  const firstLine = normalizeEscapedNewlines(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "Unknown error";
  }
  if (firstLine.length <= 220) {
    return firstLine;
  }
  return `${firstLine.slice(0, 217)}...`;
}

