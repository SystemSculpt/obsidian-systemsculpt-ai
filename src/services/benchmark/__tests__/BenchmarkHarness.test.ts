import { App, TFile, TFolder } from "obsidian";
import { BenchmarkHarness, buildExpectedSnapshot } from "../BenchmarkHarness";

describe("buildExpectedSnapshot", () => {
  it("applies updates and deletions", () => {
    const fixture = {
      "a.md": "A",
      "b.md": "B",
    };
    const updates = {
      "b.md": "B2",
      "c.md": "C",
      "a.md": null,
    };

    const result = buildExpectedSnapshot(fixture, updates);
    expect(result).toEqual({
      "b.md": "B2",
      "c.md": "C",
    });
  });

  it("returns empty object when all files are deleted", () => {
    const fixture = { "a.md": "A" };
    const updates = { "a.md": null };
    const result = buildExpectedSnapshot(fixture, updates);
    expect(result).toEqual({});
  });

  it("handles empty fixture with additions", () => {
    const fixture = {};
    const updates = { "new.md": "New content" };
    const result = buildExpectedSnapshot(fixture, updates);
    expect(result).toEqual({ "new.md": "New content" });
  });
});

describe("BenchmarkHarness.getSuite", () => {
  it("returns the suite passed to constructor", () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "my-suite", title: "My Suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);
    expect(harness.getSuite()).toBe(suite);
  });
});

describe("BenchmarkHarness.ensureBenchmarkDirs", () => {
  it("creates all required directories", async () => {
    const app = new App();
    const createdFolders: string[] = [];

    app.vault.createFolder = jest.fn(async (path: string) => {
      createdFolders.push(path);
    });
    app.vault.getAbstractFileByPath = jest.fn(() => null);

    const plugin: any = {
      app,
      storage: {
        initialize: jest.fn(),
        getPath: jest.fn((...parts: string[]) => parts.join("/")),
      },
    };

    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    const paths = await harness.ensureBenchmarkDirs("run-123");

    expect(plugin.storage.initialize).toHaveBeenCalled();
    expect(paths.root).toBe("benchmarks/v2");
    expect(paths.active).toBe("benchmarks/v2/active");
    expect(paths.runs).toBe("benchmarks/v2/runs");
    expect(paths.run).toBe("benchmarks/v2/runs/run-123");
  });
});

describe("BenchmarkHarness.writeRunSummary", () => {
  it("writes run summary JSON to run path", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    (app.vault.adapter as any).write = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    const run = {
      runId: "run-456",
      suiteId: "suite",
      modelId: "gpt-4",
      startedAt: "2024-01-01T00:00:00Z",
      cases: [],
    };

    await harness.writeRunSummary("bench/runs/run-456", run as any);

    expect(writes.has("bench/runs/run-456/run.json")).toBe(true);
    const written = JSON.parse(writes.get("bench/runs/run-456/run.json")!);
    expect(written.runId).toBe("run-456");
    expect(written.modelId).toBe("gpt-4");
  });
});

describe("BenchmarkHarness.exportRunReport", () => {
  it("generates markdown report with pass/fail counts", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    app.vault.createFolder = jest.fn();
    app.vault.getAbstractFileByPath = jest.fn(() => null);
    (app.vault.adapter as any).write = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = {
      id: "suite",
      fixture: {},
      cases: [
        { id: "case-1", title: "Test Case 1" },
        { id: "case-2", title: "Test Case 2" },
      ],
    };
    const harness = new BenchmarkHarness(plugin, suite);

    const run = {
      runId: "run-789",
      suiteId: "suite",
      modelId: "claude-3",
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:01:00Z",
      durationMs: 60000,
      cases: [
        { caseId: "case-1", status: "pass", durationMs: 30000 },
        { caseId: "case-2", status: "fail", durationMs: 30000, errors: ["Error 1"], diffs: [{ path: "file.md" }] },
      ],
    };

    const reportPath = await harness.exportRunReport(run as any, "reports");

    expect(reportPath).toBe("reports/bench-run-789.md");
    const content = writes.get(reportPath)!;
    expect(content).toContain("# SystemSculpt Benchmark Report");
    expect(content).toContain("Run ID: run-789");
    expect(content).toContain("Model: claude-3");
    expect(content).toContain("**Result:** 1/2 passed");
    expect(content).toContain("## Test Case 1");
    expect(content).toContain("## Test Case 2");
    expect(content).toContain("Errors: Error 1");
    expect(content).toContain("### Mismatches");
  });

  it("handles run without endedAt or durationMs", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    app.vault.createFolder = jest.fn();
    app.vault.getAbstractFileByPath = jest.fn(() => null);
    (app.vault.adapter as any).write = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    const run = {
      runId: "run-minimal",
      suiteId: "suite",
      modelId: "model",
      startedAt: "2024-01-01T00:00:00Z",
      cases: [],
    };

    await harness.exportRunReport(run as any, "reports");

    const content = writes.get("reports/bench-run-minimal.md")!;
    expect(content).not.toContain("Completed:");
    expect(content).not.toContain("Duration:");
  });
});

