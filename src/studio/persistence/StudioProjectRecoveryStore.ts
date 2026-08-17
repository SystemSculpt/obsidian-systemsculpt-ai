import type { DataAdapter } from "obsidian";
import { parseStudioProject, serializeStudioProject } from "../schema";
import type { StudioProjectV1 } from "../types";

const STUDIO_RECOVERY_ROOT = ".systemsculpt/studio/recovery";

/**
 * Plugin-owned fallback for canvas work that cannot be written because the
 * visible project file changed first. Recovery is intentionally kept outside
 * the project document and is consumed as a single Undo snapshot on reopen.
 */
export class StudioProjectRecoveryStore {
  constructor(private readonly adapter: DataAdapter) {}

  async save(project: StudioProjectV1): Promise<void> {
    await this.ensureRecoveryRoot();
    // Recovery snapshots are internal machine state: persist the full in-memory
    // model (a valid v1 document) instead of the agent-facing v2 dialect so the
    // policy path, timestamps, and entry IDs come back byte-faithful.
    await this.adapter.write(
      this.recoveryPath(project.projectId),
      `${JSON.stringify(project, null, 2)}\n`
    );
  }

  async consume(
    projectId: string,
    currentProject?: StudioProjectV1
  ): Promise<StudioProjectV1 | null> {
    const path = this.recoveryPath(projectId);
    try {
      const rawText = await this.adapter.read(path);
      const project = parseStudioProject(rawText);
      if (project.projectId !== projectId) {
        return null;
      }
      await this.adapter.remove(path);
      if (currentProject && serializeStudioProject(project) === serializeStudioProject(currentProject)) {
        return null;
      }
      return project;
    } catch {
      return null;
    }
  }

  private recoveryPath(projectId: string): string {
    const safeProjectId = String(projectId || "").replace(/[^A-Za-z0-9_-]/g, "_");
    return `${STUDIO_RECOVERY_ROOT}/${safeProjectId}.json`;
  }

  private async ensureRecoveryRoot(): Promise<void> {
    let current = "";
    for (const segment of STUDIO_RECOVERY_ROOT.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      try {
        await this.adapter.mkdir(current);
      } catch {
        // Existing directories are the normal case after the first recovery.
      }
    }
  }
}
