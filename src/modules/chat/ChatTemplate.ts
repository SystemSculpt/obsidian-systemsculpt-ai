export const chatTemplate = `
  <div class="systemsculpt-chat-container">
    <div class="systemsculpt-chat-header">
      <div class="systemsculpt-chat-title-container">
        <span class="systemsculpt-chat-title-text"></span>
      </div>
      <button class="systemsculpt-actions-button" title="Chat Actions">Actions</button>
    </div>
    <div class="systemsculpt-chat-messages"></div>
    <div class="systemsculpt-context-files-container">
      <div class="systemsculpt-context-buttons-container">
        <button class="systemsculpt-context-files-header" title="Add Context File">
          <h3>Context Files</h3>
        </button>
      </div>
      <div class="systemsculpt-context-files"></div>
    </div>
    <div class="systemsculpt-chat-input-container">
      <div class="systemsculpt-chat-input-wrapper">
        <textarea class="systemsculpt-chat-input" placeholder="Type a message..."></textarea>
        <div class="systemsculpt-chat-input-footer">
          <div class="systemsculpt-token-and-cost-container">
            <span class="systemsculpt-token-count" style="display: none;">Tokens: 0</span>
            <span class="systemsculpt-cost-estimate" style="display: none;">Estimated Cost: $0.00 - $0.00</span>
          </div>
          <div class="systemsculpt-send-button-container">
            <button class="systemsculpt-chat-send-button" title="Send Message">Send</button>
          </div>
        </div>
      </div>
      <div class="systemsculpt-chat-input-loading systemsculpt-hidden">
        <div class="systemsculpt-loading-spinner"></div>
        <span>AI is thinking...</span>
      </div>
    </div>
    <div class="systemsculpt-loading-overlay">
      <div class="systemsculpt-loading-container">
        <div class="systemsculpt-loading-spinner"></div>
        <div class="systemsculpt-loading-text">Processing files...</div>
      </div>
    </div>
  </div>
`;
