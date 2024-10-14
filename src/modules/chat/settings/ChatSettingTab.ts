import { App, PluginSettingTab, Setting } from "obsidian";
import { ChatModule } from "../ChatModule";
import { renderChatsPathSetting } from "./ChatsPathSetting";
import { renderSystemPromptSetting } from "./SystemPromptSetting";

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatModule;

  constructor(app: App, plugin: ChatModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName("Chat Settings").setHeading();
    containerEl.createEl("p", {
      text: "Configure your chat settings, including chat history limits, system prompts, and chat storage paths.",
    });

    renderChatsPathSetting(containerEl, this.plugin);
    renderSystemPromptSetting(containerEl, this.plugin);

    new Setting(containerEl)
      .setName("Attachments folder location")
      .setDesc("Path where the chat attachments will be stored")
      .addText((text) => {
        text
          .setPlaceholder("Enter path")
          .setValue(this.plugin.settings.attachmentsPath)
          .onChange(async (value) => {
            this.plugin.settings.attachmentsPath = value;
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default attachments path")
          .onClick(async () => {
            this.plugin.settings.attachmentsPath =
              "SystemSculpt/Chats/Attachments";
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // Add the new Marker API Key setting
    new Setting(containerEl)
      .setName("API endpoint")
      .setDesc("Select the API endpoint to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("datalab", "Datalab")
          .addOption("selfhosted", "Selfhosted")
          .setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.apiEndpoint = value as
              | "datalab"
              | "selfhosted";
            await this.plugin.saveSettings();
            this.display(); // Refresh the settings page
          })
      );

    if (this.plugin.settings.apiEndpoint === "selfhosted") {
      new Setting(containerEl)
        .setName("Marker API endpoint")
        .setDesc("The endpoint to use for the Marker API.")
        .addText((text) =>
          text
            .setPlaceholder("localhost:8000")
            .setValue(this.plugin.settings.markerEndpoint)
            .onChange(async (value) => {
              this.plugin.settings.markerEndpoint = value;
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.apiEndpoint === "datalab") {
      new Setting(containerEl)
        .setName("Marker API Key")
        .setDesc("Enter your Marker API key for PDF text/image extraction")
        .addText((text) => {
          text
            .setPlaceholder("Enter Marker API key")
            .setValue(this.plugin.settings.markerApiKey)
            .onChange(async (value) => {
              this.plugin.settings.markerApiKey = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          text.inputEl.addEventListener("focus", () => {
            text.inputEl.type = "text";
          });
          text.inputEl.addEventListener("blur", () => {
            text.inputEl.type = "password";
          });
        });

      new Setting(containerEl)
        .setName("Languages")
        .setDesc("The languages to use if OCR is needed, separated by commas")
        .addText((text) =>
          text
            .setPlaceholder("en")
            .setValue(this.plugin.settings.langs)
            .onChange(async (value) => {
              this.plugin.settings.langs = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("New folder for each PDF")
      .setDesc("Create a new folder for each PDF that is converted.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createFolder)
          .onChange(async (value) => {
            this.plugin.settings.createFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Create asset subfolder")
      .setDesc("Create an asset subfolder for images")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createAssetSubfolder)
          .onChange(async (value) => {
            this.plugin.settings.createAssetSubfolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show chat button on status bar")
      .setDesc("Toggle the display of chat button on the status bar")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showChatButtonOnStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showChatButtonOnStatusBar = value;
            if (!this.plugin.plugin.chatToggleStatusBarItem) {
              this.plugin.plugin.chatToggleStatusBarItem =
                this.plugin.plugin.addStatusBarItem();
              this.plugin.plugin.chatToggleStatusBarItem.setText("C");
              this.plugin.plugin.chatToggleStatusBarItem.addClass(
                "systemsculpt-status-bar-button"
              );
              this.plugin.plugin.chatToggleStatusBarItem.addClass(
                "systemsculpt-chat-toggle-button"
              );
              this.plugin.plugin.chatToggleStatusBarItem.onClickEvent(() => {
                this.plugin.openNewChat();
              });
            }

            if (value) {
              this.plugin.plugin.chatToggleStatusBarItem.removeClass(
                "systemsculpt-hidden"
              );
            } else {
              this.plugin.plugin.chatToggleStatusBarItem.addClass(
                "systemsculpt-hidden"
              );
            }
            await this.plugin.saveSettings();
          });
      });
  }
}
