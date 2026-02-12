import { PLUGIN_ID } from "./systemsculptChat";

type SettingsTabId =
  | "overview"
  | "models-prompts"
  | "chat-templates"
  | "daily-vault"
  | "embeddings"
  | "audio-transcription"
  | string;

type SettingsQueryParams = {
  tabId?: SettingsTabId;
  timeoutMs?: number;
  settingsKey?: string;
};

function normalizeLabel(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function inferSettingsKeyFromLabel(settingLabel: string): string | null {
  const normalized = normalizeLabel(settingLabel);
  if (normalized === "enable embeddings") return "embeddingsEnabled";
  if (normalized === "embeddings provider") return "embeddingsProvider";
  return null;
}

export async function openSystemSculptSettingsTab(tabId: SettingsTabId = "overview"): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId, tabId }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin || typeof plugin.openSettingsTab !== "function") {
      throw new Error(`Plugin not loaded or openSettingsTab unavailable: ${pluginId}`);
    }
    plugin.openSettingsTab(tabId);
  }, { pluginId: PLUGIN_ID, tabId });

  await browser.waitUntil(
    async () =>
      await browser.execute(
        (activeTabId: string) => {
          const panel = document.querySelector(`.systemsculpt-tab-content.is-active[data-tab=\"${activeTabId}\"]`) as HTMLElement | null;
          return !!panel && panel.offsetParent !== null;
        },
        String(tabId)
      ),
    {
      timeout: 20000,
      interval: 150,
      timeoutMsg: `SystemSculpt settings tab did not become active: ${tabId}`,
    }
  );
}

export async function waitForSystemSculptSetting(
  settingLabel: string,
  params?: SettingsQueryParams
): Promise<void> {
  const tabId = params?.tabId ?? "overview";
  await openSystemSculptSettingsTab(tabId);

  await browser.waitUntil(
    async () =>
      await browser.execute(
        (tab, label) => {
          const normalize = (input: string) => String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
          const normalizedLabel = normalize(label);
          const panel = document.querySelector(`.systemsculpt-tab-content[data-tab=\"${tab}\"]`) as HTMLElement | null;
          if (!panel) return false;

          const rows = Array.from(panel.querySelectorAll(".setting-item")) as HTMLElement[];
          return rows.some((row) => {
            const title = (row.querySelector(".setting-item-name") as HTMLElement | null)?.textContent || "";
            const normalizedTitle = normalize(title);
            return normalizedTitle.includes(normalizedLabel);
          });
        },
        String(tabId),
        settingLabel
      ),
    {
      timeout: params?.timeoutMs ?? 15000,
      interval: 150,
      timeoutMsg: `SystemSculpt setting not found: ${settingLabel}`,
    }
  );
}