describe("BenchmarkHarness.resetActiveSandbox", () => {
  it("clears a file that blocks the active root and recreates the fixture", async () => {
    const app = new App();
    const activeRoot = "bench/active";
    let activeIsFile = true;

    (app.vault.adapter as any).remove = jest.fn(async () => {
      activeIsFile = false;
    });
    (app.vault.adapter as any).exists = jest.fn(async (path: string) => activeIsFile && path === activeRoot);

    app.vault.getAbstractFileByPath = jest.fn((path: string) => {
      if (path === activeRoot && activeIsFile) {
        return new TFile({ path });
      }
      return null;
    });
    app.vault.createFolder = jest.fn(async () => {});
    app.vault.create = jest.fn(async () => {});
    app.vault.modify = jest.fn(async () => {});
    app.vault.getFiles = jest.fn(() => []);

    const plugin: any = {
      app,
      storage: {
        initialize: jest.fn(),
        getPath: jest.fn(),
        ensureDirectory: jest.fn(),
      },
    };

    const suite: any = {
      id: "test-suite",
      title: "Test Suite",
      description: "",
      fixture: {
        "Inbox/Note.md": "Hello",
      },
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    await harness.resetActiveSandbox(activeRoot);

    expect((app.vault.adapter as any).remove).toHaveBeenCalledWith(activeRoot);
    expect(app.vault.createFolder).toHaveBeenCalled();
    expect(app.vault.create).toHaveBeenCalledWith(`${activeRoot}/Inbox/Note.md`, "Hello");
  });
});

describe("BenchmarkHarness.writeCaseArtifacts", () => {
  it("writes result and transcript files", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    (app.vault.adapter as any).write = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });

    const plugin: any = {
      app,
      storage: {
        initialize: jest.fn(),
        getPath: jest.fn(),
        ensureDirectory: jest.fn(),
      },
    };

    const suite: any = {
      id: "test-suite",
      title: "Test Suite",
      description: "",
      fixture: {},
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    await harness.writeCaseArtifacts("bench/runs/123", "case-1", {
      result: { caseId: "case-1", status: "fail", startedAt: "t0" },
      messages: [{ role: "assistant", content: "Hello", reasoning: "Think." }],
    });

    const resultPath = "bench/runs/123/cases/case-1/result.json";
    const transcriptPath = "bench/runs/123/cases/case-1/transcript.json";

    expect(writes.has(resultPath)).toBe(true);
    expect(writes.has(transcriptPath)).toBe(true);

    const transcript = JSON.parse(writes.get(transcriptPath) || "[]");
    expect(transcript[0]?.reasoning).toBe("Think.");
  });
});

