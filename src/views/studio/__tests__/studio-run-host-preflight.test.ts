/**
 * @jest-environment jsdom
 */
import { Platform } from "obsidian";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidian = require("obsidian");

const runGraph = (SystemSculptStudioView as any).prototype.runGraph;

describe("SystemSculptStudioView runGraph host preflight", () => {
  const platform = Platform as typeof Platform & { isDesktopApp: boolean };
  let previousDesktopApp: boolean;
  let noticeSpy: jest.SpyInstance;

  beforeEach(() => {
    previousDesktopApp = platform.isDesktopApp;
    platform.isDesktopApp = false;
    noticeSpy = jest
      .spyOn(obsidian as any, "Notice")
      .mockImplementation(function noticeStub() {
        return {};
      } as any);
  });

  afterEach(() => {
    platform.isDesktopApp = previousDesktopApp;
    noticeSpy.mockRestore();
  });

  it("blocks mobile runs before runtime startup when desktop-only nodes are in scope", async () => {
    const scopedProject = {
      graph: {
        nodes: [
          { id: "dataset_node", kind: "studio.dataset", title: "Local Dataset" },
          { id: "input_node", kind: "studio.input", title: "Portable Input" },
          { id: "cli_node", kind: "studio.cli_command", title: "Shell Step" },
        ],
      },
    };
    const runProject = jest.fn();
    const runProjectFromNode = jest.fn();
    const context = {
      currentProjectPath: "SystemSculpt/Studio/Mobile Test.systemsculpt",
      removePendingManagedOutputPlaceholders: jest.fn(() => false),
      render: jest.fn(),
      collectRunScope: jest.fn(() => ({
        scopedProject,
        errors: [],
      })),
      findNodeDefinition: jest.fn((node) => {
        if (node.kind === "studio.dataset" || node.kind === "studio.cli_command") {
          return { kind: node.kind, requiredHostCapabilities: ["local-cli"] };
        }
        return { kind: node.kind, requiredHostCapabilities: [] };
      }),
      setError: jest.fn(),
      runPresentation: {
        beginRun: jest.fn(),
        failBeforeRun: jest.fn(),
      },
      flushPendingProjectSaveWork: jest.fn(),
      setBusy: jest.fn(),
      plugin: {
        getStudioService: jest.fn(() => ({
          runProject,
          runProjectFromNode,
        })),
      },
      handleRunEvent: jest.fn(),
      summarizeMessageForNotice: jest.fn((message: string) => message),
    };

    await runGraph.call(context);

    expect(noticeSpy).toHaveBeenCalledWith(
      "Desktop-only nodes: Local Dataset (studio.dataset), Shell Step (studio.cli_command)."
    );
    expect(context.runPresentation.beginRun).not.toHaveBeenCalled();
    expect(context.flushPendingProjectSaveWork).not.toHaveBeenCalled();
    expect(context.setBusy).not.toHaveBeenCalled();
    expect(context.plugin.getStudioService).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
    expect(runProjectFromNode).not.toHaveBeenCalled();
  });
});
