import { Notice } from "obsidian";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";

const TEXT_SETTING_DEBOUNCE_MS = 300;
const activeRenders = new WeakMap<HTMLElement, () => void>();

type BindTextSetting = (
  inputEl: HTMLInputElement,
  save: (value: string) => Promise<void>,
  options?: { commitOn?: "debounce" | "blur"; errorMessage?: string },
) => () => void;

/** Bind independent text edits to this render; cleanup flushes instead of discarding drafts. */
export function beginTextSettings(
  containerEl: HTMLElement,
  tabInstance: Pick<SystemSculptSettingTab, "registerRenderCleanup">,
): BindTextSetting {
  activeRenders.get(containerEl)?.();
  const disposers = new Set<() => void>();
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    disposers.forEach((dispose) => dispose());
    disposers.clear();
    if (activeRenders.get(containerEl) === cleanup) activeRenders.delete(containerEl);
    unregister();
  };
  const unregister = tabInstance.registerRenderCleanup(cleanup);
  activeRenders.set(containerEl, cleanup);

  return (inputEl, save, options = {}) => {
    const ownerWindow = getSurfaceOwnerWindow(inputEl);
    let timer: number | null = null;
    let lastSubmittedValue: string | undefined = inputEl.value;
    let latestAttempt: object | undefined;
    let disposed = false;

    const clearTimer = () => {
      if (timer === null) return;
      ownerWindow.clearTimeout(timer);
      timer = null;
    };
    const commit = async (value: string) => {
      const attempt = {};
      latestAttempt = attempt;
      lastSubmittedValue = value;
      try {
        await save(value);
      } catch {
        // An older failure must not invalidate a newer submission, even for the same value.
        if (latestAttempt !== attempt) return;
        lastSubmittedValue = undefined;
        new Notice(options.errorMessage ?? "Couldn’t save that setting.");
      }
    };
    const flush = () => {
      if (disposed) return;
      clearTimer();
      if (inputEl.value !== lastSubmittedValue) void commit(inputEl.value);
    };
    const schedule = () => {
      clearTimer();
      timer = ownerWindow.setTimeout(flush, TEXT_SETTING_DEBOUNCE_MS);
    };

    if (options.commitOn !== "blur") inputEl.addEventListener("input", schedule);
    inputEl.addEventListener("blur", flush);
    disposers.add(() => {
      flush();
      disposed = true;
      inputEl.removeEventListener("input", schedule);
      inputEl.removeEventListener("blur", flush);
    });

    // Folder selection changes the value without an input event and commits immediately.
    return flush;
  };
}
