
export interface SettingsIndexEntry {
  tabId: string;
  tabLabel: string;
  title: string;
  description: string;
  element: HTMLElement;
}

export function buildSettingsIndexFromRoot(
  contentRootEl: HTMLElement,
  tabsDef: { id: string; label: string }[]
): SettingsIndexEntry[] {
  const all: SettingsIndexEntry[] = [];
  const sections = Array.from(
    contentRootEl.querySelectorAll<HTMLElement>(".systemsculpt-tab-content")
  );
  sections.forEach((section) => {
    const tabId = section.dataset.tab || "";
    const tabLabel = tabsDef.find((t) => t.id === tabId)?.label || tabId;

    const settings = Array.from(section.querySelectorAll<HTMLElement>(".setting-item"));
    for (const setting of settings) {
      const title = (setting.querySelector(".setting-item-name")?.textContent || "").trim();
      const description = (
        setting.querySelector(".setting-item-description")?.textContent || ""
      ).trim();
      if (!title && !description) continue;
      all.push({ tabId, tabLabel, title, description, element: setting });
    }

    const anchors = Array.from(section.querySelectorAll<HTMLElement>("[data-ss-search='true']"));
    for (const anchor of anchors) {
      const title = (anchor.getAttribute("data-ss-title") || anchor.textContent || "").trim();
      const description = (anchor.getAttribute("data-ss-desc") || "").trim();
      if (!title && !description) continue;
      all.push({ tabId, tabLabel, title, description, element: anchor });
    }
  });
  return all;
}
