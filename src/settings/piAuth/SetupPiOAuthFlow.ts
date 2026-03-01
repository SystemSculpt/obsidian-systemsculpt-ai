import { App, Modal, Notice } from "obsidian";
import {
  type StudioPiAuthPrompt,
  type StudioPiProviderAuthRecord,
} from "../../studio/piAuth/StudioPiAuthStorage";
import { runStudioPiOAuthLoginFlow } from "../../studio/piAuth/StudioPiOAuthLoginFlow";
import { isOAuthCodePrompt, openExternalUrlForOAuth } from "../../utils/oauthUiHelpers";

type PiAuthPromptModalOptions = {
  title: string;
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  submitLabel?: string;
};

type RunSetupPiOAuthLoginOptions = {
  app: App;
  record: StudioPiProviderAuthRecord;
  providerLabel: string;
};

class PiAuthPromptModal extends Modal {
  private readonly options: PiAuthPromptModalOptions;
  private resolveValue!: (value: string) => void;
  private rejectValue!: (error: Error) => void;
  private settled = false;
  private silentClose = false;
  readonly result: Promise<string>;

  constructor(app: App, options: PiAuthPromptModalOptions) {
    super(app);
    this.options = options;
    this.result = new Promise<string>((resolve, reject) => {
      this.resolveValue = resolve;
      this.rejectValue = reject;
    });
    this.modalEl.addClass("ss-pi-auth-prompt-modal");
  }

  closeSilently(): void {
    this.silentClose = true;
    this.close();
  }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText(this.options.title);

    this.contentEl.createEl("p", {
      cls: "ss-pi-auth-prompt__message",
      text: this.options.message,
    });

    const input = this.contentEl.createEl("textarea", {
      cls: "ss-pi-auth-prompt__input",
      attr: {
        rows: "4",
        placeholder: this.options.placeholder || "",
      },
    });

    const actions = this.contentEl.createDiv({ cls: "ss-pi-auth-prompt__actions" });
    const submitButton = actions.createEl("button", {
      cls: "mod-cta",
      text: this.options.submitLabel || "Continue",
    });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    const submit = () => {
      const value = String(input.value || "");
      const allowEmpty = Boolean(this.options.allowEmpty);
      if (!allowEmpty && !value.trim()) {
        new Notice("Input is required to continue OAuth login.");
        return;
      }
      this.settled = true;
      this.resolveValue(value);
      this.close();
    };

    submitButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => {
      this.close();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });

    setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.settled || this.silentClose) {
      return;
    }
    this.rejectValue(new Error("Authentication cancelled."));
  }
}

function openPiAuthPromptModal(app: App, options: PiAuthPromptModalOptions): PiAuthPromptModal {
  const modal = new PiAuthPromptModal(app, options);
  modal.open();
  return modal;
}

function closePiAuthPromptModal(modal: PiAuthPromptModal | null): void {
  if (!modal) {
    return;
  }
  modal.closeSilently();
}

async function requestPiAuthPromptInput(prompt: StudioPiAuthPrompt): Promise<string> {
  const message = String(prompt?.message || "").trim() || "Enter value:";
  const placeholder = String(prompt?.placeholder || "").trim();
  const allowEmpty = Boolean(prompt?.allowEmpty);
  while (true) {
    const raw = window.prompt(message, placeholder);
    if (raw === null) {
      throw new Error("Authentication cancelled.");
    }
    const value = String(raw);
    if (allowEmpty || value.trim()) {
      return value;
    }
    new Notice("Input is required to continue OAuth login.");
  }
}

export async function runSetupPiOAuthLogin(options: RunSetupPiOAuthLoginOptions): Promise<void> {
  const providerLabel = String(options.providerLabel || "").trim() || options.record.provider;
  let manualCodeModal: PiAuthPromptModal | null = null;

  try {
    const flowResult = await runStudioPiOAuthLoginFlow({
      providerId: options.record.provider,
      onAuth: (info) => {
        const authUrl = String(info.url || "").trim();
        const instructions = String(info.instructions || "").trim();
        if (instructions) {
          new Notice(instructions, 10_000);
        }
        if (!authUrl) {
          return;
        }
        void openExternalUrlForOAuth(authUrl);
      },
      onPrompt: async (prompt) => {
        if (!isOAuthCodePrompt(prompt)) {
          return await requestPiAuthPromptInput(prompt);
        }
        const promptModal = openPiAuthPromptModal(options.app, {
          title: `${providerLabel} OAuth`,
          message: String(prompt.message || "Paste the authorization code."),
          placeholder: String(prompt.placeholder || "Paste the authorization code or redirect URL"),
          allowEmpty: Boolean(prompt.allowEmpty),
          submitLabel: "Submit Code",
        });
        return await promptModal.result;
      },
      onManualCodeInput: async () => {
        closePiAuthPromptModal(manualCodeModal);
        manualCodeModal = openPiAuthPromptModal(options.app, {
          title: `${providerLabel} OAuth`,
          message:
            "Paste the authorization code or full redirect URL. You can leave this open while browser callback completes.",
          placeholder: "https://…",
          allowEmpty: false,
          submitLabel: "Continue OAuth",
        });
        return await manualCodeModal.result;
      },
    });

    if (!flowResult.sawAuthUrl) {
      new Notice("OAuth completed without a browser URL. If needed, retry and paste the auth code manually.");
    }
  } finally {
    closePiAuthPromptModal(manualCodeModal);
  }
}
