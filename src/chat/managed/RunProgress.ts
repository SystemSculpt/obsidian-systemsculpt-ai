import { isRecord, toolCallId, type WirePart, type WireMessage } from "./WireConversation";
import type { AgentSessionSnapshot } from "./AuthoritativeSession";

function partProgressToken(part: WirePart): readonly unknown[] {
  const approval = isRecord(part.approval) ? part.approval : null;
  const output = isRecord(part.output) ? part.output : null;
  return [
    part.type,
    typeof part.text === "string" ? part.text.length : null,
    typeof part.state === "string" ? part.state : null,
    toolCallId(part),
    typeof approval?.id === "string" ? approval.id : null,
    typeof approval?.approved === "boolean" ? approval.approved : null,
    typeof part.preliminary === "boolean" ? part.preliminary : null,
    Object.prototype.hasOwnProperty.call(part, "output"),
    typeof output?.success === "boolean" ? output.success : null,
    Object.prototype.hasOwnProperty.call(part, "error"),
  ];
}

/**
 * Content-free "did the server produce anything new" fingerprint.
 *
 * Run cursors need not advance for accepted assistant replacements. Track the
 * latest assistant's semantic part state as well, so text/reasoning growth and
 * tool approval/result transitions cancel a stalled recovery immediately.
 */
export function runProgressKey(
  snapshot: AgentSessionSnapshot<WireMessage>,
): string {
  const messages = snapshot.messages;
  let assistant: WireMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistant = messages[index];
      break;
    }
  }
  const parts = assistant?.parts ?? [];
  const runState = snapshot.runState;
  const runId = "run_id" in runState ? runState.run_id : "";
  return JSON.stringify([
    runState.state,
    runState.cursor,
    runId,
    messages.length,
    assistant?.id ?? null,
    parts.map(partProgressToken),
  ]);
}
