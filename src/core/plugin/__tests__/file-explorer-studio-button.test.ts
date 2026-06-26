/** @jest-environment jsdom */

import { App, TFile, setIcon } from "obsidian";
import {
  FILE_EXPLORER_STUDIO_BUTTON_CLASS,
  FileExplorerStudioButtonManager,
} from "../FileExplorerStudioButtonManager";

let mockSupportsDesktopOnlyFeatures = true;

jest.mock("../../../services/PlatformContext", () => ({
  PlatformContext: {
    get: () => ({
      supportsDesktopOnlyFeatures: () => mockSupportsDesktopOnlyFeatures,
    }),
  },
}));

function appendExplorer(options?: {
  activeFolderPath?: string;
  activeFilePath?: string;
}): HTMLElement {
  const leaf = document.body.createDiv({ cls: "workspace-leaf-content" });
  leaf.dataset.type = "file-explorer";

  const header = leaf.createDiv({ cls: "nav-header" });
  const buttons = header.createDiv({ cls: "nav-buttons-container" });
  buttons.createDiv({ cls: "clickable-icon nav-action-button" }).setAttr("aria-label", "New note");
  buttons.createDiv({ cls: "clickable-icon nav-action-button" }).setAttr("aria-label", "New folder");

  const files = leaf.createDiv({ cls: "nav-files-container" });
  if (options?.activeFolderPath !== undefined) {
    files
      .createDiv({ cls: "nav-folder-title is-active" })
      .setAttr("data-path", options.activeFolderPath);
  }
  if (options?.activeFilePath !== undefined) {
    files
      .createDiv({ cls: "nav-file-title is-active" })
      .setAttr("data-path", options.activeFilePath);
  }

  return buttons;
}

function createHarness(options?: { activeFile?: TFile | null }) {
  const app = new App();
  (app.workspace.getActiveFile as jest.Mock).mockReturnValue(options?.activeFile ?? null);

  const createProject = jest.fn().mockResolvedValue({ name: "New Studio Project" });
  const getCurrentProjectPath = jest
    .fn()
    .mockReturnValue("Projects/New Studio Project.systemsculpt");
  const activateSystemSculptStudioView = jest.fn().mockResolvedValue(undefined);

  const plugin = {
    app,
    getStudioService: jest.fn(() => ({
      createProject,
      getCurrentProjectPath,
    })),
    getViewManager: jest.fn(() => ({
      activateSystemSculptStudioView,
    })),
  };

  const manager = new FileExplorerStudioButtonManager(plugin as any);

  return {
    app,
    manager,
    createProject,
    getCurrentProjectPath,
    activateSystemSculptStudioView,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FileExplorerStudioButtonManager", () => {
  beforeEach(() => {
    document.body.empty();
    jest.clearAllMocks();
    mockSupportsDesktopOnlyFeatures = true;
  });

  it("adds one native New Studio action beside New note in the file explorer header", () => {
    const buttons = appendExplorer();
    const { manager } = createHarness();

    manager.syncButtons();
    manager.syncButtons();

    const studioButtons = buttons.querySelectorAll(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`);
    const newNoteButton = buttons.querySelector<HTMLElement>('[aria-label="New note"]');
    const newFolderButton = buttons.querySelector<HTMLElement>('[aria-label="New folder"]');
    const studioButton = studioButtons[0] as HTMLElement;

    expect(studioButtons).toHaveLength(1);
    expect(studioButton.classList.contains("clickable-icon")).toBe(true);
    expect(studioButton.classList.contains("nav-action-button")).toBe(true);
    expect(studioButton.getAttribute("aria-label")).toBe("New Studio");
    expect(studioButton.getAttribute("data-tooltip-position")).toBe("bottom");
    expect(newNoteButton?.nextElementSibling).toBe(studioButton);
    expect(studioButton.nextElementSibling).toBe(newFolderButton);
    expect(setIcon).toHaveBeenCalledWith(studioButton, "workflow");
  });

  it("creates and opens a Studio project in the active explorer folder", async () => {
    const buttons = appendExplorer({ activeFolderPath: "Projects" });
    const { manager, createProject, activateSystemSculptStudioView } = createHarness();

    manager.syncButtons();
    buttons
      .querySelector<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(createProject).toHaveBeenCalledWith({
      name: "New Studio Project",
      projectPath: "Projects/New Studio Project.systemsculpt",
    });
    expect(activateSystemSculptStudioView).toHaveBeenCalledWith(
      "Projects/New Studio Project.systemsculpt"
    );
  });

  it("falls back to the active file parent when the explorer has no active folder", async () => {
    const buttons = appendExplorer();
    const { manager, createProject } = createHarness({
      activeFile: new TFile({ path: "Clients/Brief.md" }),
    });

    manager.syncButtons();
    buttons
      .querySelector<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(createProject).toHaveBeenCalledWith({
      name: "New Studio Project",
      projectPath: "Clients/New Studio Project.systemsculpt",
    });
  });

  it("creates a Studio project beside the active explorer file", async () => {
    const buttons = appendExplorer({ activeFilePath: "Selected/Brief.md" });
    const { manager, createProject } = createHarness({
      activeFile: new TFile({ path: "Workspace/Other.md" }),
    });

    manager.syncButtons();
    buttons
      .querySelector<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(createProject).toHaveBeenCalledWith({
      name: "New Studio Project",
      projectPath: "Selected/New Studio Project.systemsculpt",
    });
  });

  it("does not add the explorer action on non-desktop surfaces", () => {
    mockSupportsDesktopOnlyFeatures = false;
    const buttons = appendExplorer();
    const { manager } = createHarness();

    manager.syncButtons();

    expect(buttons.querySelector(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`)).toBeNull();
  });
});
