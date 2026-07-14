/** @jest-environment jsdom */

import { App } from "obsidian";
import { JanitorModal } from "../JanitorModal";

function createHarness() {
  const app = new App();
  (app.vault.getFiles as jest.Mock).mockReturnValue([]);
  (app.vault.getAllLoadedFiles as jest.Mock).mockReturnValue([]);
  const plugin = {
    settings: {
      chatsDirectory: "SystemSculpt/Chats",
      extractionsDirectory: "SystemSculpt/Extractions",
      recordingsDirectory: "SystemSculpt/Recordings",
    },
  };
  const modal = new JanitorModal(app, plugin as any);
  modal.open();
  return modal;
}

describe("JanitorModal", () => {
  afterEach(() => document.body.empty());

  it("uses the modal surface and semantic loading state", () => {
    const modal = createHarness();

    expect(modal.modalEl.getAttribute("data-ss-surface")).toBe("modal");
    expect(modal.modalEl.querySelector(".ss-ui-state.is-loading")?.textContent)
      .toContain("Scanning vault");
    expect(modal.modalEl.querySelector(".ss-janitor-main")?.hasAttribute("hidden"))
      .toBe(true);
  });

  it("renders the four cleanup modules with canonical disabled actions", async () => {
    const modal = createHarness();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.modalEl.querySelectorAll(".ss-janitor-section")).toHaveLength(4);
    const actions = [...modal.modalEl.querySelectorAll<HTMLButtonElement>(".ss-janitor-action")];
    expect(actions).toHaveLength(4);
    expect(actions.every((action) => action.disabled)).toBe(true);
    expect(actions.every((action) => action.classList.contains("ss-button"))).toBe(true);
    expect(modal.modalEl.querySelector(".ss-disabled")).toBeNull();
    expect(modal.modalEl.textContent).toContain("Nothing to remove");
  });

  it("replaces loading with an actionable error state when scanning fails", async () => {
    const modal = createHarness();
    await Promise.resolve();
    await Promise.resolve();
    (modal.app.vault.getFiles as jest.Mock).mockImplementation(() => {
      throw new Error("scan failed");
    });
    (modal as any).refreshData();
    await Promise.resolve();
    await Promise.resolve();

    const error = modal.modalEl.querySelector(".ss-ui-state.is-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("Couldn’t scan vault");
    expect(error?.querySelector("button")?.textContent).toContain("Retry");
  });

  it("ignores a stale scan after the modal closes and reopens", async () => {
    const app = new App();
    const plugin = {
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        extractionsDirectory: "SystemSculpt/Extractions",
        recordingsDirectory: "SystemSculpt/Recordings",
      },
    };
    const modal = new JanitorModal(app, plugin as any);
    let resolveFirstScan!: (value: unknown) => void;
    const staleData = {
      emptyFiles: [],
      emptyFolders: [],
      chatFiles: [{ path: "SystemSculpt/Chats/stale.md", stat: { size: 3 } }],
      extractionFiles: [],
      recordingFiles: [],
      sizes: {
        empty: "empty",
        chat: "3 bytes",
        extraction: "empty",
        recording: "empty",
      },
      stats: {
        emptyFileCount: 0,
        emptyFolderCount: 0,
        totalEmptyCount: 0,
      },
    };
    const freshData = {
      ...staleData,
      chatFiles: [],
      sizes: { ...staleData.sizes, chat: "empty" },
    };
    const scanVault = jest
      .spyOn(modal as any, "scanVault")
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstScan = resolve;
      }))
      .mockResolvedValueOnce(freshData);

    modal.open();
    modal.close();
    modal.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.modalEl.textContent).toContain("No chat history");
    resolveFirstScan(staleData);
    await Promise.resolve();
    await Promise.resolve();

    expect(scanVault).toHaveBeenCalledTimes(2);
    expect(modal.modalEl.textContent).toContain("No chat history");
    expect(modal.modalEl.textContent).not.toContain("Move 1 chats to Trash");
  });
});
