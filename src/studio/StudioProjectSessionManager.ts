import { normalizeStudioProjectPath } from "./paths";
import { StudioProjectSession } from "./StudioProjectSession";

export type StudioProjectSessionManagerEntry = {
  path: string;
  session: StudioProjectSession;
  retainCount: number;
};

export class StudioProjectSessionManager {
  private readonly entriesByPath = new Map<string, StudioProjectSessionManagerEntry>();

  getSession(projectPath: string): StudioProjectSession | null {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) {
      return null;
    }
    return this.entriesByPath.get(normalized)?.session || null;
  }

  getRetainCount(projectPath: string): number {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) {
      return 0;
    }
    return this.entriesByPath.get(normalized)?.retainCount || 0;
  }

  listOpenSessions(): StudioProjectSessionManagerEntry[] {
    return Array.from(this.entriesByPath.values()).map((entry) => ({
      path: entry.path,
      session: entry.session,
      retainCount: entry.retainCount,
    }));
  }

  async retainSession(
    projectPath: string,
    createSession: (normalizedProjectPath: string) => Promise<StudioProjectSession>
  ): Promise<StudioProjectSession> {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) {
      throw new Error("A valid Studio project path is required.");
    }

    const existing = this.entriesByPath.get(normalized);
    if (existing) {
      existing.retainCount += 1;
      return existing.session;
    }

    const session = await createSession(normalized);
    this.entriesByPath.set(normalized, {
      path: normalized,
      session,
      retainCount: 1,
    });
    return session;
  }

  async flushSession(projectPath: string, options?: { force?: boolean }): Promise<void> {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) {
      return;
    }
    const session = this.entriesByPath.get(normalized)?.session;
    if (!session) {
      return;
    }
    await session.flushPendingSaveWork({ force: options?.force });
  }

  moveSession(oldProjectPath: string, newProjectPath: string): boolean {
    const normalizedOldPath = this.normalizeProjectPath(oldProjectPath);
    const normalizedNewPath = this.normalizeProjectPath(newProjectPath);
    if (!normalizedOldPath || !normalizedNewPath) {
      return false;
    }
    if (normalizedOldPath === normalizedNewPath) {
      return this.entriesByPath.has(normalizedOldPath);
    }

    const existing = this.entriesByPath.get(normalizedOldPath);
    if (!existing) {
      return false;
    }

    this.entriesByPath.delete(normalizedOldPath);
    this.entriesByPath.set(normalizedNewPath, {
      path: normalizedNewPath,
      session: existing.session,
      retainCount: existing.retainCount,
    });
    return true;
  }

  async releaseSession(projectPath: string): Promise<void> {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) {
      return;
    }
    const existing = this.entriesByPath.get(normalized);
    if (!existing) {
      return;
    }

    existing.retainCount = Math.max(0, existing.retainCount - 1);
    if (existing.retainCount > 0) {
      return;
    }

    this.entriesByPath.delete(normalized);
    await existing.session.close();
  }

  async closeSession(projectPath: string): Promise<void> {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) {
      return;
    }
    const existing = this.entriesByPath.get(normalized);
    if (!existing) {
      return;
    }
    this.entriesByPath.delete(normalized);
    await existing.session.close();
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.entriesByPath.values());
    this.entriesByPath.clear();
    for (const entry of entries) {
      await entry.session.close();
    }
  }

  private normalizeProjectPath(projectPath: string): string {
    const normalized = String(projectPath || "").trim();
    if (!normalized) {
      return "";
    }
    return normalizeStudioProjectPath(normalized);
  }
}