export async function setSystemSculptToggleSetting(
  settingLabel: string,
  enabled: boolean,
  params?: SettingsQueryParams
): Promise<void> {
  const tabId = params?.tabId ?? "overview";
  const settingsKey = params?.settingsKey ?? inferSettingsKeyFromLabel(settingLabel);
  await waitForSystemSculptSetting(settingLabel, { tabId, timeoutMs: params?.timeoutMs });

  const result = await browser.execute(
    (tab, label, desired) => {
      const normalize = (input: string) => String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
      const normalizedLabel = normalize(label);
      const panel = document.querySelector(`.systemsculpt-tab-content[data-tab=\"${tab}\"]`) as HTMLElement | null;
      if (!panel) {
        return { ok: false, reason: `Missing settings tab panel: ${tab}` };
      }

      const rows = Array.from(panel.querySelectorAll(".setting-item")) as HTMLElement[];
      const row = rows.find((candidate) => {
        const title = (candidate.querySelector(".setting-item-name") as HTMLElement | null)?.textContent || "";
        return normalize(title).includes(normalizedLabel);
      });
      if (!row) {
        return { ok: false, reason: `Missing setting row: ${label}` };
      }

      const checkboxInput = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      const checkboxContainer = row.querySelector(".checkbox-container") as HTMLElement | null;

      const current = checkboxInput
        ? !!checkboxInput.checked
        : checkboxContainer
          ? checkboxContainer.classList.contains("is-enabled") || checkboxContainer.getAttribute("aria-checked") === "true"
          : null;

      if (current == null) {
        return { ok: false, reason: `Setting is not a toggle: ${label}` };
      }

      if (current !== desired) {
        let nextState = current;
        if (checkboxInput) {
          checkboxInput.click();
          nextState = !!checkboxInput.checked;
          if (nextState !== desired) {
            checkboxInput.checked = desired;
            checkboxInput.dispatchEvent(new Event("input", { bubbles: true }));
            checkboxInput.dispatchEvent(new Event("change", { bubbles: true }));
            nextState = !!checkboxInput.checked;
          }
        } else if (checkboxContainer) {
          checkboxContainer.click();
          nextState =
            checkboxContainer.classList.contains("is-enabled") ||
            checkboxContainer.getAttribute("aria-checked") === "true";
          if (nextState !== desired) {
            const settingControl = row.querySelector(".setting-item-control") as HTMLElement | null;
            settingControl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
        } else {
          return { ok: false, reason: `No clickable toggle target: ${label}` };
        }
      }

      const next = checkboxInput
        ? !!checkboxInput.checked
        : checkboxContainer
          ? checkboxContainer.classList.contains("is-enabled") || checkboxContainer.getAttribute("aria-checked") === "true"
          : null;

      return { ok: next === desired, current: next, desired };
    },
    String(tabId),
    settingLabel,
    enabled
  );

  if (!result?.ok) {
    throw new Error(`Failed to set toggle setting '${settingLabel}': ${result?.reason || "unknown error"}`);
  }

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(
        ({ app }, { tab, label, desired, pluginId, settingsKey }) => {
          const normalize = (input: string) => String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
          let settingsValueMatches = false;
          if (settingsKey) {
            const plugin = (app as any)?.plugins?.getPlugin?.(pluginId);
            if (plugin?.settings && settingsKey in plugin.settings) {
              settingsValueMatches = Boolean(plugin.settings[settingsKey]) === desired;
            }
          }

          let domStateMatches = false;
          const panel = document.querySelector(`.systemsculpt-tab-content[data-tab=\"${tab}\"]`) as HTMLElement | null;
          if (panel) {
            const rows = Array.from(panel.querySelectorAll(".setting-item")) as HTMLElement[];
            const row = rows.find((candidate) => {
              const title = (candidate.querySelector(".setting-item-name") as HTMLElement | null)?.textContent || "";
              return normalize(title).includes(normalize(label));
            });
            if (row) {
              const checkboxInput = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
              if (checkboxInput) {
                domStateMatches = checkboxInput.checked === desired;
              } else {
                const checkboxContainer = row.querySelector(".checkbox-container") as HTMLElement | null;
                if (checkboxContainer) {
                  const checked =
                    checkboxContainer.classList.contains("is-enabled") ||
                    checkboxContainer.getAttribute("aria-checked") === "true";
                  domStateMatches = checked === desired;
                }
              }
            }
          }

          if (settingsKey) {
            return settingsValueMatches || domStateMatches;
          }
          return domStateMatches;
        },
        {
          tab: String(tabId),
          label: settingLabel,
          desired: enabled,
          pluginId: PLUGIN_ID,
          settingsKey,
        }
      ),
    {
      timeout: params?.timeoutMs ?? 10000,
      interval: 120,
      timeoutMsg: `Toggle did not settle for '${settingLabel}'`,
    }
  );
}

