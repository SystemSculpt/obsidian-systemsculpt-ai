/** @jest-environment jsdom */
import { displayFeedbackTabContent } from "../FeedbackTabContent";
import type { SystemSculptSettingTab } from "../SystemSculptSettingTab";
import { sendPluginFeedback } from "../../services/PluginFeedback";
import { buildSettingsTabConfigs } from "../SettingsTabRegistry";
import { getSettingsCatalog } from "../SettingsCatalog";
import { DEFAULT_SETTINGS } from "../../types";

jest.mock("../../services/PluginFeedback", () => ({ sendPluginFeedback: jest.fn() }));
const send = jest.mocked(sendPluginFeedback);

function render(licenseKey = "") {
  const root = document.body.createDiv();
  const tab = { plugin: { settings: { licenseKey }, manifest: { version: "6.18.17" } } } as SystemSculptSettingTab;
  displayFeedbackTabContent(root, tab);
  const textarea = root.querySelector("textarea")!;
  const button = root.querySelector("button")!;
  const status = root.querySelector('[role="status"]')!;
  const type = (value: string) => { textarea.value = value; textarea.dispatchEvent(new Event("input")); };
  return { root, tab, textarea, button, status, type };
}

beforeEach(() => { document.body.empty(); jest.clearAllMocks(); });

it("is passive, with one free-text box, no required sign-in and no sends on render or typing", () => {
  const { root, tab, textarea, button, type } = render();
  expect(root.querySelectorAll("textarea,input")).toHaveLength(1);
  expect(textarea.getAttribute("aria-label")).toBe("What should we improve?");
  expect(root.textContent).toContain("No notes or chats attached.");
  expect(button.disabled).toBe(true);
  type("   ");
  expect(button.disabled).toBe(true);
  type("Audio is confusing");
  expect(button.disabled).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(buildSettingsTabConfigs(tab).find(item => item.id === "feedback")?.label).toBe("Send feedback");
  expect(getSettingsCatalog(DEFAULT_SETTINGS).find(item => item.id === "feedback.message")?.tabId).toBe("feedback");
});

it.each(["", "signed-in-license"])("queues only on submit and prevents duplicate clicks (%s)", async license => {
  let finish!: () => void;
  send.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const { textarea, button, status, type } = render(license);
  type("Please improve audio");
  button.click();
  button.click();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("Please improve audio", "6.18.17", license);
  expect(button.disabled).toBe(true);
  expect(textarea.readOnly).toBe(true);
  expect(status.textContent).toBe("");
  finish();
  await Promise.resolve();
  expect(status.textContent).toContain("queued for support");
  expect(textarea.value).toBe("");
  expect(textarea.readOnly).toBe(false);
  expect(button.disabled).toBe(true);
});

it("keeps a failed draft available for an explicit retry, without a popup", async () => {
  send.mockRejectedValueOnce(new Error("Offline"));
  const { textarea, button, status, type } = render();
  type("Keep this feedback");
  button.click();
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  expect(textarea.value).toBe("Keep this feedback");
  expect(button.disabled).toBe(false);
  expect(status.textContent).toContain("Your draft is kept here");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
