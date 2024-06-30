export const chatTemplate = `
  <div class="chat-container">
    <div class="chat-header">
      SystemSculpt AI Chat
      <button class="actions-button" title="Chat Actions">⚙️</button>
    </div>
    <div class="chat-title">
      <div class="chat-title-container">
        <span class="chat-title-text"></span>
      </div>
      <div class="token-container">
        <span class="token-count" style="display: none;">Tokens: 0</span>
      </div>
    </div>
    <div class="chat-messages"></div>
    <div class="context-files-container">
      <button class="context-files-header" title="Add Context File">
        <h3>Context Files ➕</h3>
      </button>
      <div class="context-files"></div>
    </div>
    <div class="chat-input-container">
      <textarea class="chat-input" placeholder="Type a message..."></textarea>
      <button class="chat-send-button" title="Send Message">Send</button>
    </div>
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <div class="loading-text">Generating response...</div>
    </div>
  </div>
`;
