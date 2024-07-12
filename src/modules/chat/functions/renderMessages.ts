import { marked } from 'marked';
import { ChatMessage } from '../ChatMessage';
import { handleDeleteMessage } from './handleDeleteMessage';

export function renderMessages(
  chatMessages: ChatMessage[],
  messagesContainer: HTMLElement,
  deleteMessageCallback: (index: number) => void
) {
  if (!messagesContainer) return;
  messagesContainer.innerHTML = '';

  chatMessages.forEach((message, index) => {
    const messageEl = document.createElement('div');
    const roleClass = message.role.startsWith('ai') ? 'ai' : message.role;
    messageEl.className = `chat-message ${roleClass}`;
    messageEl.innerHTML = `
      ${marked(message.text)}
      <div class="message-actions">
        <button class="copy-button" title="Copy Message">📋</button>
        <button class="delete-button" title="Delete Message">🗑️</button>
      </div>
      ${
        message.role.startsWith('ai')
          ? `<span class="model-name">${message.model || 'AI'}</span>`
          : ''
      }
    `;
    messagesContainer.appendChild(messageEl);

    const copyButton = messageEl.querySelector('.copy-button');
    if (copyButton) {
      copyButton.addEventListener('click', () => {
        navigator.clipboard.writeText(message.text).then(() => {
          copyButton.classList.add('copied');
          copyButton.innerHTML = '✅';
          setTimeout(() => {
            copyButton.classList.remove('copied');
            copyButton.innerHTML = '📋';
          }, 2000);
        });
      });
    }

    const deleteButton = messageEl.querySelector('.delete-button');
    if (deleteButton) {
      deleteButton.addEventListener('click', () => {
        handleDeleteMessage(deleteButton as HTMLElement, () =>
          deleteMessageCallback(index)
        );
      });
    }
  });

  // Add click event listener for code blocks
  const codeBlocks = messagesContainer.querySelectorAll('pre');
  codeBlocks.forEach(codeBlock => {
    codeBlock.addEventListener('click', () => {
      const code = codeBlock.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        codeBlock.classList.add('copied');
        setTimeout(() => {
          codeBlock.classList.remove('copied');
        }, 2000);
      });
    });
  });

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}
