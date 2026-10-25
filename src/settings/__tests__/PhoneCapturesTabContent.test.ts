/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { attachFolderSuggester } from "../../components/FolderSuggester";
import { DEFAULT_SETTINGS } from "../../types";
import { displayPhoneCapturesTabContent } from "../PhoneCapturesTabContent";
import { getSettingsCatalog } from "../SettingsCatalog";
import type { SystemSculptSettingTab } from "../SystemSculptSettingTab";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
jest.mock("../../components/FolderSuggester", () => ({ attachFolderSuggester: jest.fn() }));

function render(linked = true, autoRun = false) {
  const updateSettings = jest.fn(async () => undefined);
  const app = new App();
  const tab = {
    app,
    plugin: {
      settings: { ...DEFAULT_SETTINGS, phoneCapturesLinked: linked, phoneHandoffsAutoRun: autoRun },
      getSettingsManager: () => ({ updateSettings }),
    },
  } as unknown as SystemSculptSettingTab;
  const container = document.createElement("div");
  displayPhoneCapturesTabContent(container, tab);
  return { container, updateSettings };
}

beforeEach(() => jest.clearAllMocks());

it("keeps both folder settings hidden until the iOS app is linked", () => {
  expect(render(false).container.children).toHaveLength(0);
});

it("shows the meeting folder next to the inbox and saves it independently", async () => {
  const { container, updateSettings } = render();
  const rows = [...container.querySelectorAll(".setting-item")];
  const names = rows.map(row => row.querySelector(".setting-item-name")?.textContent);
  const index = names.indexOf("iOS captures folder");
  expect(names[index + 1]).toBe("iOS meetings folder");
  const input = rows[index + 1].querySelector("input")!;
  expect(input.value).toBe("SystemSculpt/Meetings");
  input.value = "Work/Meetings";
  input.dispatchEvent(new Event("change"));
  await Promise.resolve();
  expect(updateSettings).toHaveBeenLastCalledWith({ phoneCapturesMeetingsFolder: "Work/Meetings" });
  const select = jest.mocked(attachFolderSuggester).mock.calls[1][1];
  select("Team/Meetings");
  await Promise.resolve();
  expect(input.value).toBe("Team/Meetings");
  expect(updateSettings).toHaveBeenLastCalledWith({ phoneCapturesMeetingsFolder: "Team/Meetings" });
});

it.each([false, true])("renders the handoff opt-in at its saved value (%s) and changes only that preference", async autoRun => {
  const { container, updateSettings } = render(true, autoRun);
  const row = container.querySelector('[data-ss-setting="workspace.run-phone-handoffs"]')!;
  expect(row.querySelector(".setting-item-name")?.textContent).toBe("Run iPhone handoffs without asking");
  expect(row.querySelector(".setting-item-description")?.textContent).toBe("Skips only the Run button for iPhone handoffs. Agent permissions and approval requests are unchanged.");
  const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(toggle.checked).toBe(autoRun);
  expect(updateSettings).not.toHaveBeenCalled();
  toggle.checked = !autoRun;
  toggle.dispatchEvent(new Event("change"));
  await Promise.resolve();
  expect(updateSettings.mock.calls).toEqual([[{ phoneHandoffsAutoRun: !autoRun }]]);
});

it("keeps handoff settings searchable only for a linked iPhone account", () => {
  const id = "workspace.run-phone-handoffs";
  expect(getSettingsCatalog({ ...DEFAULT_SETTINGS, phoneCapturesLinked: false }).some(row => row.id === id)).toBe(false);
  expect(getSettingsCatalog({ ...DEFAULT_SETTINGS, phoneCapturesLinked: true }).find(row => row.id === id)).toMatchObject({
    title: "Run iPhone handoffs without asking", tabId: "workspace",
  });
});

it.each(["../outside", "/absolute", "\\absolute"])("does not persist an invalid meetings folder: %s", async value => {
  const { container, updateSettings } = render();
  const input = container.querySelector<HTMLInputElement>('input[placeholder="SystemSculpt/Meetings"]')!;
  input.value = value;
  input.dispatchEvent(new Event("change"));
  await Promise.resolve();
  expect(updateSettings).not.toHaveBeenCalled();
  expect(Notice).toHaveBeenCalledWith("Use a vault-relative path without '..' or a leading slash.");
});
