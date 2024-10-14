import { marked } from "marked";
import { ChatMessage } from "../ChatMessage";
import { handleDeleteMessage } from "./handleDeleteMessage";

const INITIAL_LOAD_LIMIT = 30000; // Characters
const CHUNK_SIZE = 10000; // Characters

function isScrolledToBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - container.clientHeight <= container.scrollTop + 1
  );
}

export function renderMessages(
  chatMessages: ChatMessage[],
  messagesContainer: HTMLElement,
  deleteMessageCallback: (index: number) => void
) {
  if (!messagesContainer) return;
  messagesContainer.innerHTML = "";

  let visibleMessages: ChatMessage[] = [];
  let visibleMessageIndices: number[] = [];

  // Find the messages to render initially
  let totalChars = 0;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const message = chatMessages[i];
    totalChars += message.text.length;
    visibleMessages.unshift(message);
    visibleMessageIndices.unshift(i);
    if (totalChars >= INITIAL_LOAD_LIMIT) break;
  }

  // Create and add the "Load More" button
  const loadMoreButton = createLoadMoreButton(() => {
    loadMoreMessages();
    renderVisibleMessages(
      visibleMessages,
      visibleMessageIndices,
      messagesContainer,
      deleteMessageCallback
    );
  });
  messagesContainer.appendChild(loadMoreButton);

  // Render visible messages
  renderVisibleMessages(
    visibleMessages,
    visibleMessageIndices,
    messagesContainer,
    deleteMessageCallback
  );

  const loadMoreMessages = () => {
    const firstVisibleIndex = visibleMessageIndices[0];
    if (firstVisibleIndex === 0) {
      loadMoreButton.style.display = "none";
      return;
    }

    let charsToAdd = 0;
    const newMessages: ChatMessage[] = [];
    const newIndices: number[] = [];
    for (let i = firstVisibleIndex - 1; i >= 0; i--) {
      const message = chatMessages[i];
      charsToAdd += message.text.length;
      newMessages.unshift(message);
      newIndices.unshift(i);
      if (charsToAdd >= CHUNK_SIZE) break;
    }

    visibleMessages = [...newMessages, ...visibleMessages];
    visibleMessageIndices = [...newIndices, ...visibleMessageIndices];
  };

  // Check if the user is scrolled to the bottom
  const wasScrolledToBottom = isScrolledToBottom(messagesContainer);

  if (wasScrolledToBottom) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function renderVisibleMessages(
  messages: ChatMessage[],
  indices: number[],
  container: HTMLElement,
  deleteMessageCallback: (index: number) => void
) {
  // Keep the "Load More" button if it exists
  const loadMoreButton = container.querySelector(
    ".systemsculpt-load-more-button"
  );
  container.innerHTML = "";
  if (loadMoreButton) {
    container.appendChild(loadMoreButton);
  }

  messages.forEach((message, arrayIndex) => {
    const originalIndex = indices[arrayIndex];
    const messageEl = createMessageElement(message, originalIndex, (index) => {
      deleteMessageCallback(index);
      // Remove the deleted message from our local arrays
      const localIndex = indices.indexOf(index);
      if (localIndex !== -1) {
        messages.splice(localIndex, 1);
        indices.splice(localIndex, 1);
      }
      renderVisibleMessages(
        messages,
        indices,
        container,
        deleteMessageCallback
      );
    });
    container.appendChild(messageEl);
  });

  // Add click event listener for code blocks
  const codeBlocks = container.querySelectorAll("pre.systemsculpt-code-block");
  codeBlocks.forEach(addCodeBlockClickListener);
}

function createLoadMoreButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "systemsculpt-load-more-button";
  button.textContent = "See Previous Messages";
  button.addEventListener("click", onClick);
  return button;
}

function createMessageElement(
  message: ChatMessage,
  index: number,
  deleteMessageCallback: (index: number) => void
): HTMLElement {
  const messageEl = document.createElement("div");
  const roleClass = message.role.startsWith("ai")
    ? "systemsculpt-ai"
    : `systemsculpt-${message.role}`;
  messageEl.className = `systemsculpt-chat-message ${roleClass}`;
  messageEl.innerHTML = `
    ${marked(message.text)}
    <div class="systemsculpt-message-actions">
      <button class="systemsculpt-copy-button" title="Copy Message">📋</button>
      <button class="systemsculpt-delete-button" title="Delete Message">🗑️</button>
    </div>
    ${
      message.role.startsWith("ai")
        ? `<span class="systemsculpt-model-name">${message.model || "AI"}</span>`
        : ""
    }
  `;

  const copyButton = messageEl.querySelector(".systemsculpt-copy-button");
  if (copyButton) {
    copyButton.addEventListener("click", () =>
      handleCopyMessage(copyButton as HTMLElement, message.text)
    );
  }

  const deleteButton = messageEl.querySelector(".systemsculpt-delete-button");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => {
      handleDeleteMessage(deleteButton as HTMLElement, () =>
        deleteMessageCallback(index)
      );
    });
  }

  return messageEl;
}

function handleCopyMessage(button: HTMLElement, text: string) {
  navigator.clipboard.writeText(text).then(() => {
    button.classList.add("systemsculpt-copied");
    button.innerHTML = "✅";
    setTimeout(() => {
      button.classList.remove("systemsculpt-copied");
      button.innerHTML = "📋";
    }, 2000);
  });
}

function addCodeBlockClickListener(codeBlock: Element) {
  codeBlock.addEventListener("click", () => {
    const code = codeBlock.textContent || "";
    navigator.clipboard.writeText(code).then(() => {
      codeBlock.classList.add("systemsculpt-copied");
      setTimeout(() => {
        codeBlock.classList.remove("systemsculpt-copied");
      }, 2000);
    });
  });
}
