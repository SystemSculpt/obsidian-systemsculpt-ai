/**
 * @jest-environment node
 */
import type {
  FileReadMetadata,
  FileInfo,
  DirectoryInfo,
  ToolResult,
  FileOperationResult,
  MoveOperationResult,
  ContextManagementResult,
  WorkspaceManagementResult,
  DuplicateSearchResult,
  ReadFilesParams,
  WriteFileParams,
  FileEditRange,
  FileEdit,
  EditFileParams,
  CreateDirectoriesParams,
  ListDirectoriesParams,
  MoveItemsParams,
  TrashFilesParams,
  FindFilesParams,
  GrepVaultParams,
  ManageWorkspaceParams,
  ManageContextParams,
} from "../types";

describe("MCP Filesystem Types", () => {
  describe("FileReadMetadata", () => {
    it("can create complete metadata", () => {
      const meta: FileReadMetadata = {
        fileSize: 1024,
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-02T00:00:00Z",
        windowStart: 0,
        windowEnd: 500,
        hasMore: true,
      };

      expect(meta.fileSize).toBe(1024);
      expect(meta.hasMore).toBe(true);
    });

    it("hasMore can be false", () => {
      const meta: FileReadMetadata = {
        fileSize: 100,
        created: "2024-01-01",
        modified: "2024-01-01",
        windowStart: 0,
        windowEnd: 100,
        hasMore: false,
      };

      expect(meta.hasMore).toBe(false);
    });
  });

  describe("FileInfo", () => {
    it("can create file info", () => {
      const file: FileInfo = {
        name: "test.md",
        size: 2048,
        created: "2024-01-01",
        modified: "2024-01-15",
        extension: "md",
      };

      expect(file.name).toBe("test.md");
      expect(file.extension).toBe("md");
    });

    it("can have optional preview", () => {
      const file: FileInfo = {
        name: "doc.txt",
        size: 512,
        created: "2024-01-01",
        modified: "2024-01-01",
        extension: "txt",
        preview: "First line of content...",
      };

      expect(file.preview).toBe("First line of content...");
    });
  });

  describe("DirectoryInfo", () => {
    it("can create directory info", () => {
      const dir: DirectoryInfo = {
        name: "Documents",
        itemCount: 15,
      };

      expect(dir.name).toBe("Documents");
      expect(dir.itemCount).toBe(15);
    });

    it("can have optional modified date", () => {
      const dir: DirectoryInfo = {
        name: "Projects",
        itemCount: 5,
        modified: "2024-03-01",
      };

      expect(dir.modified).toBe("2024-03-01");
    });
  });

  describe("ToolResult", () => {
    it("can be successful", () => {
      const result: ToolResult = { success: true };
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("can be failure with error", () => {
      const result: ToolResult = {
        success: false,
        error: "File not found",
      };
      expect(result.success).toBe(false);
      expect(result.error).toBe("File not found");
    });
  });

  describe("FileOperationResult", () => {
    it("extends ToolResult with path", () => {
      const result: FileOperationResult = {
        success: true,
        path: "/documents/file.md",
      };

      expect(result.path).toBe("/documents/file.md");
    });
  });

  describe("MoveOperationResult", () => {
    it("has source and destination", () => {
      const result: MoveOperationResult = {
        success: true,
        source: "/old/path.md",
        destination: "/new/path.md",
      };

      expect(result.source).toBe("/old/path.md");
      expect(result.destination).toBe("/new/path.md");
    });
  });

  describe("ContextManagementResult", () => {
    it("can create complete result", () => {
      const result: ContextManagementResult = {
        action: "add",
        processed: 3,
        results: [
          { path: "/file1.md", success: true },
          { path: "/file2.md", success: false, reason: "Not found" },
          { path: "/file3.md", success: true },
        ],
        summary: "Added 2 of 3 files",
      };

      expect(result.action).toBe("add");
      expect(result.processed).toBe(3);
      expect(result.results.length).toBe(3);
    });
  });

  describe("WorkspaceManagementResult", () => {
    it("can have opened files and errors", () => {
      const result: WorkspaceManagementResult = {
        opened: ["/file1.md", "/file2.md"],
        errors: ["Could not open /file3.md"],
      };

      expect(result.opened.length).toBe(2);
      expect(result.errors.length).toBe(1);
    });
  });

  describe("DuplicateSearchResult", () => {
    it("groups duplicate sets", () => {
      const result: DuplicateSearchResult = {
        duplicate_sets: [
          ["/folder1/file.md", "/folder2/file.md"],
          ["/a/doc.txt", "/b/doc.txt", "/c/doc.txt"],
        ],
      };

      expect(result.duplicate_sets.length).toBe(2);
      expect(result.duplicate_sets[1].length).toBe(3);
    });
  });

  describe("ReadFilesParams", () => {
    it("requires paths array", () => {
      const params: ReadFilesParams = {
        paths: ["/file1.md", "/file2.md"],
      };

      expect(params.paths.length).toBe(2);
    });

    it("can have optional offset and length", () => {
      const params: ReadFilesParams = {
        paths: ["/large-file.md"],
        offset: 1000,
        length: 500,
      };

      expect(params.offset).toBe(1000);
      expect(params.length).toBe(500);
    });

    it("offset and length can be null", () => {
      const params: ReadFilesParams = {
        paths: ["/file.md"],
        offset: null,
        length: null,
      };

      expect(params.offset).toBeNull();
    });
  });

  describe("WriteFileParams", () => {
    it("requires path and content", () => {
      const params: WriteFileParams = {
        path: "/new-file.md",
        content: "# New File\n\nContent here",
      };

      expect(params.path).toBe("/new-file.md");
      expect(params.content).toContain("New File");
    });

    it("can have all optional parameters", () => {
      const params: WriteFileParams = {
        path: "/file.md",
        content: "Content",
        createDirs: true,
        ifExists: "append",
        appendNewline: true,
      };

      expect(params.createDirs).toBe(true);
      expect(params.ifExists).toBe("append");
      expect(params.appendNewline).toBe(true);
    });

    it("ifExists can be various values", () => {
      const values: WriteFileParams["ifExists"][] = [
        "overwrite",
        "skip",
        "error",
        "append",
        null,
      ];

      values.forEach((val) => {
        const params: WriteFileParams = {
          path: "/f.md",
          content: "",
          ifExists: val,
        };
        expect(params.ifExists).toBe(val);
      });
    });
  });

  describe("FileEdit", () => {
    it("requires oldText and newText", () => {
      const edit: FileEdit = {
        oldText: "old content",
        newText: "new content",
      };

      expect(edit.oldText).toBe("old content");
      expect(edit.newText).toBe("new content");
    });

    it("can use regex mode", () => {
      const edit: FileEdit = {
        oldText: "\\d+",
        newText: "NUMBER",
        isRegex: true,
        flags: "g",
      };

      expect(edit.isRegex).toBe(true);
      expect(edit.flags).toBe("g");
    });

    it("can specify occurrence", () => {
      const occurrences: FileEdit["occurrence"][] = ["first", "last", "all", null];

      occurrences.forEach((occ) => {
        const edit: FileEdit = {
          oldText: "x",
          newText: "y",
          occurrence: occ,
        };
        expect(edit.occurrence).toBe(occ);
      });
    });

    it("can have range constraints", () => {
      const edit: FileEdit = {
        oldText: "text",
        newText: "replacement",
        range: {
          startLine: 10,
          endLine: 20,
        },
      };

      expect(edit.range?.startLine).toBe(10);
      expect(edit.range?.endLine).toBe(20);
    });
  });

  describe("EditFileParams", () => {
    it("can have multiple edits", () => {
      const params: EditFileParams = {
        path: "/file.md",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      };

      expect(params.edits.length).toBe(2);
    });

    it("can be strict", () => {
      const params: EditFileParams = {
        path: "/file.md",
        edits: [{ oldText: "x", newText: "y" }],
        strict: true,
      };

      expect(params.strict).toBe(true);
    });
  });

  describe("ListDirectoriesParams", () => {
    it("requires paths", () => {
      const params: ListDirectoriesParams = {
        paths: ["/folder1", "/folder2"],
      };

      expect(params.paths.length).toBe(2);
    });

    it("can filter by type", () => {
      const filters: ListDirectoriesParams["filter"][] = [
        "all",
        "files",
        "directories",
        null,
      ];

      filters.forEach((f) => {
        const params: ListDirectoriesParams = {
          paths: ["/"],
          filter: f,
        };
        expect(params.filter).toBe(f);
      });
    });

    it("can use semantic filter", () => {
      const params: ListDirectoriesParams = {
        paths: ["/"],
        filter: { semantic: "documents about testing" },
      };

      expect((params.filter as { semantic: string }).semantic).toBe("documents about testing");
    });

    it("can sort by various fields", () => {
      const sorts: ListDirectoriesParams["sort"][] = [
        "modified",
        "size",
        "name",
        "created",
        null,
      ];

      sorts.forEach((s) => {
        const params: ListDirectoriesParams = {
          paths: ["/"],
          sort: s,
        };
        expect(params.sort).toBe(s);
      });
    });
  });

  describe("FindFilesParams", () => {
    it("requires patterns", () => {
      const params: FindFilesParams = {
        patterns: ["*.md", "*.txt"],
      };

      expect(params.patterns.length).toBe(2);
    });

    it("can use different search modes", () => {
      const modes: FindFilesParams["mode"][] = [
        "keyword",
        "semantic",
        "hybrid",
        "graph",
        "smart",
      ];

      modes.forEach((m) => {
        const params: FindFilesParams = {
          patterns: ["test"],
          mode: m,
        };
        expect(params.mode).toBe(m);
      });
    });

    it("can limit results", () => {
      const params: FindFilesParams = {
        patterns: ["*.md"],
        maxResults: 50,
      };

      expect(params.maxResults).toBe(50);
    });
  });

  describe("GrepVaultParams", () => {
    it("requires patterns", () => {
      const params: GrepVaultParams = {
        patterns: ["TODO", "FIXME"],
      };

      expect(params.patterns.length).toBe(2);
    });

    it("can configure context size", () => {
      const sizes: GrepVaultParams["contextSize"][] = ["small", "medium", "large"];

      sizes.forEach((s) => {
        const params: GrepVaultParams = {
          patterns: ["test"],
          contextSize: s,
        };
        expect(params.contextSize).toBe(s);
      });
    });

    it("can search in different scopes", () => {
      const scopes: GrepVaultParams["searchIn"][] = [
        "content",
        "frontmatter",
        "both",
        null,
      ];

      scopes.forEach((s) => {
        const params: GrepVaultParams = {
          patterns: ["test"],
          searchIn: s,
        };
        expect(params.searchIn).toBe(s);
      });
    });
  });

  describe("ManageContextParams", () => {
    it("can add paths", () => {
      const params: ManageContextParams = {
        action: "add",
        paths: ["/file1.md", "/file2.md"],
      };

      expect(params.action).toBe("add");
      expect(params.paths.length).toBe(2);
    });

    it("can remove paths", () => {
      const params: ManageContextParams = {
        action: "remove",
        paths: ["/file.md"],
      };

      expect(params.action).toBe("remove");
    });
  });
});
