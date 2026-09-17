import { normalizeStudioProjectPath } from "./paths";
import { StudioProjectSession } from "./StudioProjectSession";

type SessionEntry = { session: StudioProjectSession; retainCount: number };

/** Owns shared session lifetime, including asynchronous creation, reload and close. */
export class StudioProjectSessionManager {
  private readonly entriesByPath = new Map<string, SessionEntry>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private disposed = false;

  getSession(projectPath: string): StudioProjectSession | null {
    const path = this.normalizeProjectPath(projectPath);
    return this.entriesByPath.get(path)?.session || null;
  }

  async retainSession(
    projectPath: string,
    createSession: (path: string) => Promise<StudioProjectSession>,
    reloadSession?: (session: StudioProjectSession, path: string) => Promise<void>,
  ): Promise<StudioProjectSession> {
    if (this.disposed) throw new Error("Studio project sessions are disposed.");
    const path = this.normalizeProjectPath(projectPath);
    if (!path) throw new Error("A valid Studio project path is required.");
    return this.serialize(path, async () => {
      const existing = this.entriesByPath.get(path);
      if (existing) {
        // A rejected reload must neither replace the live session nor retain it.
        await reloadSession?.(existing.session, path);
        existing.retainCount += 1;
        return existing.session;
      }
      const session = await createSession(path);
      this.entriesByPath.set(path, { session, retainCount: 1 });
      return session;
    });
  }

  async releaseSession(projectPath: string): Promise<void> {
    const path = this.normalizeProjectPath(projectPath);
    if (!path) return;
    await this.serialize(path, async () => {
      const entry = this.entriesByPath.get(path);
      if (!entry) return;
      entry.retainCount = Math.max(0, entry.retainCount - 1);
      if (entry.retainCount === 0) await this.closeEntry(path, entry);
    });
  }

  async moveSession(oldProjectPath: string, newProjectPath: string): Promise<boolean> {
    if (this.disposed) throw new Error("Studio project sessions are disposed.");
    const oldPath = this.normalizeProjectPath(oldProjectPath), newPath = this.normalizeProjectPath(newProjectPath);
    if (!oldPath || !newPath) return false;
    if (oldPath === newPath) return this.serialize(oldPath, async () => this.entriesByPath.has(oldPath));
    // Stable lock order also protects a rename against pending destination loads.
    const [first, second] = [oldPath, newPath].sort();
    return this.serialize(first, () => this.serialize(second, async () => {
      const entry = this.entriesByPath.get(oldPath);
      if (!entry) return false;
      if (this.entriesByPath.has(newPath)) throw new Error("Another Studio session already owns the renamed path.");
      this.entriesByPath.delete(oldPath);
      this.entriesByPath.set(newPath, entry);
      return true;
    }));
  }

  async closeAll(): Promise<void> {
    this.disposed = true;
    // Include pending creations: disposal cannot finish while a load can still
    // publish a new session after the last visible entry has been closed.
    await Promise.allSettled([...this.operations.values()]);
    const paths = [...this.entriesByPath.keys()];
    const results = await Promise.allSettled([...paths].map(path => this.serialize(path, async () => {
      const entry = this.entriesByPath.get(path);
      if (entry) await this.closeEntry(path, entry);
    })));
    const failures = results.filter((result): result is { status: "rejected"; reason: unknown } => result.status === "rejected");
    if (failures.length) throw new Error(`Studio could not safely close ${failures.length} project session(s): ${failures.map(result => String(result.reason instanceof Error ? result.reason.message : result.reason)).join("; ")}`);
  }

  private async closeEntry(path: string, entry: SessionEntry): Promise<void> {
    // Keep the only remaining copy owned when recovery persistence fails.
    await entry.session.close();
    this.entriesByPath.delete(path);
  }

  private async serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.operations.get(path) || Promise.resolve()).catch(() => undefined).then(operation);
    this.operations.set(path, pending);
    try { return await pending; }
    finally { if (this.operations.get(path) === pending) this.operations.delete(path); }
  }

  private normalizeProjectPath(path: string): string {
    return path.trim() ? normalizeStudioProjectPath(path) : "";
  }
}
