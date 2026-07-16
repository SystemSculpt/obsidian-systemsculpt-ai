import type { DataAdapter } from "obsidian";
import { StudioProjectRecoveryStore } from "../persistence/StudioProjectRecoveryStore";
import { createEmptyStudioProject } from "../schema";

describe("StudioProjectRecoveryStore", () => {
  it("stores and consumes a blocked canvas snapshot exactly once", async () => {
    const files = new Map<string, string>();
    const adapter = {
      mkdir: jest.fn(async () => {}),
      write: jest.fn(async (path: string, data: string) => {
        files.set(path, data);
      }),
      read: jest.fn(async (path: string) => {
        const value = files.get(path);
        if (value == null) throw new Error("not found");
        return value;
      }),
      remove: jest.fn(async (path: string) => {
        if (!files.delete(path)) throw new Error("not found");
      }),
    } as unknown as DataAdapter;
    const store = new StudioProjectRecoveryStore(adapter);
    const project = createEmptyStudioProject({
      name: "Canvas version",
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "1.0.0",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });

    await store.save(project);

    await expect(store.consume(project.projectId)).resolves.toEqual(project);
    await expect(store.consume(project.projectId)).resolves.toBeNull();
  });

  it("discards a recovery snapshot that already matches the current project", async () => {
    const files = new Map<string, string>();
    const adapter = {
      mkdir: jest.fn(async () => {}),
      write: jest.fn(async (path: string, data: string) => { files.set(path, data); }),
      read: jest.fn(async (path: string) => {
        const value = files.get(path);
        if (value == null) throw new Error("not found");
        return value;
      }),
      remove: jest.fn(async (path: string) => { files.delete(path); }),
    } as unknown as DataAdapter;
    const store = new StudioProjectRecoveryStore(adapter);
    const project = createEmptyStudioProject({
      name: "Already restored",
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "1.0.0",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });

    await store.save(project);

    await expect(store.consume(project.projectId, project)).resolves.toBeNull();
    await expect(store.consume(project.projectId)).resolves.toBeNull();
  });
});
