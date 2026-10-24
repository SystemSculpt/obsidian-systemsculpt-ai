/** @jest-environment jsdom */

import { Notice } from "obsidian";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { composeTextGenerationPromptBundle } from "../systemsculpt-studio-view/StudioPromptBundleComposer";
import { tryCopyToClipboard } from "../../../utils/clipboard";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
jest.mock("../systemsculpt-studio-view/StudioPromptBundleComposer", () => ({
  ...jest.requireActual("../systemsculpt-studio-view/StudioPromptBundleComposer"),
  composeTextGenerationPromptBundle: jest.fn(),
}));
jest.mock("../../../utils/clipboard", () => ({
  ...jest.requireActual("../../../utils/clipboard"),
  tryCopyToClipboard: jest.fn(),
}));

const proto = (SystemSculptStudioView as any).prototype;

function mountedView() {
  const contentEl = document.body.createDiv();
  const root = contentEl.createDiv({ cls: "ss-studio-view" });
  return {
    contentEl,
    root,
    lastError: null as string | null,
    currentProjectPath: "Projects/Flow.systemsculpt",
    normalizeEscapedNewlines: proto.normalizeEscapedNewlines,
    logStudioConsoleError: jest.fn(),
  };
}

describe("SystemSculptStudioView feedback", () => {
  afterEach(() => {
    document.body.empty();
    jest.mocked(Notice).mockClear();
  });

  it("shows an error once, in the view's error line, without a toast", () => {
    const view = mountedView();

    proto.setError.call(view, new Error("The Text node has no prompt."));
    proto.setError.call(view, new Error("The Text node has no prompt."));

    const errors = view.root.querySelectorAll(":scope > .ss-studio-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toBe("The Text node has no prompt.");
    expect(errors[0].getAttribute("role")).toBe("alert");
    expect(view.lastError).toBe("The Text node has no prompt.");
    expect(Notice).not.toHaveBeenCalled();
  });

  it("keeps an error for the next render when the view is not mounted", () => {
    const view = { ...mountedView(), contentEl: document.createElement("div") };

    proto.setError.call(view, "Open a .systemsculpt file from the file explorer first.");

    expect(view.lastError).toBe("Open a .systemsculpt file from the file explorer first.");
    expect(Notice).not.toHaveBeenCalled();
  });

  it.each([
    [true, "Copied"],
    [false, "Couldn't copy"],
  ])("shows a prompt bundle copy result (%s) on the Copy button", async (copied, label) => {
    jest.mocked(composeTextGenerationPromptBundle).mockResolvedValue({ ok: true, markdown: "# Bundle", sourceCount: 2 } as any);
    jest.mocked(tryCopyToClipboard).mockResolvedValue(copied);
    const button = document.body.createEl("button");
    button.createSpan({ cls: "ss-button__label", text: "Copy" });

    await proto.copyTextGenerationPromptBundle.call(
      { currentProject: { graph: { nodes: [] } }, resolvePromptBundleSource: jest.fn() },
      "text-node",
      button,
    );

    expect(tryCopyToClipboard).toHaveBeenCalledWith("# Bundle", button);
    expect(button.textContent).toBe(label);
    expect(Notice).not.toHaveBeenCalled();
  });

  it("locks and unlocks text output without a toast; the node shows the state", () => {
    const node = { id: "text-node", kind: "studio.text_generation", config: { value: "Draft" } as Record<string, unknown> };
    const view = {
      currentProject: { graph: { nodes: [node] } },
      runPresentation: {
        getNodeState: jest.fn(() => ({ outputs: { text: "Draft" } })),
        primeNodeOutput: jest.fn(),
      },
      findNode: (_project: unknown, id: string) => (id === node.id ? node : null),
      commitCurrentProjectMutation: jest.fn((_reason: string, mutate: (project: unknown) => boolean) => mutate(null)),
      render: jest.fn(),
    };

    proto.toggleTextGenerationOutputLock.call(view, "text-node");
    expect(node.config.lockOutput).toBe(true);
    expect(view.runPresentation.primeNodeOutput).toHaveBeenCalledWith("text-node", { text: "Draft" }, { message: "Output locked" });

    proto.toggleTextGenerationOutputLock.call(view, "text-node");
    expect(node.config.lockOutput).toBeUndefined();
    expect(view.render).toHaveBeenCalledTimes(2);
    expect(Notice).not.toHaveBeenCalled();
  });
});
