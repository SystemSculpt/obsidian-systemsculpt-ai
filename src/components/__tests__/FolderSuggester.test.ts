/** @jest-environment jsdom */

import { AbstractInputSuggest, App, TFolder } from "obsidian";
import { attachFolderSuggester } from "../FolderSuggester";

const mockSuggesters: AbstractInputSuggest<string>[] = [];

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    AbstractInputSuggest: class extends actual.AbstractInputSuggest {
      constructor(app: App, input: HTMLInputElement) {
        super(app, input);
        mockSuggesters.push(this as AbstractInputSuggest<string>);
      }
      close = jest.fn();
    },
  };
});

function harness() {
  const app = new App();
  const getAllFolders = jest.fn(() => [
    new TFolder({ path: "/" }),
    new TFolder({ path: "notes" }),
    new TFolder({ path: "notes/Projects" }),
  ]);
  app.vault.getAllFolders = getAllFolders;
  const input = document.body.createEl("input");
  const onSelect = jest.fn();
  attachFolderSuggester(input, onSelect, app);
  return { app, getAllFolders, input, onSelect, suggester: mockSuggesters.at(-1)! };
}

describe("folder suggestions", () => {
  afterEach(() => {
    mockSuggesters.length = 0;
    document.body.empty();
  });

  it("reads folders once for 30 queries and refreshes after refocusing", () => {
    const { app, getAllFolders, input, suggester } = harness();
    input.focus();
    expect(suggester.getSuggestions("")).toEqual(["/", "notes", "notes/Projects"]);
    for (let pass = 0; pass < 30; pass++) {
      expect(suggester.getSuggestions("PROJ")).toEqual(["notes/Projects"]);
    }
    expect(getAllFolders).toHaveBeenCalledTimes(1);
    expect(getAllFolders).toHaveBeenCalledWith(true);
    expect(app.vault.getAllLoadedFiles).not.toHaveBeenCalled();

    getAllFolders.mockReturnValue([new TFolder({ path: "new-folder" })]);
    input.blur();
    input.focus();
    expect(suggester.getSuggestions("")).toEqual(["new-folder"]);
    expect(getAllFolders).toHaveBeenCalledTimes(2);
  });

  it("renders and selects the same path and blurs the input", () => {
    const { input, onSelect, suggester } = harness();
    const row = document.createElement("div");
    suggester.renderSuggestion("notes/Projects", row);
    expect(row.textContent).toBe("notes/Projects");
    input.focus();
    suggester.selectSuggestion("notes/Projects", new MouseEvent("click"));
    expect(input.value).toBe("notes/Projects");
    expect(onSelect).toHaveBeenCalledWith("notes/Projects");
    expect(document.activeElement).not.toBe(input);
  });
});
