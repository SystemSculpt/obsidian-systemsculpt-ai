/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { JanitorModal } from "../JanitorModal";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));

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
  afterEach(() => { document.body.empty(); jest.restoreAllMocks(); });

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
    modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="janitor.refresh"]')!.click();
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
    let resolveFirstRead!: (value: string) => void;
    const stale = new TFile({ path: "SystemSculpt/Chats/stale.md", extension: "md", stat: { size: 3 } });
    (app.vault.getFiles as jest.Mock).mockReturnValueOnce([stale]).mockReturnValue([]);
    (app.vault.getAllLoadedFiles as jest.Mock).mockReturnValue([]);
    (app.vault.read as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstRead = resolve;
    }));

    modal.open();
    modal.close();
    modal.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.modalEl.textContent).toContain("No chat history");
    resolveFirstRead("   ");
    await Promise.resolve();
    await Promise.resolve();

    expect(app.vault.getFiles).toHaveBeenCalledTimes(2);
    expect(modal.modalEl.textContent).toContain("No chat history");
    expect(modal.modalEl.textContent).not.toContain("Move 1 chats to Trash");
  });

  it("applies the files actually reviewed, excluding arrivals while confirmation is open", async () => {
    const modal = createHarness();
    await Promise.resolve();
    await Promise.resolve();
    const reviewed = new TFile({ path: "SystemSculpt/Chats/reviewed.md", extension: "md", stat: { size: 2000, mtime: 1 } });
    const sibling = new TFile({ path: "SystemSculpt/Chats-old/keep.md", extension: "md", stat: { size: 2000, mtime: 1 } });
    const files = [reviewed, sibling];
    (modal.app.vault.getFiles as jest.Mock).mockImplementation(() => files);
    (modal.app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path) => files.find((file) => file.path === path) ?? null);
    const trash = jest.fn(async () => undefined);
    (modal.app.fileManager as any).trashFile = trash;
    modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="janitor.refresh"]')!.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const section = [...modal.modalEl.querySelectorAll<HTMLElement>(".ss-janitor-section")].find((element) => element.textContent?.includes("Chat history"))!;
    section.querySelector<HTMLButtonElement>("button")!.click();
    const confirmation = document.querySelector<HTMLElement>(".ss-janitor-confirmation-modal")!;
    expect(confirmation.textContent).toContain(reviewed.path);
    expect(confirmation.textContent).not.toContain(sibling.path);
    files.push(new TFile({ path: "SystemSculpt/Chats/new.md", extension: "md", stat: { size: 2000, mtime: 1 } }));
    confirmation.querySelector<HTMLButtonElement>('[data-testid="janitor.confirm.accept"]')!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(trash).toHaveBeenCalledTimes(1);
    expect(trash).toHaveBeenCalledWith(reviewed);
    modal.close();
  });
});
