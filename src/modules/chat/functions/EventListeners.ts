import { ChatView } from '../ChatView';
import { TFile } from 'obsidian';
import { sendMessage } from './sendMessage';
import { FileSearcher } from '../FileSearcher';

export function attachEventListeners(chatView: ChatView) {
  const container = chatView.containerEl;
  const inputEl = container.querySelector('.chat-input') as HTMLTextAreaElement;
  const sendButtonEl = container.querySelector(
    '.chat-send-button'
  ) as HTMLButtonElement;

  sendButtonEl.addEventListener('click', () =>
    handleSendMessage(chatView, inputEl)
  );
  inputEl.addEventListener('keydown', event =>
    handleInputKeydown(event, chatView, inputEl)
  );
  inputEl.addEventListener('input', () => handleInputChange(chatView, inputEl));

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

  if (isFirstMessage) {
    await chatView.handleFirstMessage();
  }
}

function handleInputKeydown(
  event: KeyboardEvent,
  chatView: ChatView,
  inputEl: HTMLTextAreaElement
) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSendMessage(chatView, inputEl);
  } else if (event.key === 'Enter' && event.shiftKey) {
    event.stopPropagation();
  }
}

function handleInputChange(chatView: ChatView, inputEl: HTMLTextAreaElement) {
  chatView.updateTokenCountWithInput(inputEl.value);
  chatView.detectFileLink(inputEl);
  chatView.adjustInputHeight(inputEl);
}

function attachHeaderButtonListeners(chatView: ChatView) {
  const actionsButton = chatView.containerEl.querySelector(
    '.actions-button'
  ) as HTMLElement;

  if (actionsButton) {
    actionsButton.addEventListener('click', () => chatView.showActionsModal());
  }
}

export function attachFileSearcherListeners(
  chatView: ChatView,
  inputEl?: HTMLTextAreaElement,
  addToContextFiles: boolean = false
) {
  const fileSearcher = new FileSearcher(chatView.app);
  fileSearcher.open();
  fileSearcher.onChooseItem = (file: TFile) => {
    if (inputEl) {
      const fileName = file.basename;
      inputEl.value = inputEl.value.slice(0, -2) + `[[${fileName}]]`;
      inputEl.focus();
      chatView.updateTokenCountWithInput(inputEl.value);
    }

    if (addToContextFiles) {
      chatView.contextFileManager.addFileToContextFiles(file);
    }
  };
}
