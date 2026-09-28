import { normalizePath, type App } from 'obsidian';

/** Local locator only: Codex keeps the authoritative thread history. No credentials are read or copied. */
export class CodexThreadLocator {
  constructor(private readonly app: App) {}
  private path(conversationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(conversationId)) throw new Error('Invalid chat identity.');
    return normalizePath(`${this.app.vault.configDir}/plugins/systemsculpt-ai/codex-threads/${conversationId}.json`);
  }
  async read(conversationId: string): Promise<string | undefined> {
    const path = this.path(conversationId), adapter = this.app.vault.adapter;
    if (typeof adapter.exists !== 'function' || !(await adapter.exists(path))) return undefined;
    const stat = await adapter.stat(path);
    if (!stat || stat.size > 1024) throw new Error('Invalid saved Codex thread locator.');
    const value = JSON.parse(await adapter.read(path)) as { threadId?: unknown };
    if (typeof value.threadId !== 'string' || !/^[a-f0-9-]{20,80}$/i.test(value.threadId)) throw new Error('Invalid saved Codex thread identity.');
    return value.threadId;
  }
  async write(conversationId: string, threadId: string): Promise<void> {
    const path = this.path(conversationId), folder = path.slice(0, path.lastIndexOf('/')), adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    await adapter.write(path, JSON.stringify({ schema: 1, threadId }));
  }
}
