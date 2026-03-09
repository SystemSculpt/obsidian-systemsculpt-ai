import { ButtonComponent } from "obsidian";

export interface ChatComposerDeps {
  onEditSystemPrompt: () => void;
  onAddContextFile: () => void;
  onSend: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  registerDomEvent: <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K | string,
    callback: (evt: any) => any
  ) => void;
  onKeyDown: (e: KeyboardEvent) => void | Promise<void>;
  onInput: () => void;
  onPaste: (e: ClipboardEvent) => void | Promise<void>;
  handleMicClick: () => void;
  hasProLicense: () => boolean;
}

export interface ChatComposerElements {
  root: HTMLDivElement;
  toolbar: HTMLDivElement;
  attachments: HTMLDivElement;
  chips: HTMLDivElement;
  inputWrap: HTMLDivElement;
  input: HTMLTextAreaElement;
  settingsButton: ButtonComponent;
  attachButton: ButtonComponent;
  sendButton: ButtonComponent;
  stopButton: ButtonComponent;
  micButton: ButtonComponent;
}

export function createChatComposer(parent: HTMLElement, deps: ChatComposerDeps): ChatComposerElements {
  const root = parent.createDiv({ cls: "systemsculpt-chat-composer" });

  const toolbar = root.createDiv({ cls: "systemsculpt-chat-composer-toolbar" });
  const leftGroup = toolbar.createDiv({ cls: "systemsculpt-chat-composer-toolbar-group mod-left" });

  // Chips container (model + system prompt). uiSetup will populate these.
  const chips = toolbar.createDiv({
    cls: "systemsculpt-model-indicator-section inline systemsculpt-chat-composer-chips",
  });

  const rightGroup = toolbar.createDiv({ cls: "systemsculpt-chat-composer-toolbar-group mod-right" });

  // Attached context files, shown as compact pills
  const attachments = root.createDiv({ cls: "systemsculpt-chat-composer-attachments" });
  attachments.style.display = "none";

  const attachButton = new ButtonComponent(leftGroup)
    .setIcon("paperclip")
    .setTooltip("Add context file or upload document")
    .setClass("clickable-icon")
    .onClick(() => deps.onAddContextFile());
  attachButton.buttonEl.setAttribute("aria-label", "Add context file");
  attachButton.buttonEl.classList.add("systemsculpt-chat-composer-button");

  const settingsButton = new ButtonComponent(rightGroup)
    .setIcon("settings")
    .setTooltip("Chat settings")
    .setClass("clickable-icon")
    .onClick(() => deps.onEditSystemPrompt());
  settingsButton.buttonEl.setAttribute("aria-label", "Chat settings");
  settingsButton.buttonEl.classList.add("systemsculpt-chat-composer-button", "systemsculpt-chat-settings-button");

  const inputWrap = root.createDiv({ cls: "systemsculpt-chat-composer-input" });

  const input = inputWrap.createEl("textarea", {
    cls: "systemsculpt-chat-input",
    attr: {
      rows: "1",
      placeholder: "Write a message…",
      enterkeyhint: "send",
    },
  });

  const actions = inputWrap.createDiv({ cls: "systemsculpt-chat-composer-actions" });

  const micButton = new ButtonComponent(actions)
    .setIcon("mic")
    .setTooltip("Record audio message")
    .setClass("clickable-icon")
    .setDisabled(!deps.hasProLicense())
    .onClick(() => deps.handleMicClick());
  micButton.buttonEl.setAttribute("aria-label", "Record audio message");
  micButton.buttonEl.classList.add("systemsculpt-chat-composer-action", "mod-mic");

  const stopButton = new ButtonComponent(actions)
    .setIcon("square")
    .setTooltip("Stop generation")
    .setClass("clickable-icon")
    .setWarning()
    .onClick(() => void deps.onStop());
  stopButton.buttonEl.setAttribute("aria-label", "Stop generation");
  stopButton.buttonEl.classList.add("systemsculpt-chat-composer-action", "mod-stop");
  stopButton.buttonEl.style.display = "none";

  const sendButton = new ButtonComponent(actions)
    .setIcon("send")
    .setTooltip("Send message")
    .setClass("clickable-icon")
    .setCta()
    .onClick(() => void deps.onSend());
  sendButton.buttonEl.setAttribute("aria-label", "Send message");
  sendButton.buttonEl.classList.add("systemsculpt-chat-composer-action", "mod-send");
  sendButton.setDisabled(true);

  const syncHasValue = () => {
    if (input.value.trim().length > 0) {
      inputWrap.classList.add("has-value");
    } else {
      inputWrap.classList.remove("has-value");
    }
  };

  deps.registerDomEvent(input, "focus", () => {
    inputWrap.classList.add("is-focused");
  });

  deps.registerDomEvent(input, "blur", () => {
    inputWrap.classList.remove("is-focused");
  });

  deps.registerDomEvent(input, "keydown", deps.onKeyDown);
  deps.registerDomEvent(input, "input", () => {
    deps.onInput();
    syncHasValue();
  });
  deps.registerDomEvent(input, "paste", deps.onPaste);

  syncHasValue();

  return {
    root,
    toolbar,
    attachments,
    chips,
    inputWrap,
    input: input as HTMLTextAreaElement,
    settingsButton,
    attachButton,
    sendButton,
    stopButton,
    micButton,
  };
}