describe("BenchmarkHarness.evaluateCase", () => {
  it("ignores blank line differences in the body", async () => {
    const app = new App();

    const plugin: any = {
      app,
      storage: {
        initialize: jest.fn(),
        getPath: jest.fn(),
        ensureDirectory: jest.fn(),
      },
    };

    const expected = `---\ntitle: Atlas Spec\nowner: Dana\n---\n\n## Overview\nAtlas will integrate note capture with search.\n\n## Goals\n- Fast search\n- Offline-first\n\n## Risks\n- Token costs\n`;

    const actual = `---\ntitle: Atlas Spec\nowner: Dana\n---\n\n## Overview\n\nAtlas will integrate note capture with search.\n\n## Goals\n\n- Fast search\n- Offline-first\n\n## Risks\n\n- Token costs\n`;

    const suite: any = {
      id: "test-suite",
      title: "Test Suite",
      description: "",
      fixture: {
        "Projects/Atlas/Spec.md": expected,
      },
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({
      "Projects/Atlas/Spec.md": actual,
    });

    const result = await harness.evaluateCase("bench/active", {
      id: "case-1",
      expectedUpdates: {},
    } as any);

    expect(result.status).toBe("pass");
  });

  it("reports missing files as diffs", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = {
      id: "suite",
      fixture: { "expected.md": "Content" },
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({});

    const result = await harness.evaluateCase("bench/active", {
      id: "case-missing",
      expectedUpdates: {},
    } as any);

    expect(result.status).toBe("fail");
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].path).toBe("expected.md");
    expect(result.diffs[0].actual).toBeNull();
  });

  it("reports extra files as diffs", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({
      "unexpected.md": "Extra content",
    });

    const result = await harness.evaluateCase("bench/active", {
      id: "case-extra",
      expectedUpdates: {},
    } as any);

    expect(result.status).toBe("fail");
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].path).toBe("unexpected.md");
    expect(result.diffs[0].expected).toBeNull();
  });

  it("reports content differences", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = {
      id: "suite",
      fixture: { "file.md": "Expected content" },
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({
      "file.md": "Different content",
    });

    const result = await harness.evaluateCase("bench/active", {
      id: "case-diff",
      expectedUpdates: {},
    } as any);

    expect(result.status).toBe("fail");
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].expected).toBe("Expected content");
    expect(result.diffs[0].actual).toBe("Different content");
    expect(result.diffs[0].diff).toBeDefined();
  });

  it("applies expectedUpdates to fixture", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = {
      id: "suite",
      fixture: { "old.md": "Old", "keep.md": "Keep" },
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({
      "new.md": "New",
      "keep.md": "Keep",
    });

    const result = await harness.evaluateCase("bench/active", {
      id: "case-updates",
      expectedUpdates: { "old.md": null, "new.md": "New" },
    } as any);

    expect(result.status).toBe("pass");
  });

  it("includes timing information", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({});

    const startedAt = "2024-01-01T00:00:00.000Z";
    const result = await harness.evaluateCase("bench/active", {
      id: "case-timing",
      expectedUpdates: {},
    } as any, startedAt);

    expect(result.caseId).toBe("case-timing");
    expect(result.startedAt).toBe(startedAt);
    expect(result.endedAt).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("scores correctness against case-required paths (not full fixture size)", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };

    const fixture: Record<string, string> = { "target.md": "OLD" };
    for (let i = 0; i < 20; i += 1) {
      fixture[`keep-${i}.md`] = `KEEP ${i}`;
    }

    const suite: any = {
      id: "suite",
      version: "v2",
      weights: { correctness: 0.7, efficiency: 0.3 },
      defaultMaxPoints: 10,
      fixture,
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({ ...fixture });

    const result = await harness.evaluateCase("bench/active", {
      id: "case-score-required",
      expectedUpdates: { "target.md": "NEW" },
    } as any);

    expect(result.status).toBe("fail");
    expect(result.pointsEarned).toBeCloseTo(3, 5);
    expect(result.breakdown?.correctnessFraction).toBeCloseTo(0, 5);
    expect(result.scorePercent).toBeCloseTo(30, 5);
  });

  it("penalizes collateral changes even when required updates are correct", async () => {
    const app = new App();
    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };

    const suite: any = {
      id: "suite",
      version: "v2",
      weights: { correctness: 0.7, efficiency: 0.3 },
      defaultMaxPoints: 10,
      fixture: {
        "target.md": "OLD",
        "other.md": "KEEP",
      },
      cases: [],
    };

    const harness = new BenchmarkHarness(plugin, suite);
    jest.spyOn(harness as any, "readSnapshot").mockResolvedValue({
      "target.md": "NEW",
      "other.md": "CHANGED",
    });

    const result = await harness.evaluateCase("bench/active", {
      id: "case-score-collateral",
      expectedUpdates: { "target.md": "NEW" },
    } as any);

    expect(result.status).toBe("fail");
    expect(result.breakdown?.correctnessFraction).toBeCloseTo(0.5, 5);
    expect(result.pointsEarned).toBeCloseTo(6.5, 5);
    expect(result.scorePercent).toBeCloseTo(65, 5);
  });
});

describe("BenchmarkHarness.snapshotActiveCase", () => {
  it("copies files from active root to run case folder", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    app.vault.createFolder = jest.fn();
    app.vault.getAbstractFileByPath = jest.fn(() => null);
    app.vault.getFiles = jest.fn(() => [
      { path: "bench/active/note.md" } as TFile,
      { path: "bench/active/sub/nested.md" } as TFile,
    ]);
    app.vault.read = jest.fn(async (file: TFile) => {
      if (file.path === "bench/active/note.md") return "Note content";
      if (file.path === "bench/active/sub/nested.md") return "Nested content";
      return "";
    });
    app.vault.create = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });
    app.vault.modify = jest.fn();

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    await harness.snapshotActiveCase("bench/active", "bench/runs/run-1", "case-1");

    expect(writes.has("bench/runs/run-1/cases/case-1/vault/note.md")).toBe(true);
    expect(writes.get("bench/runs/run-1/cases/case-1/vault/note.md")).toBe("Note content");
    expect(writes.has("bench/runs/run-1/cases/case-1/vault/sub/nested.md")).toBe(true);
  });
});

