/** @jest-environment jsdom */
import { Platform } from "obsidian";
import { PromptModal } from "../../../core/ui/modals/PromptModal";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { scriptNode } from "../../../studio/nodes/scriptNode";
import { processNode } from "../../../studio/nodes/processNode";

jest.mock("../../../core/ui/modals/PromptModal", () => ({ PromptModal: jest.fn() }));
const runGraph = (SystemSculptStudioView as any).prototype.runGraph;

function harness(kind = "studio.process") {
  const scopedProject = { graph: { nodes: [{ id: "capture", title: "Capture", kind }] } };
  const studio = {
    getProcessApprovalRequests: jest.fn(async () => [{ command: "/usr/local/bin/helper", nodeTitle: "Capture", cwd: "/vault", args: ["capture"] }]),
    addCapabilityGrant: jest.fn(async () => {}),
    runProject: jest.fn(async () => ({ status: "success", runId: "run" })),
  };
  const context = {
    app: {}, currentProjectPath: "Studio/Operations.systemsculpt",
    removePendingManagedOutputPlaceholders: jest.fn(() => false), render: jest.fn(),
    collectRunScope: jest.fn(() => ({ scopedProject, errors: [] })), findNodeDefinition: () => kind === "studio.script" ? scriptNode : processNode,
    setError: jest.fn(), runPresentation: { beginRun: jest.fn(), reset: jest.fn(), failBeforeRun: jest.fn() },
    flushPendingProjectSaveWork: jest.fn(), setBusy: jest.fn(),
    plugin: { getStudioService: () => studio }, handleRunEvent: jest.fn(),
    summarizeMessageForNotice: (value: string) => value,
  };
  return { studio, context };
}

describe.each(["studio.process", "studio.script"])("%s approval", kind => {
  let original: boolean;
  beforeEach(() => { original = Platform.isDesktopApp; Platform.isDesktopApp = true; jest.clearAllMocks(); });
  afterEach(() => { Platform.isDesktopApp = original; });

  it("shows the actual command and grants only after approval", async () => {
    (PromptModal as unknown as jest.Mock).mockImplementation(() => ({ openAndWait: async () => ({ confirmed: true }) }));
    const h = harness(kind);
    await runGraph.call(h.context);
    expect(PromptModal).toHaveBeenCalledWith(h.context.app, expect.stringContaining('/usr/local/bin/helper ["capture"]'), expect.objectContaining({ primaryButton: "Approve and run" }));
    expect(h.studio.addCapabilityGrant).toHaveBeenCalledWith(h.context.currentProjectPath, { capability: "cli", scope: { allowedCommandPatterns: ["/usr/local/bin/helper"] }, grantedByUser: true });
    expect(h.studio.runProject).toHaveBeenCalledTimes(1);
  });

  it("does not grant or execute after cancellation", async () => {
    (PromptModal as unknown as jest.Mock).mockImplementation(() => ({ openAndWait: async () => null }));
    const h = harness(kind);
    await runGraph.call(h.context);
    expect(h.studio.addCapabilityGrant).not.toHaveBeenCalled();
    expect(h.studio.runProject).not.toHaveBeenCalled();
    expect(h.context.runPresentation.reset).toHaveBeenCalled();
    expect(h.context.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("reuses existing exact grants without showing another approval", async () => {
    const h = harness(kind);
    h.studio.getProcessApprovalRequests.mockResolvedValue([]);
    await runGraph.call(h.context);
    expect(PromptModal).not.toHaveBeenCalled();
    expect(h.studio.addCapabilityGrant).not.toHaveBeenCalled();
    expect(h.studio.runProject).toHaveBeenCalledTimes(1);
  });

  it("blocks imported process graphs on mobile before approval or execution", async () => {
    Platform.isDesktopApp = false;
    const notice = jest.spyOn(console, "log").mockImplementation(() => {});
    const h = harness(kind);
    await runGraph.call(h.context);
    expect(PromptModal).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(`Notice: Desktop-only nodes: Capture (${kind}).`);
    notice.mockRestore();
    expect(h.studio.getProcessApprovalRequests).not.toHaveBeenCalled();
    expect(h.studio.runProject).not.toHaveBeenCalled();
  });
});
