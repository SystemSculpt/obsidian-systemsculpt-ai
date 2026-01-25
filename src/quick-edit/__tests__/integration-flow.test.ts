import { describe, expect, it, jest } from "@jest/globals";
import type { TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { ChatMessage } from "../../types";
import type { StreamEvent } from "../../streaming/types";
import type { ToolCallRequest } from "../../types/toolCalls";
import { QuickEditController, type QuickEditControllerDeps } from "../controller";

const DISORGANIZED_NOTE = [
  "Idea 3??",
  "Remember to breathe",
  "Focus??",
  "idea 1 - start with patients",
].join("\n");

const ORGANIZED_EXPECTATION = [
  "## Prioritized Plan",
  "",
  "1. Idea 1 - start with patients",
  "2. Focus??",
  "3. Idea 3??",
  "",
  "• Remember to breathe",
].join("\n");

const buildPlugin = (content: string): SystemSculptPlugin => {
  return {
    settings: {
      selectedModelId: "openrouter/gpt-4.1-mini",
      // mcpEnabled and mcpEnabledTools are deprecated - internal tools always available
    },
    app: {
      vault: {
        getAbstractFileByPath: () => new (require("obsidian").TFile)({ path: "Brain Dump.md" }),
        read: jest.fn(async () => content),
      },
    },
  } as unknown as SystemSculptPlugin;
};

const buildFile = (): TFile => new (require("obsidian").TFile)({ path: "Brain Dump.md" });

const createDeps = (): QuickEditControllerDeps => ({
  capabilityChecker: jest.fn().mockResolvedValue({ ok: true, issues: [] }),
  promptBuilder: jest.fn().mockResolvedValue({
    systemPrompt: "system",
    user: { role: "user", content: "Organize", message_id: "user-1" } as ChatMessage,
  }),
  streamFactory: jest.fn(),
  executeToolCalls: jest.fn().mockResolvedValue([]),
  abortControllerFactory: () => new AbortController(),
});

const buildOrganizingStream = (): AsyncGenerator<StreamEvent> => {
  async function* generator() {
    yield { type: "reasoning", text: "Drafting outline…" } as StreamEvent;
    yield {
      type: "tool-call",
      phase: "final",
      call: {
        id: "edit-1",
        type: "function",
        function: {
          name: "mcp-filesystem_write",
          arguments: JSON.stringify({
            path: "Brain Dump.md",
            content: ORGANIZED_EXPECTATION,
          }),
        },
      },
    } as StreamEvent;
  }
  return generator();
};

describe("QuickEditController – end-to-end prompt flow", () => {
  it("organizes a disorganized note in a single prompt and waits for confirmation", async () => {
    const deps = createDeps();
    deps.streamFactory = jest.fn().mockReturnValue(buildOrganizingStream());

    const controller = new QuickEditController(deps);
    const plugin = buildPlugin(DISORGANIZED_NOTE);
    const file = buildFile();
    let previewCalls: ToolCallRequest[] = [];
    controller.events.on("preview", ({ toolCalls }) => {
      previewCalls = toolCalls;
    });

    await controller.start({
      plugin,
      file,
      prompt: "Organize",
    });

    expect(controller.state).toBe("awaiting-confirmation");
    expect(previewCalls.length).toBe(1);
    const previewCallArgs = JSON.parse((previewCalls[0]?.function?.arguments as string) ?? "{}");
    expect(previewCallArgs.path).toBe("Brain Dump.md");
    expect(previewCallArgs.content).toBe(ORGANIZED_EXPECTATION);
    expect(deps.executeToolCalls).not.toHaveBeenCalled();

    controller.complete();
    expect(controller.state).toBe("completed");
  });
});
