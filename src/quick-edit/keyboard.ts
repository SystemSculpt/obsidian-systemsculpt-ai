import type { QuickEditState } from "./controller";

export type QuickEditKeyAction = "none" | "submit" | "confirm";

const isEnterKey = (event: KeyboardEvent): boolean => {
  const key = event.key;
  const code = (event.code || "").toLowerCase();
  const keyCode = (event as any).keyCode;

  return (
    key === "Enter" ||
    key === "Return" ||
    code === "enter" ||
    code === "numpadenter" ||
    keyCode === 13
  );
};

export function getQuickEditKeyAction(event: KeyboardEvent, state: QuickEditState): QuickEditKeyAction {
  if (event.isComposing) return "none";
  if (!isEnterKey(event)) return "none";

  if (state === "awaiting-confirmation") {
    return event.metaKey || event.ctrlKey ? "confirm" : "none";
  }

  if (event.shiftKey) return "none";
  return "submit";
}

