import { Notice } from "obsidian";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import type { SystemSculptSettings } from "../types";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";

const TEXT_SETTING_DEBOUNCE_MS = 300;
const activeRenders = new WeakMap<HTMLElement, () => void>();
type RenderOwner = Pick<SystemSculptSettingTab, "registerRenderCleanup">;
type Draft = { value: string; lastSubmittedValue?: string; latestAttempt?: object };
const pendingDrafts = new WeakMap<RenderOwner, Map<keyof SystemSculptSettings, Draft>>();

type BindTextSetting = (
  key: keyof SystemSculptSettings,
  inputEl: HTMLInputElement,
  save: (value: string) => Promise<boolean | void>,
  options?: { commitOn?: "debounce" | "blur"; errorMessage?: string },
) => () => void;

/** Bind independent edits to this render; retain drafts across queued saves and replacement controls. */
export function beginTextSettings(containerEl: HTMLElement, tabInstance: RenderOwner): BindTextSetting {
  activeRenders.get(containerEl)?.();
  let drafts = pendingDrafts.get(tabInstance);
  if (!drafts) {
    drafts = new Map();
    pendingDrafts.set(tabInstance, drafts);
  }
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

  return (key, inputEl, save, options = {}) => {
    const ownerWindow = getSurfaceOwnerWindow(inputEl);
    const draft = drafts.get(key) ?? { value: inputEl.value, lastSubmittedValue: inputEl.value };
    inputEl.value = draft.value;
    let timer: number | null = null;
    let disposed = false;

    const clearTimer = () => {
      if (timer === null) return;
      ownerWindow.clearTimeout(timer);
      timer = null;
    };
    const commit = async (value: string) => {
      const attempt = {};
      draft.latestAttempt = attempt;
      draft.lastSubmittedValue = value;
      drafts.set(key, draft);
      try {
        const saved = await save(value);
        if (draft.latestAttempt !== attempt) return;
        draft.latestAttempt = undefined;
        if (saved === false) {
          draft.lastSubmittedValue = undefined;
        } else if (draft.value === value && drafts.get(key) === draft) {
          drafts.delete(key);
        }
      } catch {
        // An older failure must not invalidate a newer submission, even for the same value.
        if (draft.latestAttempt !== attempt) return;
        draft.latestAttempt = undefined;
        draft.lastSubmittedValue = undefined;
        new Notice(options.errorMessage ?? "Couldn’t save that setting.");
      }
    };
    const flush = () => {
      if (disposed) return;
      clearTimer();
      draft.value = inputEl.value;
      if (draft.value !== draft.lastSubmittedValue) {
        void commit(draft.value);
      } else if (!draft.latestAttempt && drafts.get(key) === draft) {
        drafts.delete(key);
      }
    };
    const onInput = () => {
      draft.value = inputEl.value;
      drafts.set(key, draft);
      if (options.commitOn === "blur") return;
      clearTimer();
      timer = ownerWindow.setTimeout(flush, TEXT_SETTING_DEBOUNCE_MS);
    };

    inputEl.addEventListener("input", onInput);
    inputEl.addEventListener("blur", flush);
    disposers.add(() => {
      flush();
      disposed = true;
      inputEl.removeEventListener("input", onInput);
      inputEl.removeEventListener("blur", flush);
    });

    // Folder selection changes the value without an input event and commits immediately.
    return flush;
  };
}
