/**
 * @jest-environment jsdom
 */

import { App, setIcon } from "obsidian";
import type { AgentConversationSnapshot } from "../AgentConversation";
import type {
  AgentConversationPresentation,
  AgentPresentationPhase,
} from "../AgentConversationPresentation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";

function presentation(
  phase: AgentPresentationPhase,
  busy: boolean,
  activityStatus: string,
  snapshot: AgentConversationSnapshot,
): AgentConversationPresentation {
  return {
    phase,
    busy,
    composerRunning: busy,
    visibleParts: snapshot.parts,
    activityStatus,
  };
}

describe("AgentConversationRenderer activity icons", () => {
  afterEach(() => {
    document.body.empty();
    jest.clearAllMocks();
  });

  it.each([
    ["completed", "Done", "check"],
    ["failed", "Failed", "circle-alert"],
    ["cancelled", "Stopped", "circle-stop"],
  ] as const)("keeps the activity node stable and uses the %s terminal icon", async (
    status,
    label,
    expectedIcon,
  ) => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const parts = [{
      id: "reasoning-icon",
      kind: "reasoning" as const,
      messageId: "assistant-icon",
      state: "complete" as const,
      summary: "Checked the request",
      order: 0,
    }];
    const running: AgentConversationSnapshot = {
      runId: "run-icon",
      turnId: "user-icon",
      status: "running",
      phase: "thinking",
      statusLabel: "Thinking",
      messages: [{
        id: "assistant-icon",
        role: "assistant",
        partIds: ["reasoning-icon"],
      }],
      parts,
    };
    await renderer.renderActive(
      running,
      presentation("reasoning", true, "Thinking", running),
    );
    const activity = parent.querySelector<HTMLElement>(".systemsculpt-agent-activity")!;
    const icon = activity.querySelector<HTMLElement>(".systemsculpt-agent-activity-icon")!;
    expect(setIcon).toHaveBeenCalledWith(icon, "loader-circle");
    (setIcon as jest.Mock).mockClear();

    const terminal: AgentConversationSnapshot = {
      ...running,
      status,
      parts,
    };
    await renderer.renderActive(
      terminal,
      presentation(status, false, label, terminal),
    );

    expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
    expect(parent.querySelector(".systemsculpt-agent-activity-icon")).toBe(icon);
    expect((setIcon as jest.Mock).mock.calls.filter(([element]) => element === icon))
      .toEqual([[icon, expectedIcon]]);
    expect(icon.classList).not.toContain("is-animated");
    renderer.unload();
  });
});
