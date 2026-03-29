import { App, Component, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import {
  assertPiTextExecutionReady,
  type PiTextExecutionPlan,
} from "../../services/pi-native/PiTextRuntime";
import {
  buildPiTextProviderSetupMessage,
  hasPiTextProviderAuth,
} from "../../services/pi-native/PiTextAuth";
import {
  hasManagedSystemSculptAccess,
  isManagedSystemSculptModelId,
} from "../../services/systemsculpt/ManagedSystemSculptModel";
import { ChatModelPickerModal } from "./ChatModelPickerModal";
import {
  getChatModelDisplayName,
  getChatModelPickerIcon,
  getChatModelSetupMessage,
  getChatModelSetupSurface,
  loadChatModelPickerOptions,
  openChatModelSetupTab,
  promptChatModelSetup,
  type ChatModelPickerOption,
  type ChatModelSetupPromptOverrides,
  type ChatModelSetupSurface,
  type ChatModelSetupTab,
} from "./modelSelection";

type ChatModelSelectionControllerOptions = {
  app: App;
  container: HTMLElement;
  plugin: SystemSculptPlugin;
  getSelectedModelId: () => string;
  getSelectedModelRecord: () => Promise<SystemSculptModel | undefined>;
  isAutomationRequestActive: () => boolean;
  setSelectedModelId: (value: string) => Promise<void>;
  promptProviderSetup?: (
    message?: string,
    overrides?: ChatModelSetupPromptOverrides,
  ) => Promise<boolean>;
};

export class ChatModelSelectionController extends Component {
  private modelPickerHost: HTMLElement | null = null;
  private modelPickerOptionsCache: ChatModelPickerOption[] | null = null;
  private modelPickerOptionsPromise: Promise<ChatModelPickerOption[]> | null = null;

  constructor(private readonly options: ChatModelSelectionControllerOptions) {
    super();
  }

  private resetOptions(): void {
    this.modelPickerOptionsCache = null;
    this.modelPickerOptionsPromise = null;
  }

  public refresh(options?: { reloadOptions?: boolean }): void {
    if (options?.reloadOptions) {
      this.resetOptions();
    }
    this.render();
  }

  private getSelectedModelSetupSurface(): ChatModelSetupSurface {
    return getChatModelSetupSurface(
      this.options.getSelectedModelId(),
      this.options.plugin.settings.selectedModelId,
    );
  }

  private async loadOptions(forceReload: boolean = false): Promise<ChatModelPickerOption[]> {
    if (forceReload) {
      this.resetOptions();
    } else if (this.modelPickerOptionsCache) {
      return this.modelPickerOptionsCache;
    }

    if (!this.modelPickerOptionsPromise) {
      this.modelPickerOptionsPromise = loadChatModelPickerOptions(this.options.plugin)
        .then((nextOptions) => {
          this.modelPickerOptionsCache = nextOptions;
          return nextOptions;
        })
        .finally(() => {
          this.modelPickerOptionsPromise = null;
        });
    }

    return await this.modelPickerOptionsPromise;
  }

  public ensureHost(composer: {
    modelSlot?: HTMLElement | null;
    toolbar?: HTMLElement | null;
  }): void {
    if (composer.modelSlot instanceof HTMLElement) {
      this.modelPickerHost = composer.modelSlot;
      return;
    }

    const parent = composer.toolbar instanceof HTMLElement ? composer.toolbar : this.options.container;
    const modelSlot = document.createElement("div");
    modelSlot.className =
      "systemsculpt-chat-composer-toolbar-center systemsculpt-model-indicator-section inline systemsculpt-chat-composer-chips";
    const rightGroup = parent.querySelector(".systemsculpt-chat-composer-toolbar-group.mod-right");
    if (rightGroup?.parentElement === parent) {
      parent.insertBefore(modelSlot, rightGroup);
    } else {
      parent.appendChild(modelSlot);
    }
    this.modelPickerHost = modelSlot;
  }

  public render(): void {
    if (!this.modelPickerHost) {
      return;
    }
    if (typeof (this.modelPickerHost as any).createDiv !== "function") {
      return;
    }

    this.modelPickerHost.replaceChildren();
    this.modelPickerHost.classList.add("systemsculpt-chat-model-picker");

    const currentModelId = this.options.getSelectedModelId();
    const currentOption =
      this.modelPickerOptionsCache?.find((option) => option.value === currentModelId) || null;
    const triggerButtonEl = this.modelPickerHost.createEl("button", {
      cls: "systemsculpt-chat-model-trigger",
      attr: {
        type: "button",
        "aria-label": "Select chat model",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
      },
    });

    const currentModelReady = currentOption
      ? currentOption.providerAuthenticated
      : isManagedSystemSculptModelId(currentModelId)
        ? hasManagedSystemSculptAccess(this.options.plugin)
        : false;
    const fallbackSection = isManagedSystemSculptModelId(currentModelId) ? "systemsculpt" : "pi";

    triggerButtonEl.classList.toggle("is-provider-authenticated", currentModelReady);
    triggerButtonEl.classList.toggle("is-managed", isManagedSystemSculptModelId(currentModelId));
    triggerButtonEl.classList.toggle("is-setup-required", !currentModelReady);

    const iconEl = triggerButtonEl.createSpan({ cls: "systemsculpt-chat-model-trigger-icon" });
    setIcon(iconEl, currentOption?.icon || getChatModelPickerIcon(fallbackSection));

    const bodyEl = triggerButtonEl.createSpan({ cls: "systemsculpt-chat-model-trigger-body" });
    bodyEl.createSpan({
      cls: "systemsculpt-chat-model-trigger-label",
      text:
        currentOption?.label ||
        getChatModelDisplayName(currentModelId, this.options.plugin.settings.selectedModelId) ||
        "Select model",
    });

    const badgeText =
      currentOption?.providerLabel ||
      (isManagedSystemSculptModelId(currentModelId) ? "SystemSculpt" : "Pi");
    bodyEl.createSpan({
      cls: "systemsculpt-chat-model-trigger-badge",
      text: badgeText,
    });

    const chevronEl = triggerButtonEl.createSpan({ cls: "systemsculpt-chat-model-trigger-chevron" });
    setIcon(chevronEl, "chevrons-up-down");

    const titleParts = [currentOption?.label, badgeText, currentOption?.description].filter(Boolean);
    triggerButtonEl.title = titleParts.join(" • ");

    this.registerDomEvent(triggerButtonEl, "click", () => {
      triggerButtonEl.setAttribute("aria-expanded", "true");
      const modal = new ChatModelPickerModal(this.options.app, {
        currentValue: currentModelId,
        loadOptions: async () => await this.loadOptions(true),
        onSelect: async (value: string) => {
          await this.options.setSelectedModelId(value);
          await this.loadOptions(true).catch(() => []);
          this.render();
        },
        onOpenSetup: (tab: ChatModelSetupTab) => {
          this.openSetupTab(tab);
        },
      });
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = (): void => {
        originalOnClose();
        triggerButtonEl.setAttribute("aria-expanded", "false");
        triggerButtonEl.focus();
      };
      modal.open();
    });

    if (!this.modelPickerOptionsCache && !this.modelPickerOptionsPromise) {
      void this.loadOptions()
        .then(() => {
          if (this.modelPickerHost?.isConnected) {
            this.render();
          }
        })
        .catch(() => {});
    }
  }

  public async ensureProviderReadyForChat(): Promise<boolean> {
    const selectedModelId = this.options.getSelectedModelId();
    const setupSurface = this.getSelectedModelSetupSurface();

    if (isManagedSystemSculptModelId(selectedModelId)) {
      if (hasManagedSystemSculptAccess(this.options.plugin)) {
        return true;
      }

      await this.invokeProviderSetupPrompt(
        "Activate your SystemSculpt license in Account before starting a chat.",
        setupSurface,
      );
      return false;
    }

    const selectedModel = await this.options.getSelectedModelRecord();
    if (!selectedModel) {
      await this.invokeProviderSetupPrompt(
        "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers.",
        setupSurface,
      );
      return false;
    }

    let executionPlan: PiTextExecutionPlan;
    try {
      executionPlan = await assertPiTextExecutionReady(selectedModel);
    } catch (error: any) {
      await this.invokeProviderSetupPrompt(
        error?.message || "Pi is not ready to run the selected model yet.",
        setupSurface,
      );
      return false;
    }

    try {
      const hasAuth = await hasPiTextProviderAuth(
        executionPlan.providerId,
        this.options.plugin,
      );
      if (!hasAuth) {
        await this.invokeProviderSetupPrompt(
          buildPiTextProviderSetupMessage(executionPlan.providerId, executionPlan.actualModelId),
          setupSurface,
        );
        return false;
      }
    } catch (error: any) {
      await this.invokeProviderSetupPrompt(
        error?.message || "Pi provider credentials are not ready yet.",
        setupSurface,
      );
      return false;
    }

    return true;
  }

  public async invokeProviderSetupPrompt(
    message?: string,
    overrides?: ChatModelSetupPromptOverrides,
  ): Promise<void> {
    if (this.options.isAutomationRequestActive()) {
      const targetTab = overrides?.targetTab ?? this.getSelectedModelSetupSurface().targetTab;
      throw new Error(message ?? getChatModelSetupMessage(targetTab));
    }

    const handled = await this.options.promptProviderSetup?.(message, overrides);
    if (handled) {
      return;
    }

    await this.promptProviderSetupFallback(message, overrides);
  }

  private openSetupTab(tabId: ChatModelSetupTab = "account"): void {
    openChatModelSetupTab(
      (targetTab) => {
        this.options.plugin.openSettingsTab(targetTab);
      },
      tabId,
    );
  }

  private async promptProviderSetupFallback(
    message?: string,
    overrides?: ChatModelSetupPromptOverrides,
  ): Promise<void> {
    await promptChatModelSetup({
      app: this.options.app,
      openSettingsTab: (targetTab) => {
        this.options.plugin.openSettingsTab(targetTab);
      },
      selectedModelId: this.options.getSelectedModelId(),
      fallbackModelId: this.options.plugin.settings.selectedModelId,
      message,
      overrides,
    });
  }
}
