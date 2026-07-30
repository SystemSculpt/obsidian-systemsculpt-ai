function getToolPartState(part) {
  switch (part.state) {
    case "input-streaming": return "streaming";
    case "approval-requested": return "waiting-approval";
    case "approval-responded": return "approved";
    case "output-available": return "complete";
    case "output-error": return "error";
    case "output-denied": return "denied";
    default: return "loading";
  }
}

function getToolCallId(part) {
  return part.toolCallId;
}

function getToolInput(part) {
  return part.input;
}

function getToolOutput(part) {
  return part.output;
}

function getToolApproval(part) {
  return part.approval;
}

class WebSocketChatTransport {}

module.exports = {
  WebSocketChatTransport,
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolPartState,
};
