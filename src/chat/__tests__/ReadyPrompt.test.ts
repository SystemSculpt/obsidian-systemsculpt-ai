import type { App, TFile } from "obsidian";
import { insideFolder, latestNote, readyPrompt } from "../ReadyPrompt";
import { firstChatAction } from "../../modals/AccountConnectOutcome";

function file(path: string, mtime: number, size = 1_000): TFile {
  return { path, extension: "md", basename: path.split("/").pop()!.replace(/\.md$/, ""), stat: { mtime, size, ctime: 0 } } as unknown as TFile;
}

function app(files: TFile[]): App {
  return {
    vault: { getMarkdownFiles: () => files },
    metadataCache: { fileToLinktext: (f: TFile) => f.path.replace(/\.md$/, "") },
  } as unknown as App;
}

const own = (path: string) => ["SystemSculpt", "Custom chats", "Templates"].some((folder) => insideFolder(path, folder));

describe("ready prompt (T-5302)", () => {
  it("summarizes the newest qualifying note: not SystemSculpt's, excluded, template, drawing, tiny or huge", () => {
    const vault = app([
      file("Notes/Old.md", 1),
      file("Notes/Trip plan.md", 5),
      file("SystemSculpt/Chats/Chat.md", 9),
      file("custom chats/Chat 2.md", 8),
      file("Templates/Daily.md", 9),
      file("Drawing 1.excalidraw.md", 9),
      file("Daily/2026-11-06.md", 9, 120),
      file("Export.md", 9, 500_000),
    ]);
    expect(latestNote(vault, { isExcluded: own })?.path).toBe("Notes/Trip plan.md");
    expect(readyPrompt(vault, { isExcluded: own })).toBe("Summarize [[Notes/Trip plan]]");
  });

  it("prefers the open note when it qualifies", () => {
    const open = file("Notes/Old.md", 1);
    const vault = app([open, file("Notes/Trip plan.md", 5)]);
    expect(latestNote(vault, { isExcluded: own, openNote: open })?.path).toBe("Notes/Old.md");
    expect(latestNote(vault, { isExcluded: own, openNote: file("SystemSculpt/Chats/Chat.md", 9) })?.path)
      .toBe("Notes/Trip plan.md");
  });

  it("has no prompt for a vault without a qualifying note", () => {
    expect(readyPrompt(app([file("SystemSculpt/Chats/Chat.md", 9)]), { isExcluded: own })).toBeNull();
  });

  it("runs the ready prompt after sign-in, or opens an empty hosted chat", () => {
    const startHostedChat = jest.fn().mockResolvedValue(undefined);
    const ready = firstChatAction({ readyPrompt: () => "Summarize [[Trip plan]]", startHostedChat });
    expect(ready.label).toBe("Summarize my latest note");
    ready.onSelect();
    expect(startHostedChat).toHaveBeenCalledWith({ prompt: "Summarize [[Trip plan]]" });

    const empty = firstChatAction({ readyPrompt: () => null, startHostedChat });
    expect(empty.label).toBe("Start a chat");
    empty.onSelect();
    expect(startHostedChat).toHaveBeenLastCalledWith({});
  });
});
