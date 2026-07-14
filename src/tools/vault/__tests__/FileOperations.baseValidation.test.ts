/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { FileOperations } from "../tools/FileOperations";

describe("FileOperations (.base validation)", () => {
  it("rejects invalid .base YAML on write before creating the file", async () => {
    const app = new App();
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

    const ops = new FileOperations(app, ["/"]);
    const params = {
      path: "Views/Projects.base",
      content: ["filters:", "  - !status", "views:", "  - type: table", "    name: Test"].join("\n"),
    } as any;

    await expect(ops.writeFile(params)).rejects.toMatchObject({ code: "BASE_YAML_INVALID" });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});