describe("BenchmarkHarness.pruneOldRuns", () => {
  it("removes runs beyond the keep limit using adapter", async () => {
    const app = new App();
    const rmdirCalls: string[] = [];
    let listCallCount = 0;

    (app.vault.adapter as any).list = jest.fn(async (path: string) => {
      listCallCount++;
      // Only return folders for the first call (top-level runs dir)
      // Return empty for recursive calls to prevent infinite loop
      if (path === "bench/runs" && listCallCount === 1) {
        return {
          folders: [
            "bench/runs/run-01",
            "bench/runs/run-02",
            "bench/runs/run-03",
            "bench/runs/run-04",
            "bench/runs/run-05",
            "bench/runs/run-06",
            "bench/runs/run-07",
            "bench/runs/run-08",
            "bench/runs/run-09",
            "bench/runs/run-10",
            "bench/runs/run-11",
            "bench/runs/run-12",
          ],
          files: [],
        };
      }
      return { folders: [], files: [] };
    });
    (app.vault.adapter as any).remove = jest.fn();
    (app.vault.adapter as any).rmdir = jest.fn(async (path: string) => {
      rmdirCalls.push(path);
    });

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    await harness.pruneOldRuns("bench/runs");

    // Should keep 10, remove 2 oldest (via rmdir)
    expect(rmdirCalls.length).toBe(2);
    expect(rmdirCalls).toContain("bench/runs/run-01");
    expect(rmdirCalls).toContain("bench/runs/run-02");
  });

  it("handles adapter without list method", async () => {
    const app = new App();
    (app.vault.adapter as any).list = undefined;

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    // Should not throw
    await expect(harness.pruneOldRuns("bench/runs")).resolves.toBeUndefined();
  });
});

describe("BenchmarkHarness folder operations", () => {
  it("handles existing TFolder when ensuring folder", async () => {
    const app = new App();

    app.vault.getAbstractFileByPath = jest.fn((path: string) => {
      if (path === "benchmarks") return new TFolder({ path: "benchmarks" });
      return null;
    });
    app.vault.createFolder = jest.fn();

    const plugin: any = {
      app,
      storage: {
        initialize: jest.fn(),
        getPath: jest.fn((...parts: string[]) => parts.join("/")),
      },
    };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    // Access private method through ensureBenchmarkDirs
    await harness.ensureBenchmarkDirs("run-1");

    // Should not throw
    expect(app.vault.createFolder).toHaveBeenCalled();
  });

  it("handles file blocking folder path", async () => {
    const app = new App();
    let fileRemoved = false;

    app.vault.getAbstractFileByPath = jest.fn((path: string) => {
      if (path === "benchmarks" && !fileRemoved) return new TFile({ path: "benchmarks" });
      return null;
    });
    (app.vault.adapter as any).remove = jest.fn(async () => {
      fileRemoved = true;
    });
    app.vault.createFolder = jest.fn();

    const plugin: any = {
      app,
      storage: {
        initialize: jest.fn(),
        getPath: jest.fn((...parts: string[]) => parts.join("/")),
      },
    };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    // This will try to create "benchmarks/v2" etc.
    await harness.ensureBenchmarkDirs("run-1");

    expect(app.vault.createFolder).toHaveBeenCalled();
  });
});

describe("BenchmarkHarness.writeCaseArtifacts edge cases", () => {
  it("writes result without messages", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    app.vault.createFolder = jest.fn();
    app.vault.getAbstractFileByPath = jest.fn(() => null);
    (app.vault.adapter as any).write = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    await harness.writeCaseArtifacts("bench/runs/run-1", "case-1", {
      result: { caseId: "case-1", status: "pass" },
    });

    expect(writes.has("bench/runs/run-1/cases/case-1/result.json")).toBe(true);
    expect(writes.has("bench/runs/run-1/cases/case-1/transcript.json")).toBe(false);
  });

  it("handles payload without result wrapper", async () => {
    const app = new App();
    const writes = new Map<string, string>();

    app.vault.createFolder = jest.fn();
    app.vault.getAbstractFileByPath = jest.fn(() => null);
    (app.vault.adapter as any).write = jest.fn(async (path: string, content: string) => {
      writes.set(path, content);
    });

    const plugin: any = { app, storage: { initialize: jest.fn(), getPath: jest.fn() } };
    const suite: any = { id: "suite", fixture: {}, cases: [] };
    const harness = new BenchmarkHarness(plugin, suite);

    await harness.writeCaseArtifacts("bench/runs/run-1", "case-2", {
      caseId: "case-2",
      status: "pass",
    } as any);

    const written = JSON.parse(writes.get("bench/runs/run-1/cases/case-2/result.json")!);
    expect(written.caseId).toBe("case-2");
  });
});
