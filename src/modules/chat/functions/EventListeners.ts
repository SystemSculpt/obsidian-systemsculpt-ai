import { ChatView } from "../ChatView";
import { TFile, TFolder } from "obsidian";
import { sendMessage } from "./sendMessage";
import { FileSearcher } from "../FileSearcher";

export function attachEventListeners(chatView: ChatView) {
  const container = chatView.containerEl;
  const inputEl = container.querySelector(
    ".systemsculpt-chat-input"
  ) as HTMLTextAreaElement;
  const sendButtonEl = container.querySelector(
    ".systemsculpt-chat-send-button"
  ) as HTMLButtonElement;

  sendButtonEl.addEventListener("click", () =>
    handleSendMessage(chatView, inputEl)
  );
  inputEl.addEventListener("keydown", (event) =>
    handleInputKeydown(event, chatView, inputEl)
  );
  inputEl.addEventListener("input", () => handleInputChange(chatView, inputEl));

  attachHeaderButtonListeners(chatView);
}

async function handleSendMessage(
  chatView: ChatView,
  inputEl: HTMLTextAreaElement
) {
  const isFirstMessage = !chatView.chatFile;

  await sendMessage(
    inputEl,
    chatView.addMessage.bind(chatView),
    chatView.createChatFile.bind(chatView),
    chatView.updateChatFile.bind(chatView),
    chatView.updateTokenCount.bind(chatView),
    chatView.chatFile,
    chatView.brainModule,
    chatView.chatModule,
    chatView.constructMessageHistory.bind(chatView),
    chatView.appendToLastMessage.bind(chatView),
    chatView.showLoading.bind(chatView),
    chatView.hideLoading.bind(chatView)
  );
}

function handleInputKeydown(
  event: KeyboardEvent,
  chatView: ChatView,
  inputEl: HTMLTextAreaElement
) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSendMessage(chatView, inputEl);
  } else if (event.key === "Enter" && event.shiftKey) {
    event.stopPropagation();
  }
}

function handleInputChange(chatView: ChatView, inputEl: HTMLTextAreaElement) {
  chatView.detectFileLink(inputEl);
  chatView.adjustInputHeight(inputEl);
}

function attachHeaderButtonListeners(chatView: ChatView) {
  const actionsButton = chatView.containerEl.querySelector(
    ".systemsculpt-actions-button"
  ) as HTMLElement;

  if (actionsButton) {
    actionsButton.addEventListener("click", () => chatView.showActionsModal());
  }
}

export function attachFileSearcherListeners(
  chatView: ChatView,
  inputEl?: HTMLTextAreaElement,
  addToContextFiles: boolean = false
) {
  console.log("Attaching FileSearcher listeners");
  const fileSearcher = new FileSearcher(chatView.app);
  fileSearcher.setPlaceholder("Search for files or folders");

  fileSearcher.onChooseItems = (files: (TFile | TFolder)[]) => {
    console.log("FileSearcher: onChooseItems called", {
      filesCount: files.length,
    });
    if (addToContextFiles) {
      files.forEach((file) => {
        if (file instanceof TFile) {
          console.log("Adding file to context:", file.path);
          chatView.contextFileManager.addFileToContextFiles(file);
        } else if (file instanceof TFolder) {
          console.log("Adding folder to context:", file.path);
          chatView.contextFileManager.addDirectoryToContextFiles(file);
        }
      });
    } else if (inputEl) {
      const fileNames = files
        .map((file) => (file instanceof TFile ? file.basename : file.name))
        .join(", ");
      inputEl.value = inputEl.value.slice(0, -2) + `[[${fileNames}]]`;
      inputEl.focus();
      chatView.updateTokenCountWithInput(inputEl.value);
    }
  };

  fileSearcher.open();
}
