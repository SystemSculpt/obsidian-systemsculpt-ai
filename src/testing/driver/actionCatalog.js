/**
 * Supported development-driver actions, their public CLI aliases, and whether
 * an interrupted observation can release the socket queue. Plain ESM keeps the
 * plugin and Node CLI on the same catalog without a generated copy.
 *
 * @type {Readonly<Record<string, Readonly<{
 *   detachable: boolean | "without-approval",
 *   verb?: string,
 *   usage?: string,
 * }>>>}
 */
export const SUPPORTED_DRIVER_ACTIONS = {
  status: { detachable: true, verb: "status" },
  "chat.open": { detachable: false, verb: "open-chat" },
  click: { detachable: false, verb: "click" },
  type: { detachable: false, verb: "type" },
  press: { detachable: false, verb: "press" },
  attach: { detachable: false, verb: "attach" },
  scroll: { detachable: false, verb: "scroll" },
  select: { detachable: false, verb: "select" },
  read: { detachable: true, verb: "read" },
  "vault.assertText": { detachable: true },
  "vault.assertFolder": { detachable: false },
  query: { detachable: true, verb: "query" },
  catalog: { detachable: true, verb: "targets", usage: "targets [--live]" },
  logs: { detachable: true, verb: "logs" },
  notices: { detachable: true, verb: "notices" },
  command: { detachable: false, verb: "command" },
  "settings.open": { detachable: false, verb: "settings" },
  "settings.close": { detachable: false, verb: "settings-close" },
  snapshot: { detachable: true, verb: "snapshot" },
  waitFor: { detachable: true, verb: "wait" },
  waitForRun: { detachable: "without-approval", verb: "wait-run" },
  "chat.beginToolLifecycleCapture": { detachable: false, verb: "tool-lifecycle-start" },
  "chat.toolLifecycle": { detachable: true, verb: "tool-lifecycle" },
  "chat.assertToolLifecycle": { detachable: true },
  "chat.endToolLifecycleCapture": { detachable: false, verb: "tool-lifecycle-end" },
  "chat.assertLatestToolSettledAfterContinuation": {
    detachable: true,
    verb: "assert-tool-settled",
  },
  "chat.assertAllToolResultSendsCompleted": {
    detachable: false,
    verb: "assert-tool-results-completed",
  },
  "chat.assertExactSequentialToolPlan": { detachable: false },
  "chat.assertExactToolPlanCleanClose": { detachable: false },
  "chat.assertNoClientToolsBeforeContinuation": {
    detachable: true,
    verb: "assert-no-client-tools",
  },
  "chat.beginDevelopmentState": { detachable: false },
  "chat.typeDevelopmentDraft": { detachable: false },
  "chat.exportDevelopmentOwnershipReceipt": { detachable: false },
  "chat.importDevelopmentOwnershipReceipt": { detachable: false },
  "chat.approveDevelopmentWriteOnce": { detachable: false },
  "chat.approveDevelopmentMutationOnce": { detachable: false },
  "chat.reopenOwnedDevelopmentHistory": { detachable: false },
  "chat.waitForDevelopmentRun": { detachable: true },
  "chat.resetDevelopmentState": { detachable: false },
  "chat.readCopiedIncidentReport": { detachable: true },
  "diagnostics.baselineExports": { detachable: false },
  "diagnostics.attributeNewExport": { detachable: false },
  "diagnostics.trashAttributedExport": { detachable: false },
};

/** The script verb belongs to the CLI, not to the in-plugin action engine. */
export const DRIVER_CLI_COMMANDS = [
  ...Object.entries(SUPPORTED_DRIVER_ACTIONS).flatMap(([action, metadata]) =>
    metadata.verb ? [{ action, verb: metadata.verb, usage: metadata.usage ?? metadata.verb }] : [],
  ),
  { action: undefined, verb: "script", usage: "script <file>" },
];

/** @param {string | undefined} verb */
export function driverActionForVerb(verb) {
  return DRIVER_CLI_COMMANDS.find((command) => command.verb === verb)?.action;
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @returns {boolean}
 */
export function isDetachableDriverAction(action, params = {}) {
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_DRIVER_ACTIONS, action)) return false;
  const { detachable } = SUPPORTED_DRIVER_ACTIONS[action];
  if (detachable === "without-approval") {
    return params.approve === false || params.returnOnApproval === true;
  }
  return detachable;
}
