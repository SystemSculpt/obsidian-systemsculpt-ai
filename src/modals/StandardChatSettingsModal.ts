import { App, Setting } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import SystemSculptPlugin from "../main";
import { ChatView } from "../views/chatview/ChatView";

export interface ChatSettingsModalOptions {
  plugin: SystemSculptPlugin;
  chatView?: ChatView;
}

export interface ChatSettingsModalResult {
  chatFontSize: "small" | "medium" | "large";
}

export class StandardChatSettingsModal extends StandardModal {
  private readonly options: ChatSettingsModalOptions;
  private resolvePromise: ((value: ChatSettingsModalResult | null) => void) | null = null;
  private currentChatFontSize: "small" | "medium" | "large";

  constructor(app: App, options: ChatSettingsModalOptions) {
    super(app);
    this.options = options;
    this.currentChatFontSize = options.chatView?.chatFontSize || options.plugin.settings.chatFontSize || "medium";
    this.setSize("small");
  }

  onOpen() {
    super.onOpen();
    this.addTitle(
      "Chat settings",
      "SystemSculpt handles chat behavior automatically. Only chat display preferences remain here."
    );

    new Setting(this.contentEl)
      .setName("Chat text size")
      .setDesc("Choose the text size for this chat.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("small", "Small")
          .addOption("medium", "Medium")
          .addOption("large", "Large")
          .setValue(this.currentChatFontSize)
          .onChange(async (value) => {
            const nextSize = value as "small" | "medium" | "large";
            this.currentChatFontSize = nextSize;
            if (this.options.chatView) {
              await this.options.chatView.setChatFontSize(nextSize);
            }
          });
      });

    this.addActionButton("Close", () => {
      this.resolvePromise?.({ chatFontSize: this.currentChatFontSize });
      this.close();
    }, true);
  }

  onClose() {
    if (this.resolvePromise) {
      this.resolvePromise({ chatFontSize: this.currentChatFontSize });
      this.resolvePromise = null;
    }
    super.onClose();
  }

  openModal(): Promise<ChatSettingsModalResult | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

export function showStandardChatSettingsModal(
  app: App,
  options: ChatSettingsModalOptions
): Promise<ChatSettingsModalResult | null> {
  const modal = new StandardChatSettingsModal(app, options);
  return modal.openModal();
}
