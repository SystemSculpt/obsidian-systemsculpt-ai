/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { CommandManager } from "../commands";
import { displayEmbeddingsTabContent } from "../../../settings/EmbeddingsTabContent";
import { showConfirm } from "../../ui/notifications";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
jest.mock("../../ui/notifications", () => ({
  showConfirm: jest.fn(),
}));
jest.mock("../../../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

const CONFIRMATION = [
  "Replace the current Similar notes index and process eligible vault notes again?",
  {
    title: "Rebuild Similar notes index",
    primaryButton: "Rebuild",
    secondaryButton: "Cancel",
    icon: "alert-triangle",
  },
] as const;

function createPlugin(app: App) {
  const forceRefreshCurrentNamespace = jest.fn().mockResolvedValue(undefined);
  const plugin: any = {
    app,
    addCommand: jest.fn(),
    settings: {
      embeddingsEnabled: true,
      embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: true, respectObsidianExclusions: true },
    },
    getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn() })),
    embeddingsManager: undefined,
    embeddingsStatusBar: undefined,
    getOrCreateEmbeddingsManager: jest.fn(() => ({ forceRefreshCurrentNamespace })),
  };
  return { plugin, forceRefreshCurrentNamespace };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** The command palette entry, run as Obsidian runs a check-callback command. */
async function runCommand(app: App, plugin: any): Promise<void> {
  const manager = new CommandManager(plugin, app);
  (manager as any).registerEmbeddingsDatabaseCommands();
  const command = plugin.addCommand.mock.calls
    .map(([registered]: [{ id: string }]) => registered)
    .find((registered: { id: string }) => registered.id === "rebuild-embeddings-current-model");
  expect(command.checkCallback(true)).toBe(true);
  command.checkCallback(false);
  await settle();
}

/** The Rebuild button in Similar notes settings. */
async function clickSettingsRebuild(app: App, plugin: any): Promise<void> {
  const container = document.createElement("div");
  await displayEmbeddingsTabContent(container, { app, plugin, invalidateSearchIndex: jest.fn() } as any);
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Rebuild");
  expect(button).toBeDefined();
  button!.click();
  await settle();
}

describe.each([
  ["command", runCommand],
  ["settings", clickSettingsRebuild],
])("Similar notes rebuild from %s", (_entry, rebuild) => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("asks the one shared question and replaces nothing when cancelled", async () => {
    const app = new App();
    const { plugin, forceRefreshCurrentNamespace } = createPlugin(app);
    jest.mocked(showConfirm).mockResolvedValue({ confirmed: false });

    await rebuild(app, plugin);

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(showConfirm).toHaveBeenCalledWith(app, ...CONFIRMATION);
    expect(forceRefreshCurrentNamespace).not.toHaveBeenCalled();
  });

  it("rebuilds the index once after confirmation", async () => {
    const app = new App();
    const { plugin, forceRefreshCurrentNamespace } = createPlugin(app);
    jest.mocked(showConfirm).mockResolvedValue({ confirmed: true });

    await rebuild(app, plugin);

    expect(forceRefreshCurrentNamespace).toHaveBeenCalledTimes(1);
    expect(jest.mocked(Notice).mock.calls.map(([message]) => String(message)).join("\n")).not.toMatch(/fail/iu);
  });
});

describe("Similar notes rebuild button in settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("shows progress on the button and finishes without a notice", async () => {
    const app = new App();
    const { plugin, forceRefreshCurrentNamespace } = createPlugin(app);
    let finish!: () => void;
    forceRefreshCurrentNamespace.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    jest.mocked(showConfirm).mockResolvedValue({ confirmed: true });
    const container = document.createElement("div");
    await displayEmbeddingsTabContent(container, { app, plugin, invalidateSearchIndex: jest.fn() } as any);
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Rebuild")!;

    button.click();
    await settle();
    expect(button.textContent).toBe("Rebuilding…");
    expect(button.disabled).toBe(true);

    finish();
    await settle();
    expect(button.textContent).toBe("Rebuild");
    expect(button.disabled).toBe(false);
    expect(Notice).not.toHaveBeenCalled();
  });

  it("keeps a failed rebuild visible because the index may be unavailable", async () => {
    const app = new App();
    const { plugin, forceRefreshCurrentNamespace } = createPlugin(app);
    forceRefreshCurrentNamespace.mockRejectedValue(new Error("disk full"));
    jest.mocked(showConfirm).mockResolvedValue({ confirmed: true });

    await clickSettingsRebuild(app, plugin);

    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith("Failed to rebuild the semantic index: disk full");
  });
});
