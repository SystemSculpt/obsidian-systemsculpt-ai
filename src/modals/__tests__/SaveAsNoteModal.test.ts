/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { SaveAsNoteModal } from "../SaveAsNoteModal";

// Mock attachFolderSuggester
jest.mock("../../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

describe("SaveAsNoteModal", () => {
  let app: App;
  let plugin: any;
  let modal: SaveAsNoteModal;
  let onSaveSuccess: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    plugin = {
      settings: {},
      directoryManager: {
        ensureDirectoryByPath: jest.fn().mockResolvedValue(undefined),
      },
      app,
      updateLastSaveAsNoteFolder: jest.fn().mockResolvedValue(undefined),
    };
    onSaveSuccess = jest.fn();
    modal = new SaveAsNoteModal(
      app,
      plugin,
      "Notes/Chats",
      "My Note",
      "Note content here",
      onSaveSuccess
    );
  });

  describe("initialization", () => {
    it("stores plugin reference", () => {
      expect((modal as any).plugin).toBe(plugin);
    });

    it("stores default folder", () => {
      expect((modal as any).defaultFolder).toBe("Notes/Chats");
    });

    it("stores default file name", () => {
      expect((modal as any).defaultFileName).toBe("My Note");
    });

    it("stores content", () => {
      expect((modal as any).content).toBe("Note content here");
    });

    it("stores onSaveSuccess callback", () => {
      expect((modal as any).onSaveSuccess).toBe(onSaveSuccess);
    });
  });

  describe("onOpen", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("empties content element first", () => {
      // Open twice to verify empty is called
      modal.onOpen();
      const h2Elements = modal.contentEl.querySelectorAll("h2");
      expect(h2Elements.length).toBe(1);
    });

    it("creates title", () => {
      const h2 = modal.contentEl.querySelector("h2");
      expect(h2?.textContent).toBe("Save as Note");
    });

    it("creates description", () => {
      const p = modal.contentEl.querySelector("p");
      expect(p?.textContent).toBe("Choose a location and name for your note");
    });

    it("creates folder label", () => {
      const labels = modal.contentEl.querySelectorAll("label");
      const folderLabel = Array.from(labels).find((l) => l.textContent === "Folder");
      expect(folderLabel).toBeDefined();
    });

    it("creates folder input with default value", () => {
      const folderInput = (modal as any).folderInput as HTMLInputElement;
      expect(folderInput).toBeDefined();
      expect(folderInput.value).toBe("Notes/Chats");
    });

    it("creates file name label", () => {
      const labels = modal.contentEl.querySelectorAll("label");
      const fileNameLabel = Array.from(labels).find((l) => l.textContent === "File name");
      expect(fileNameLabel).toBeDefined();
    });

    it("creates file name input with default value", () => {
      const fileNameInput = (modal as any).fileNameInput as HTMLInputElement;
      expect(fileNameInput).toBeDefined();
      expect(fileNameInput.value).toBe("My Note");
    });

    it("creates button container", () => {
      const buttonContainer = modal.contentEl.querySelector(".modal-button-container");
      expect(buttonContainer).not.toBeNull();
    });

    it("creates cancel button", () => {
      const cancelBtn = (modal as any).cancelButton as HTMLButtonElement;
      expect(cancelBtn).toBeDefined();
      expect(cancelBtn.textContent).toBe("Cancel");
    });

    it("creates save button", () => {
      const saveBtn = (modal as any).saveButton as HTMLButtonElement;
      expect(saveBtn).toBeDefined();
      expect(saveBtn.textContent).toBe("Save");
    });

    it("save button has mod-cta class", () => {
      const saveBtn = (modal as any).saveButton as HTMLButtonElement;
      expect(saveBtn.classList.contains("mod-cta")).toBe(true);
    });
  });

  describe("cancel button", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("closes modal when clicked", () => {
      const closeSpy = jest.spyOn(modal, "close");
      const cancelBtn = (modal as any).cancelButton as HTMLButtonElement;
      cancelBtn.click();

      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe("input validation logic", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("folder input exists and can be modified", () => {
      const folderInput = (modal as any).folderInput as HTMLInputElement;
      folderInput.value = "NewFolder";
      expect(folderInput.value).toBe("NewFolder");
    });

    it("file name input exists and can be modified", () => {
      const fileNameInput = (modal as any).fileNameInput as HTMLInputElement;
      fileNameInput.value = "New File Name";
      expect(fileNameInput.value).toBe("New File Name");
    });

    it("folder input is full width", () => {
      const folderInput = (modal as any).folderInput as HTMLInputElement;
      expect(folderInput.style.width).toBe("100%");
    });

    it("file name input is full width", () => {
      const fileNameInput = (modal as any).fileNameInput as HTMLInputElement;
      expect(fileNameInput.style.width).toBe("100%");
    });

    it("folder input is an input element", () => {
      const folderInput = (modal as any).folderInput as HTMLInputElement;
      expect(folderInput.tagName.toLowerCase()).toBe("input");
    });

    it("file name input is an input element", () => {
      const fileNameInput = (modal as any).fileNameInput as HTMLInputElement;
      expect(fileNameInput.tagName.toLowerCase()).toBe("input");
    });
  });

  describe("button container styling", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("button container has flex display", () => {
      const buttonContainer = modal.contentEl.querySelector(".modal-button-container") as HTMLElement;
      expect(buttonContainer?.style.display).toBe("flex");
    });

    it("button container has flex-end justification", () => {
      const buttonContainer = modal.contentEl.querySelector(".modal-button-container") as HTMLElement;
      expect(buttonContainer?.style.justifyContent).toBe("flex-end");
    });

    it("button container has gap", () => {
      const buttonContainer = modal.contentEl.querySelector(".modal-button-container") as HTMLElement;
      expect(buttonContainer?.style.gap).toBe("10px");
    });

    it("button container has top margin", () => {
      const buttonContainer = modal.contentEl.querySelector(".modal-button-container") as HTMLElement;
      expect(buttonContainer?.style.marginTop).toBe("20px");
    });
  });

  describe("without onSaveSuccess callback", () => {
    it("can be created without callback", () => {
      const modalWithoutCallback = new SaveAsNoteModal(app, plugin, "Notes", "Test", "content");
      expect((modalWithoutCallback as any).onSaveSuccess).toBeUndefined();
    });
  });
});
