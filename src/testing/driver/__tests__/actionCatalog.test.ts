/**
 * @jest-environment jsdom
 */

import { DRIVER_ACTIONS } from "../actions";
import {
  SUPPORTED_DRIVER_ACTIONS,
  isDetachableDriverAction,
} from "../actionCatalog.js";

const OBSERVATIONAL_ACTIONS = [
  "status",
  "read",
  "vault.assertText",
  "logs",
  "notices",
  "catalog",
  "query",
  "snapshot",
  "waitFor",
  "chat.toolLifecycle",
  "chat.assertToolLifecycle",
  "chat.waitForDevelopmentRun",
  "chat.assertLatestToolSettledAfterContinuation",
  "chat.assertNoClientToolsBeforeContinuation",
  "chat.readCopiedIncidentReport",
];

describe("supported driver action catalog", () => {
  it("catalogs every handler in registry order with no unsupported actions", () => {
    expect(Object.keys(SUPPORTED_DRIVER_ACTIONS)).toEqual(Object.keys(DRIVER_ACTIONS));
  });

  it("preserves the observational action classifications without detaching mutators", () => {
    const detachable = Object.keys(SUPPORTED_DRIVER_ACTIONS)
      .filter((action) => isDetachableDriverAction(action));

    expect(detachable.sort()).toEqual([...OBSERVATIONAL_ACTIONS].sort());
    for (const action of Object.keys(SUPPORTED_DRIVER_ACTIONS)) {
      expect(isDetachableDriverAction(action, { approve: false, returnOnApproval: true }))
        .toBe(OBSERVATIONAL_ACTIONS.includes(action) || action === "waitForRun");
    }
  });

  it.each([
    [undefined, false],
    [{}, false],
    [{ approve: true }, false],
    [{ approve: false }, true],
    [{ returnOnApproval: true }, true],
    [{ approve: true, returnOnApproval: true }, true],
    [{ approve: "false", returnOnApproval: "true" }, false],
  ])("detaches waitForRun only when it cannot approve: %j", (params, expected) => {
    expect(isDetachableDriverAction("waitForRun", params)).toBe(expected);
  });

  it("never classifies unknown or inherited names as detachable", () => {
    for (const action of ["chat.noSuchAction", "constructor", "toString", "__proto__"]) {
      expect(isDetachableDriverAction(action, { approve: false })).toBe(false);
    }
  });
});
