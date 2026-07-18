/** @jest-environment jsdom */
import { App, TFile } from "obsidian";
import {
  createLocalCommitReceipt,
  stripLocalCommitMarker,
  verifyLocalCommitReceipt,
} from "../LocalCommitReceipt";

describe("local transcription commit receipts", () => {
  it("verifies an exact output by path and digest", async () => {
    const app = new App();
    const file = new TFile({ path: "Audio/transcript.md" });
    const content = "Clean transcript";
    const receipt = createLocalCommitReceipt(file.path, content);
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockResolvedValue(content);

    await expect(verifyLocalCommitReceipt(app, receipt)).resolves.toEqual({
      file,
      storedContent: content,
    });
  });

  it("rejects missing or changed output instead of treating a plan as a commit", async () => {
    const app = new App();
    const file = new TFile({ path: "Audio/transcript.md" });
    const receipt = createLocalCommitReceipt(file.path, "Original");

    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    await expect(verifyLocalCommitReceipt(app, receipt)).rejects.toThrow("missing");

    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockResolvedValue("Changed");
    await expect(verifyLocalCommitReceipt(app, receipt)).rejects.toThrow("no longer matches");
  });

  it("requires and removes only the operation-owned trailing marker", async () => {
    const app = new App();
    const file = new TFile({ path: "Audio/transcript.md" });
    const marker = "<!-- systemsculpt-transcription:operation-1 -->";
    const content = `Transcript body\n\n${marker}\n`;
    const receipt = createLocalCommitReceipt(file.path, content, marker);
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockResolvedValue(content);

    const verified = await verifyLocalCommitReceipt(app, receipt);
    expect(stripLocalCommitMarker(verified.storedContent, receipt)).toBe("Transcript body");
  });
});
