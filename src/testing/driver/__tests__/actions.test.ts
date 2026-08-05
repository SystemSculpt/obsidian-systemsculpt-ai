/**
 * @jest-environment jsdom
 */

import type { App } from "obsidian";

import {
  runDriverAction,
  type ActionContext,
} from "../actions";

function makeContext(read = jest.fn<Promise<string>, [string]>()) {
  const ctx: ActionContext = {
    app: {
      vault: {
        adapter: { read },
      },
      workspace: { getLeavesOfType: () => [] },
    } as unknown as App,
    pluginId: "systemsculpt-ai",
    pluginVersion: "0.0.0-test",
    buildStamp: "test-build",
    diagnostics: {} as ActionContext["diagnostics"],
  };
  return { ctx, read };
}

describe("test driver actions", () => {
  beforeEach(() => {
    document.body.empty();
  });

  it("requires one exact trimmed text match", async () => {
    const { ctx } = makeContext();
    const first = document.createElement("div");
    first.className = "exact-response";
    first.textContent = "  EXPECTED  ";
    document.body.append(first);

    await expect(runDriverAction(ctx, "waitFor", {
      target: "css:.exact-response",
      state: "textEquals",
      text: "EXPECTED",
      timeoutMs: 0,
    })).resolves.toMatchObject({ satisfied: true });

    const extra = document.createElement("div");
    extra.className = "exact-response";
    extra.textContent = "EXTRA";
    document.body.append(extra);
    await expect(runDriverAction(ctx, "waitFor", {
      target: "css:.exact-response",
      state: "textEquals",
      text: "EXPECTED",
      timeoutMs: 0,
    })).rejects.toThrow(/did not reach "textEquals"/);
  });

  it("proves exact vault content without returning the content", async () => {
    const read = jest.fn(async () => "EXPECTED");
    const { ctx } = makeContext(read);

    await expect(runDriverAction(ctx, "vault.assertText", {
      path: "QA/E2E/result.md",
      text: "EXPECTED",
    })).resolves.toEqual({
      path: "QA/E2E/result.md",
      exact: true,
      characters: 8,
    });
    expect(read).toHaveBeenCalledWith("QA/E2E/result.md");

    await expect(runDriverAction(ctx, "vault.assertText", {
      path: "../outside.md",
      text: "EXPECTED",
    })).rejects.toThrow(/unsafe/);
  });
});
