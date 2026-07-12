import { App, Component, setIcon } from "obsidian";
import {
  STANDARD_CHAT_IDENTITY,
  getChatModelSetupMessage,
  promptChatModelSetup,
} from "./modelSelection";

type ChatModelSelectionControllerOptions = {
  app: App;
  container: HTMLElement;
  isAutomationRequestActive: () => boolean;
  openAccount: () => void;
  promptAccountSetup?: (message: string) => Promise<boolean> | boolean;
};

export class ChatModelSelectionController extends Component {
  private modelPickerHost: HTMLElement | null = null;

  constructor(private readonly options: ChatModelSelectionControllerOptions) {
    super();
  }

  public refresh(): void {
    this.render();
  }

  public ensureHost(composer: {
    modelSlot?: HTMLElement | null;
    toolbar?: HTMLElement | null;
  }): void {
    if (composer.modelSlot instanceof HTMLElement) {
      this.modelPickerHost = composer.modelSlot;
      return;
    }

    const parent =
      composer.toolbar instanceof HTMLElement ? composer.toolbar : this.options.container;
    const modelSlot = document.createElement("div");
    modelSlot.className =
      "systemsculpt-chat-composer-toolbar-center systemsculpt-model-indicator-section inline systemsculpt-chat-composer-chips";
    const rightGroup = parent.querySelector(
      ".systemsculpt-chat-composer-toolbar-group.mod-right",
    );
    if (rightGroup?.parentElement === parent) {
      parent.insertBefore(modelSlot, rightGroup);
    } else {
      parent.appendChild(modelSlot);
    }
    this.modelPickerHost = modelSlot;
  }

  public render(): void {
    if (!this.modelPickerHost || typeof this.modelPickerHost.createDiv !== "function") {
      return;
    }

    this.modelPickerHost.replaceChildren();
    this.modelPickerHost.classList.add("systemsculpt-chat-identity-slot");

    const identityEl = this.modelPickerHost.createDiv({
      cls: "systemsculpt-chat-identity",
      attr: {
        role: "status",
        "aria-label": `${STANDARD_CHAT_IDENTITY.providerLabel} ${STANDARD_CHAT_IDENTITY.modelLabel}`,
      },
    });
    const iconEl = identityEl.createSpan({
      cls: "systemsculpt-chat-identity-icon",
    });
    setIcon(iconEl, "sparkles");
    const bodyEl = identityEl.createSpan({
      cls: "systemsculpt-chat-identity-body",
    });
    bodyEl.createSpan({
      cls: "systemsculpt-chat-identity-label",
      text: STANDARD_CHAT_IDENTITY.providerLabel,
    });
    bodyEl.createSpan({
      cls: "systemsculpt-chat-identity-model",
      text: STANDARD_CHAT_IDENTITY.modelLabel,
    });
    identityEl.title = `${STANDARD_CHAT_IDENTITY.providerLabel} • ${STANDARD_CHAT_IDENTITY.modelLabel}`;
  }

  public async invokeAccountSetupPrompt(message?: string): Promise<void> {
    const setupMessage = message ?? getChatModelSetupMessage();
    if (this.options.isAutomationRequestActive()) {
      throw new Error(setupMessage);
    }
    const handled = await this.options.promptAccountSetup?.(setupMessage);
    if (handled) {
      return;
    }
    await promptChatModelSetup({
      app: this.options.app,
      openAccount: this.options.openAccount,
      message: setupMessage,
    });
  }
}
