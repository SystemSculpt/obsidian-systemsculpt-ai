/** @jest-environment jsdom */
import { App } from "obsidian";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { DEFAULT_SETTINGS } from "../types";
import { SystemSculptService } from "../services/SystemSculptService";
import { getSettingsCatalog } from "../settings/SettingsCatalog";

jest.mock("../services/SystemSculptService", () => ({
  SystemSculptService: { getInstance: jest.fn() },
}));
jest.mock("../components/FolderSuggester", () => ({ attachFolderSuggester: jest.fn() }));

const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("lazy settings with the production registry", () => {
  let tab: SystemSculptSettingTab;
  let plugin: any;
  let readCredits: jest.Mock;
  let enumerateDevices: jest.Mock;
  let getFiles: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    const app = new App();
    getFiles = jest.spyOn(app.vault, "getFiles");
    readCredits = jest.fn().mockResolvedValue({ totalRemaining: 100, cycleEndsAt: "2026-11-01" });
    (SystemSculptService.getInstance as jest.Mock).mockReturnValue({ readCreditsBalance: readCredits });
    enumerateDevices = jest.fn().mockResolvedValue([]);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { enumerateDevices } });
    plugin = {
      app,
      manifest: { version: "6.15.0" },
      settings: { ...DEFAULT_SETTINGS, licenseValid: true, licenseKey: "test-license" },
      getSettingsManager: () => ({ updateSettings: async (patch: object) => { Object.assign(plugin.settings, patch); return true; } }),
      getAccountConnectService: () => ({ hasPendingRequest: () => false, pollInBackground: jest.fn() }),
      consumePendingSettingsFocusTab: () => "chat",
      clearPendingSettingsFocusTab: jest.fn(),
      getOrCreateEmbeddingsManager: jest.fn(),
    };
    tab = new SystemSculptSettingTab(app, plugin);
    document.body.append(tab.containerEl);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: jest.fn() });
  });

  afterEach(() => { tab.hide(); tab.containerEl.remove(); jest.restoreAllMocks(); });

  const panel = (id: string) => tab.containerEl.querySelector<HTMLElement>(`.systemsculpt-tab-content[data-tab="${id}"]`)!;
  const open = async (id: string) => { tab.containerEl.querySelector<HTMLButtonElement>(`button[data-tab="${id}"]`)!.click(); await flush(); };
  const search = (query: string) => {
    const input = tab.containerEl.querySelector<HTMLInputElement>("input[type=search]")!;
    input.value = query;
    input.dispatchEvent(new Event("input"));
    return input;
  };

  it("renders only the shown tab and does no vault walk, credits read, or microphone enumeration", async () => {
    tab.display();
    await flush();
    expect(panel("chat").querySelectorAll(".setting-item")).toHaveLength(3);
    for (const id of ["account", "workflow", "knowledge", "workspace", "studio", "advanced"]) expect(panel(id).children).toHaveLength(0);
    expect(getFiles).not.toHaveBeenCalled();
    expect(readCredits).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    const tag = panel("chat").querySelector("input");
    await open("studio");
    await open("chat");
    expect(panel("chat").querySelector("input")).toBe(tag);
  });

  it("keeps the default Account tab visible without enumerating microphones or walking the vault", async () => {
    plugin.consumePendingSettingsFocusTab = () => null;
    tab.display();
    await flush();
    expect(panel("account").hidden).toBe(false);
    expect(readCredits).toHaveBeenCalledTimes(1);
    expect(getFiles).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it("reads credits only on Account and enumerates microphones only on Workflow", async () => {
    tab.display();
    await open("workspace");
    await open("knowledge");
    await open("advanced");
    expect(readCredits).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
    await open("account");
    expect(readCredits).toHaveBeenCalledTimes(1);
    await open("workflow");
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    await open("chat");
    await open("account");
    await open("workflow");
    expect(readCredits).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it("finds and opens a setting on an unrendered tab without loading other tabs", async () => {
    tab.display();
    const input = search("microphone");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Microphone");
    expect(panel("workflow").children).toHaveLength(0);
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(readCredits).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(panel("workflow").hidden).toBe(false);
    expect(panel("workflow").querySelector('[data-ss-setting="workflow.microphone"]')).not.toBeNull();
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(readCredits).not.toHaveBeenCalled();
  });

  it("changes only the exclusions section when an exclusion toggle changes", async () => {
    tab.display();
    await open("knowledge");
    const shell = tab.containerEl.querySelector(".ss-settings-surface");
    const core = panel("knowledge").querySelector('[data-ss-setting="knowledge.similar-notes"]');
    const before = panel("knowledge").querySelector('[data-ss-setting="knowledge.excluded-folders"]');
    panel("knowledge").querySelector<HTMLElement>('[data-ss-setting="knowledge.exclude-chat-history"] input[type=checkbox]')!.click();
    await flush();
    expect(plugin.settings.embeddingsExclusions.ignoreChatHistory).toBe(false);
    expect(tab.containerEl.querySelector(".ss-settings-surface")).toBe(shell);
    expect(panel("knowledge").querySelector('[data-ss-setting="knowledge.similar-notes"]')).toBe(core);
    expect(panel("knowledge").querySelector('[data-ss-setting="knowledge.excluded-folders"]')).not.toBe(before);
    expect(readCredits).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
  });

  it("keeps search working for invalidated hidden sections after a restore", async () => {
    tab.display();
    await open("workflow");
    await open("advanced");
    tab.refreshSettings();
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    const input = search("microphone");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Microphone");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(panel("workflow").querySelector('[data-ss-setting="workflow.microphone"]')).not.toBeNull();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(readCredits).not.toHaveBeenCalled();
  });

  it("defers a hidden Account refresh and preserves other tabs' unsaved text", async () => {
    tab.display();
    const input = panel("chat").querySelector<HTMLInputElement>("input")!;
    input.value = "draft tag";
    input.dispatchEvent(new Event("input"));
    await open("account");
    await open("chat");
    tab.refreshAccountSection();
    expect(readCredits).toHaveBeenCalledTimes(1);
    expect(panel("chat").querySelector("input")).toBe(input);
    expect(input.value).toBe("draft tag");
    await open("account");
    expect(readCredits).toHaveBeenCalledTimes(2);
  });

  it("finds saved exclusion rows without rendering Knowledge first", async () => {
    plugin.settings.embeddingsExclusions = { ...DEFAULT_SETTINGS.embeddingsExclusions, folders: ["Private journal"] };
    tab.display();
    const input = search("Private journal");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Private journal");
    expect(panel("knowledge").children).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(panel("knowledge").querySelector('[data-ss-setting="knowledge.folders.0"]')?.textContent).toContain("Private journal");
  });

  it("updates search after enabling a conditional section without rebuilding the tab", async () => {
    tab.display();
    await open("knowledge");
    const exclusions = panel("knowledge").querySelector('[data-ss-setting="knowledge.excluded-folders"]');
    const toggle = panel("knowledge").querySelector<HTMLInputElement>('[data-ss-setting="knowledge.similar-notes"] input')!;
    toggle.click();
    await flush();
    expect(panel("knowledge").querySelector('[data-ss-setting="knowledge.excluded-folders"]')).toBe(exclusions);
    search("Rebuild index");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Rebuild index");
    search("");
    toggle.click();
    await flush();
    search("Rebuild index");
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
  });

  it.each(["deactivate", "service refresh"])("invalidates linked capture controls after %s without replacing directory drafts", async (action) => {
    plugin.settings.phoneCapturesLinked = true;
    plugin.getAccountConnectService = () => ({ hasPendingRequest: () => false, cancelPending: jest.fn(), pollInBackground: jest.fn() });
    plugin.getSettingsManager = () => ({ updateSettings: async (patch: object) => {
      Object.assign(plugin.settings, patch, { phoneCapturesLinked: false });
      return true;
    } });
    tab.display();
    await open("workspace");
    const directory = panel("workspace").querySelector<HTMLInputElement>("input")!;
    directory.value = "Uncommitted directory";
    await open("account");
    if (action === "deactivate") {
      Array.from(panel("account").querySelectorAll("button")).find((button) => button.textContent === "Deactivate")!.click();
      await flush();
    } else {
      plugin.settings.phoneCapturesLinked = false;
      tab.refreshAccountSection();
    }
    search("iOS captures");
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
    search("");
    await open("workspace");
    expect(panel("workspace").textContent).not.toContain("Save iOS captures");
    expect(panel("workspace").querySelector("input")).toBe(directory);
    expect(directory.value).toBe("Uncommitted directory");
  });

  it.each([
    ["knowledge", "knowledge.similar-notes", "Rebuild index"],
    ["workflow", "workflow.cleanup", "Cleanup instructions"],
  ])("updates an ongoing search after a delayed %s toggle", async (tabId, settingId, title) => {
    const save = deferred<void>();
    plugin.getSettingsManager = () => ({ updateSettings: async (patch: object) => {
      await save.promise;
      Object.assign(plugin.settings, patch);
      return true;
    } });
    tab.display();
    await open(tabId);
    panel(tabId).querySelector<HTMLInputElement>(`[data-ss-setting="${settingId}"] input`)!.click();
    search(title.slice(0, -1));
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
    save.resolve();
    await flush();
    search(title);
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain(title);
  });

  it("updates unopened Account metadata after a service refresh without reading credits", () => {
    plugin.settings.licenseValid = false;
    plugin.settings.licenseKey = "";
    tab.display();
    search("credits balanc");
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "test-license";
    tab.refreshAccountSection();
    search("credits balance");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Credits");
    expect(panel("account").children).toHaveLength(0);
    expect(readCredits).not.toHaveBeenCalled();
  });

  it("updates an ongoing search after the credits title changes", async () => {
    const balance = deferred<object>();
    readCredits.mockReturnValue(balance.promise);
    tab.display();
    await open("account");
    search("Usage mod");
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
    balance.resolve({ usageClass: "master_auth" });
    await flush();
    search("Usage mode");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Usage mode");
  });

  it("updates an ongoing search after microphone enumeration completes", async () => {
    const devices = deferred<MediaDeviceInfo[]>();
    enumerateDevices.mockReturnValue(devices.promise);
    tab.display();
    await open("workflow");
    search("reveal named microphone");
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
    devices.resolve([]);
    await flush();
    expect(panel("workflow").querySelector('[data-ss-setting="workflow.microphone"]')?.textContent).toContain("reveal named microphones");
    search("reveal named microphones");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Microphone");
  });

  it("updates an ongoing search after directory verification completes", async () => {
    const health = deferred<object>();
    plugin.checkDirectoryHealth = () => health.promise;
    tab.display();
    await open("workspace");
    Array.from(panel("workspace").querySelectorAll("button")).find((button) => button.textContent === "Verify")!.click();
    search("All directories are read");
    expect(tab.containerEl.querySelector(".ss-search-result")).toBeNull();
    health.resolve({ valid: true });
    await flush();
    search("All directories are ready");
    expect(tab.containerEl.querySelector(".ss-search-result")?.textContent).toContain("Directory health");
  });

  it("constructs feedback diagnostics only on link activation", async () => {
    tab.display();
    await open("advanced");
    const link = panel("advanced").querySelector<HTMLAnchorElement>(".ss-settings-link")!;
    expect(getFiles).not.toHaveBeenCalled();
    link.addEventListener("click", (event) => event.preventDefault());
    link.click();
    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(new URL(link.href).searchParams.get("body")).toContain("Vault size:");
  });

  it("renders every searchable catalog target with its shared title", async () => {
    Object.assign(plugin.settings, { postProcessingEnabled: true, embeddingsEnabled: true, phoneCapturesLinked: true });
    tab.display();
    for (const id of ["account", "workflow", "knowledge", "workspace", "studio", "advanced"]) await open(id);
    for (const entry of getSettingsCatalog(plugin.settings)) {
      const target = panel(entry.tabId).querySelector(`[data-ss-setting="${entry.id}"]`);
      expect({ id: entry.id, title: target?.querySelector(".setting-item-name")?.textContent }).toEqual({ id: entry.id, title: entry.title });
    }
  });
});
