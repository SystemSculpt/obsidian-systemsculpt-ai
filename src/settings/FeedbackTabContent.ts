import { createCatalogSetting } from "./SettingsCatalog";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { sendPluginFeedback } from "../services/PluginFeedback";

/** One opt-in form shared by settings and the chat menu; no modal or notices. */
export function displayFeedbackTabContent(root: HTMLElement, tab: SystemSculptSettingTab): void {
  root.addClass("ss-feedback-form");
  root.createEl("h3", { text: "Send feedback" });
  let message!: HTMLTextAreaElement;
  const field = createCatalogSetting(root, "feedback.message")
    .addTextArea((text) => {
      message = text.inputEl;
      text.setPlaceholder("What is working, or getting in your way?");
      message.rows = 6;
      message.addClass("ss-settings-textarea");
      message.setAttribute("aria-label", "What should we improve?");
    });
  const status = root.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
  field.addButton((button) => {
    let sending = false;
    const refresh = (): void => { button.setDisabled(sending || !message.value.trim()); };
    button.setButtonText("Send feedback").setClass("ss-button");
    message.addEventListener("input", () => { status.setText(""); refresh(); });
    refresh();
    button.onClick(async () => {
      if (sending || !message.value.trim()) return;
      sending = true;
      message.readOnly = true;
      button.setButtonText("Sending…");
      status.setText("");
      refresh();
      try {
        await sendPluginFeedback(message.value, tab.plugin.manifest.version, tab.plugin.settings.licenseKey);
        message.value = "";
        status.setText("Feedback queued for support. Thank you.");
      } catch {
        status.setText("Couldn't send. Your draft is kept here.");
      } finally {
        sending = false;
        message.readOnly = false;
        button.setButtonText("Send feedback");
        refresh();
      }
    });
  });
}