export async function setSystemSculptDropdownSetting(
  settingLabel: string,
  optionValueOrLabel: string,
  params?: SettingsQueryParams
): Promise<void> {
  const tabId = params?.tabId ?? "overview";
  const settingsKey = params?.settingsKey ?? inferSettingsKeyFromLabel(settingLabel);
  await waitForSystemSculptSetting(settingLabel, { tabId, timeoutMs: params?.timeoutMs });

  const normalizedTarget = normalizeLabel(optionValueOrLabel);

  const result = await browser.execute(
    (tab, label, target) => {
      const normalize = (input: string) => String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
      const panel = document.querySelector(`.systemsculpt-tab-content[data-tab=\"${tab}\"]`) as HTMLElement | null;
      if (!panel) {
        return { ok: false, reason: `Missing settings tab panel: ${tab}` };
      }

      const rows = Array.from(panel.querySelectorAll(".setting-item")) as HTMLElement[];
      const row = rows.find((candidate) => {
        const title = (candidate.querySelector(".setting-item-name") as HTMLElement | null)?.textContent || "";
        return normalize(title).includes(normalize(label));
      });
      if (!row) {
        return { ok: false, reason: `Missing setting row: ${label}` };
      }

      const select = row.querySelector("select") as HTMLSelectElement | null;
      if (!select) {
        return { ok: false, reason: `Setting is not a dropdown: ${label}` };
      }

      const options = Array.from(select.options);
      const matched =
        options.find((option) => normalize(option.value) === target) ||
        options.find((option) => normalize(option.textContent || "") === target) ||
        options.find((option) => normalize(option.textContent || "").includes(target));

      if (!matched) {
        return {
          ok: false,
          reason: `No option matched '${target}'. Available: ${options.map((o) => `${o.value}|${o.textContent || ""}`).join(", ")}`,
        };
      }

      if (select.value !== matched.value) {
        select.value = matched.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const selected = select.options[select.selectedIndex];
      return {
        ok: true,
        value: select.value,
        label: selected?.textContent || "",
      };
    },
    String(tabId),
    settingLabel,
    normalizedTarget
  );

  if (!result?.ok) {
    throw new Error(`Failed to set dropdown setting '${settingLabel}': ${result?.reason || "unknown error"}`);
  }

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(
        ({ app }, { tab, label, target, pluginId, settingsKey }) => {
          const normalize = (input: string) => String(input || "").toLowerCase().replace(/\s+/g, " ").trim();

          let settingsValueMatches = false;
          if (settingsKey) {
            const plugin = (app as any)?.plugins?.getPlugin?.(pluginId);
            if (plugin?.settings && settingsKey in plugin.settings) {
              settingsValueMatches = normalize(String(plugin.settings[settingsKey] || "")) === target;
            }
          }

          let domStateMatches = false;
          const panel = document.querySelector(`.systemsculpt-tab-content[data-tab=\"${tab}\"]`) as HTMLElement | null;
          if (panel) {
            const rows = Array.from(panel.querySelectorAll(".setting-item")) as HTMLElement[];
            const row = rows.find((candidate) => {
              const title = (candidate.querySelector(".setting-item-name") as HTMLElement | null)?.textContent || "";
              return normalize(title).includes(normalize(label));
            });
            if (row) {
              const select = row.querySelector("select") as HTMLSelectElement | null;
              if (select) {
                const selected = select.options[select.selectedIndex];
                const selectedValue = normalize(select.value);
                const selectedLabel = normalize(selected?.textContent || "");
                domStateMatches = selectedValue === target || selectedLabel === target || selectedLabel.includes(target);
              }
            }
          }

          if (settingsKey) {
            return settingsValueMatches || domStateMatches;
          }
          return domStateMatches;
        },
        {
          tab: String(tabId),
          label: settingLabel,
          target: normalizedTarget,
          pluginId: PLUGIN_ID,
          settingsKey,
        }
      ),
    {
      timeout: params?.timeoutMs ?? 10000,
      interval: 120,
      timeoutMsg: `Dropdown did not settle for '${settingLabel}'`,
    }
  );
}

export async function closeSystemSculptSettingsIfOpen(): Promise<void> {
  await browser.execute(() => {
    const modal = document.querySelector(".modal.mod-settings") as HTMLElement | null;
    if (!modal) return;

    const closeButton = modal.querySelector("button.modal-close-button") as HTMLElement | null;
    if (closeButton) {
      closeButton.click();
      return;
    }

    const escEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escEvent);
  });
}
