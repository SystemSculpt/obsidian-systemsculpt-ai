---
title: Chat Module - Features
description: Detailed information about the key features of the Chat Module in SystemSculpt AI.
index: 1
---

## AI-Powered Conversations

The Chat module leverages advanced AI models to provide intelligent responses to user queries. Key aspects include:

- Integration with multiple AI models (OpenAI, Groq, OpenRouter, and local models)
- Real-time streaming of AI responses for a more interactive experience
- Ability to switch between different AI models during a conversation
- Token count tracking to manage conversation length and model limitations
- Display of the used AI model for each response

To use this feature:

1. Open a new chat by clicking the ribbon icon or using the command palette.
2. Type your message in the input field.
3. Press Enter or click the Send button to receive an AI-generated response.
4. The AI model used for the response will be displayed below each AI message.

## Message Management

Users can manage individual messages within a conversation:

- Copy a message by clicking the "📋" button next to it
- Delete a message by clicking the "🗑️" button (requires confirmation)
- Deleted messages are also removed from the chat file

## Context-Aware Chat

The Chat module can incorporate context from your Obsidian vault, allowing for more relevant and personalized conversations.

To add context to your chat:

1. Click the "Context Files ➕" button in the chat interface.
2. Select one or more files from your vault to add as context.
3. The AI will consider the content of these files when generating responses.
4. Context files are displayed below the chat interface and can be removed individually.
5. Context files are saved with the chat and will be loaded when reopening the chat.

## Conversation History

All chat conversations are automatically saved and can be easily accessed later.

To manage your chat history:

1. Click the "⚙️" (Actions) button in the chat header to open the Chat Actions modal.
2. Choose the "Open Chat History" option.
3. Select a previous conversation to continue or review.
4. Use the "Open Chat History File" option to open the current chat file in Obsidian for editing.
5. Chat history excludes archived chats.

## Token Count Tracking

The module keeps track of the token count for each conversation, helping you stay within the limits of the AI model.

- The token count is displayed at the top of the chat interface.
- Use the "Estimate Cost" option in the Chat Actions modal to estimate the cost of the current conversation.
- Token count is updated in real-time as you type or receive responses.
- The token count includes context files, message history, and the current input.

For information on advanced features, please refer to the [Advanced Features](chat-advanced-features) document.
