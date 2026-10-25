import {
  type ActionContext,
  DriverActionError,
  type DriverActionHandlers,
  throwIfActionCancelled,
} from "./actionCore";
import { CHAT_DEVELOPMENT_STATE_ACTIONS } from "./chatDevelopmentState";
import { CHAT_TOOL_LIFECYCLE_ACTIONS } from "./chatToolLifecycle";
import { DIAGNOSTICS_EXPORT_ACTIONS } from "./diagnosticsExports";
import { DOM_ACTIONS } from "./domActions";
import { SNAPSHOT_AND_WAIT_ACTIONS } from "./snapshotsAndWaits";

export type { ActionContext } from "./actionCore";
export { DEVELOPMENT_TEST_ROOT } from "./chatDevelopmentState";

/**
 * DOM-level action engine for the E2E test driver.
 *
 * Every action operates on the real rendered UI through synthesized user
 * events (pointer, keyboard, input, change, drop), never through service
 * shortcuts, so a scripted run exercises the same code paths as a human.
 * Each area module registers its actions by name; this registry is the only
 * list of what the driver accepts.
 */
export const DRIVER_ACTIONS: DriverActionHandlers = {
  ...DOM_ACTIONS,
  ...SNAPSHOT_AND_WAIT_ACTIONS,
  ...CHAT_TOOL_LIFECYCLE_ACTIONS,
  ...CHAT_DEVELOPMENT_STATE_ACTIONS,
  ...DIAGNOSTICS_EXPORT_ACTIONS,
};

export async function runDriverAction(
  ctx: ActionContext,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  throwIfActionCancelled(ctx);
  if (!Object.prototype.hasOwnProperty.call(DRIVER_ACTIONS, action)) {
    throw new DriverActionError(
      `Unknown driver action "${action}". Available: ${Object.keys(DRIVER_ACTIONS).join(", ")}.`,
    );
  }
  return DRIVER_ACTIONS[action](ctx, params);
}
