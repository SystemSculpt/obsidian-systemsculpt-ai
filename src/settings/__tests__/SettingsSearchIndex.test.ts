/**
 * @jest-environment jsdom
 */
import { buildSettingsIndexFromRoot, SettingsIndexEntry } from "../SettingsSearchIndex";

describe("SettingsSearchIndex", () => {
  describe("buildSettingsIndexFromRoot", () => {
    const tabsDef = [
      { id: "general", label: "General" },
      { id: "chat", label: "Chat" },
      { id: "advanced", label: "Advanced" },
    ];

    function createTabContent(tabId: string): HTMLElement {
      const section = document.createElement("div");
      section.classList.add("systemsculpt-tab-content");
      section.dataset.tab = tabId;
      return section;
    }

    function createSettingItem(title: string, description: string): HTMLElement {
      const setting = document.createElement("div");
      setting.classList.add("setting-item");

      const nameEl = document.createElement("div");
      nameEl.classList.add("setting-item-name");
      nameEl.textContent = title;
      setting.appendChild(nameEl);

      const descEl = document.createElement("div");
      descEl.classList.add("setting-item-description");
      descEl.textContent = description;
      setting.appendChild(descEl);

      return setting;
    }

    function createSearchableAnchor(title: string, description: string): HTMLElement {
      const anchor = document.createElement("div");
      anchor.dataset.ssSearch = "true";
      anchor.dataset.ssTitle = title;
      anchor.dataset.ssDesc = description;
      anchor.textContent = title;
      return anchor;
    }

    it("returns empty array for empty container", () => {
      const container = document.createElement("div");

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toEqual([]);
    });

    it("indexes setting items with title and description", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");
      tabContent.appendChild(createSettingItem("API Key", "Your API key for authentication"));
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(1);
      expect(result[0].tabId).toBe("general");
      expect(result[0].tabLabel).toBe("General");
      expect(result[0].title).toBe("API Key");
      expect(result[0].description).toBe("Your API key for authentication");
    });

    it("indexes multiple settings from same tab", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("chat");
      tabContent.appendChild(createSettingItem("Model", "Select AI model"));
      tabContent.appendChild(createSettingItem("Temperature", "Response creativity"));
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Model");
      expect(result[1].title).toBe("Temperature");
    });

    it("indexes settings from multiple tabs", () => {
      const container = document.createElement("div");

      const generalTab = createTabContent("general");
      generalTab.appendChild(createSettingItem("Setting 1", "Desc 1"));
      container.appendChild(generalTab);

      const chatTab = createTabContent("chat");
      chatTab.appendChild(createSettingItem("Setting 2", "Desc 2"));
      container.appendChild(chatTab);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(2);
      expect(result[0].tabId).toBe("general");
      expect(result[1].tabId).toBe("chat");
    });

    it("skips settings without title or description", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");

      // Setting with no text
      const emptySetting = document.createElement("div");
      emptySetting.classList.add("setting-item");
      tabContent.appendChild(emptySetting);

      // Setting with only whitespace
      const whitespaceSetting = document.createElement("div");
      whitespaceSetting.classList.add("setting-item");
      const nameEl = document.createElement("div");
      nameEl.classList.add("setting-item-name");
      nameEl.textContent = "   ";
      whitespaceSetting.appendChild(nameEl);
      tabContent.appendChild(whitespaceSetting);

      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toEqual([]);
    });

    it("indexes searchable anchors", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("advanced");
      tabContent.appendChild(createSearchableAnchor("Debug Mode", "Enable debug logging"));
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Debug Mode");
      expect(result[0].description).toBe("Enable debug logging");
    });

    it("falls back to anchor text content for title", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");

      const anchor = document.createElement("div");
      anchor.dataset.ssSearch = "true";
      anchor.textContent = "Fallback Title";
      tabContent.appendChild(anchor);

      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Fallback Title");
    });

    it("uses tab id as label when tab not found", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("unknown-tab");
      tabContent.appendChild(createSettingItem("Setting", "Desc"));
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result[0].tabLabel).toBe("unknown-tab");
    });

    it("handles empty tab id", () => {
      const container = document.createElement("div");
      const tabContent = document.createElement("div");
      tabContent.classList.add("systemsculpt-tab-content");
      // No data-tab attribute
      tabContent.appendChild(createSettingItem("Setting", "Desc"));
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result[0].tabId).toBe("");
    });

    it("includes element reference in entry", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");
      const setting = createSettingItem("Test", "Description");
      tabContent.appendChild(setting);
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result[0].element).toBe(setting);
    });

    it("trims whitespace from title and description", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");

      const setting = document.createElement("div");
      setting.classList.add("setting-item");

      const nameEl = document.createElement("div");
      nameEl.classList.add("setting-item-name");
      nameEl.textContent = "  Title with spaces  ";
      setting.appendChild(nameEl);

      const descEl = document.createElement("div");
      descEl.classList.add("setting-item-description");
      descEl.textContent = "\n\tDescription with whitespace\n\t";
      setting.appendChild(descEl);

      tabContent.appendChild(setting);
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result[0].title).toBe("Title with spaces");
      expect(result[0].description).toBe("Description with whitespace");
    });

    it("indexes both settings and anchors from same tab", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");
      tabContent.appendChild(createSettingItem("Regular Setting", "Setting desc"));
      tabContent.appendChild(createSearchableAnchor("Anchor Item", "Anchor desc"));
      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Regular Setting");
      expect(result[1].title).toBe("Anchor Item");
    });

    it("allows settings with only title", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");

      const setting = document.createElement("div");
      setting.classList.add("setting-item");
      const nameEl = document.createElement("div");
      nameEl.classList.add("setting-item-name");
      nameEl.textContent = "Title Only";
      setting.appendChild(nameEl);
      tabContent.appendChild(setting);

      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Title Only");
      expect(result[0].description).toBe("");
    });

    it("allows settings with only description", () => {
      const container = document.createElement("div");
      const tabContent = createTabContent("general");

      const setting = document.createElement("div");
      setting.classList.add("setting-item");
      const descEl = document.createElement("div");
      descEl.classList.add("setting-item-description");
      descEl.textContent = "Description Only";
      setting.appendChild(descEl);
      tabContent.appendChild(setting);

      container.appendChild(tabContent);

      const result = buildSettingsIndexFromRoot(container, tabsDef);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("");
      expect(result[0].description).toBe("Description Only");
    });
  });
});
