jest.mock("obsidian", () => ({
  App: class {},
  TFile: class {
    path: string;
    basename: string;
    extension: string;
    constructor(path: string) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.md$/, "") || "";
      this.extension = "md";
    }
  },
  TFolder: class {
    path: string;
    children: any[];
    constructor(path: string) {
      this.path = path;
      this.children = [];
    }
  },
  parseYaml: jest.fn((str: string) => {
    const result: any = {};
    str.split("\n").forEach((line) => {
      const match = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
      if (match) result[match[1]] = match[2];
    });
    return result;
  }),
}));

import { PromptService, type PromptEntry } from "../PromptService";

describe("PromptService", () => {
  let mockApp: any;
  let mockVault: any;

  beforeEach(() => {
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      createFolder: jest.fn(),
      create: jest.fn(),
    };
    mockApp = { vault: mockVault };
  });

  describe("listPrompts", () => {
    it("returns empty array when folder does not exist", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const prompts = await service.listPrompts();
      expect(prompts).toEqual([]);
    });

    it("returns prompt entries from markdown files in folder", async () => {
      const mockFolder = {
        path: "SystemSculpt/Prompts",
        children: [
          { path: "SystemSculpt/Prompts/Python Expert.md", basename: "Python Expert", extension: "md" },
          { path: "SystemSculpt/Prompts/Concise.md", basename: "Concise", extension: "md" },
          { path: "SystemSculpt/Prompts/subfolder", extension: undefined },
        ],
      };
      mockVault.getAbstractFileByPath.mockReturnValue(mockFolder);
      mockVault.read.mockResolvedValue("---\ndescription: A prompt\nicon: code\n---\nPrompt body");

      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const prompts = await service.listPrompts();

      expect(prompts).toHaveLength(2);
      expect(prompts[0].name).toBe("Concise");
      expect(prompts[1].name).toBe("Python Expert");
    });
  });

  describe("readPromptContent", () => {
    it("returns the body text without frontmatter", async () => {
      const mockFile = { path: "SystemSculpt/Prompts/Test.md", basename: "Test", extension: "md" };
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue("---\ndescription: desc\n---\nYou are a helpful assistant.");

      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const content = await service.readPromptContent("SystemSculpt/Prompts/Test.md");
      expect(content).toBe("You are a helpful assistant.");
    });

    it("returns null for nonexistent file", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const content = await service.readPromptContent("nope.md");
      expect(content).toBeNull();
    });
  });

  describe("ensureFolder", () => {
    it("creates the folder if it does not exist", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      await service.ensureFolder();
      expect(mockVault.createFolder).toHaveBeenCalledWith("SystemSculpt/Prompts");
    });

    it("does nothing if folder exists", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue({ path: "SystemSculpt/Prompts" });
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      await service.ensureFolder();
      expect(mockVault.createFolder).not.toHaveBeenCalled();
    });
  });
});
