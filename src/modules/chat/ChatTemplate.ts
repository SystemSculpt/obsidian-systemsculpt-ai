export const chatTemplate = `
  <div class="chat-container">
    <div class="chat-header">
      <div class="chat-title-container">
        <span class="chat-title-text"></span>
      </div>
      <button class="actions-button" title="Chat Actions">Actions</button>
    </div>
    <div class="chat-messages"></div>
    <div class="context-files-container">
      <div class="context-buttons-container">
        <button class="context-files-header" title="Add Context File">
          <h3>Context Files</h3>
        </button>
      </div>
      <div class="context-files"></div>
    </div>
    <div class="chat-input-container">
      <textarea class="chat-input" placeholder="Type a message..."></textarea>
      <div class="chat-input-footer">
        <div class="token-and-cost-container">
          <span class="token-count" style="display: none;">Tokens: 0</span>
          <span class="cost-estimate" style="display: none;">Estimated Cost: $0.00 - $0.00</span>
        </div>
        <div class="send-button-container">
          <button class="chat-send-button" title="Send Message">Send</button>
        </div>
      </div>
    </div>
    <div class="loading-overlay">
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">Processing files...</div>
        <div class="progress-bar">
          <div class="progress-bar-fill"></div>
        </div>
        <div class="progress-text">0 / 0 files processed</div>
      </div>
    </div>
  </div>
`;