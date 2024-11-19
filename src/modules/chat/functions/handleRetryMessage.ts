export function handleRetryMessage(
  retryButton: HTMLElement,
  messageText: string,
  index: number
) {
  if (retryButton.classList.contains("confirm-retry")) {
    // Get input element
    const inputEl = document.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;

    if (inputEl) {
      inputEl.value = messageText;
      inputEl.focus();
      // Set cursor to end of input
      inputEl.selectionStart = inputEl.value.length;
      inputEl.selectionEnd = inputEl.value.length;

      // Dispatch custom event to notify ChatView
      const event = new CustomEvent("messageRetry", {
        detail: { index },
      });
      document.dispatchEvent(event);
    }
  } else {
    retryButton.classList.add("confirm-retry");
    retryButton.innerHTML = "You sure? 🔄";
    setTimeout(() => {
      retryButton.classList.remove("confirm-retry");
      retryButton.innerHTML = "🔄";
    }, 3000);
  }
}
