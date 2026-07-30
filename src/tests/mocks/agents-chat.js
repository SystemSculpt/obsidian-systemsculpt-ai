const MessageType = Object.freeze({
  CF_AGENT_CHAT_MESSAGES: "cf_agent_chat_messages",
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_CHAT_CLEAR: "cf_agent_chat_clear",
  CF_AGENT_CHAT_REQUEST_CANCEL: "cf_agent_chat_request_cancel",
  CF_AGENT_STREAM_RESUMING: "cf_agent_stream_resuming",
  CF_AGENT_STREAM_RESUME_ACK: "cf_agent_stream_resume_ack",
  CF_AGENT_STREAM_RESUME_REQUEST: "cf_agent_stream_resume_request",
  CF_AGENT_STREAM_RESUME_NONE: "cf_agent_stream_resume_none",
  CF_AGENT_STREAM_PENDING: "cf_agent_stream_pending",
  CF_AGENT_TOOL_RESULT: "cf_agent_tool_result",
  CF_AGENT_MESSAGE_UPDATED: "cf_agent_message_updated",
  CF_AGENT_TOOL_APPROVAL: "cf_agent_tool_approval",
  CF_AGENT_CHAT_RECOVERING: "cf_agent_chat_recovering",
});

module.exports = { MessageType };
