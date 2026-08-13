const DEVELOPMENT_ROOT = "SystemSculpt/Development Tests";

// The final content part must be the durable marker text itself. A failed
// response may append its terminal error card after that text.
export const LATEST_DURABLE_ASSISTANT_TEXT =
  "chat:.systemsculpt-agent-history"
  + " > .systemsculpt-agent-turn.is-assistant:last-child"
  + " > .systemsculpt-agent-turn-body"
  + " > .systemsculpt-agent-part.is-text:is("
  + ":last-child, :has(+ .systemsculpt-agent-part.is-error:last-child))";

export function makeDevelopmentContext(prefix, now) {
  const runId = `${prefix}${now.toString(36).toUpperCase().padStart(2, "0")}`;
  const marker = `SS-DEV-TEST-${runId}`;
  return {
    runId,
    marker,
    markerRoot: `${DEVELOPMENT_ROOT}/${marker}`,
  };
}

export function withOwnedDevelopmentState(context, steps) {
  return {
    steps: [
      { label: "open chat", action: "chat.open" },
      {
        label: "begin owned development state",
        action: "chat.beginDevelopmentState",
        params: { marker: context.marker },
      },
      ...steps,
    ],
    cleanup: [
      {
        label: "reset exact development state",
        action: "chat.resetDevelopmentState",
        params: {
          marker: context.marker,
          trashDevelopmentPath: context.markerRoot,
          trashSavedChat: true,
        },
      },
    ],
  };
}
