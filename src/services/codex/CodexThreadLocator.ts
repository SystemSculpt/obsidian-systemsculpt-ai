import { normalizePath, type App } from 'obsidian';
import type { LocalAgentId } from './LocalAgents';

/** Local locator only: the on-machine agent keeps the authoritative thread history. No credentials are read or copied. */
export class CodexThreadLocator {
  constructor(private readonly app: App, private readonly agent: LocalAgentId = 'codex') {}
  private folder(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/systemsculpt-ai/${this.agent}-threads`);
  }
  private path(conversationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(conversationId)) throw new Error('Invalid chat identity.');
    return `${this.folder()}/${conversationId}.json`;
  }
  /** Conversations this agent ran in this vault, from locator names alone. */
  async conversationIds(): Promise<Set<string>> {
    const adapter = this.app.vault.adapter;
    try {
      if (typeof adapter.list !== 'function' || !(await adapter.exists(this.folder()))) return new Set();
      const { files } = await adapter.list(this.folder());
      return new Set(files.map(file => file.slice(file.lastIndexOf('/') + 1)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)));
    } catch { return new Set(); }
  }
  async read(conversationId: string): Promise<string | undefined> {
    const path = this.path(conversationId), adapter = this.app.vault.adapter;
    if (typeof adapter.exists !== 'function' || !(await adapter.exists(path))) return undefined;
    const stat = await adapter.stat(path);
    if (!stat || stat.size > 1024) throw new Error('Invalid saved on-machine thread locator.');
    const value = JSON.parse(await adapter.read(path)) as { threadId?: unknown };
    if (typeof value.threadId !== 'string' || !/^[a-f0-9-]{20,80}$/i.test(value.threadId)) throw new Error('Invalid saved on-machine thread identity.');
    return value.threadId;
  }
  async write(conversationId: string, threadId: string): Promise<void> {
    const path = this.path(conversationId), folder = path.slice(0, path.lastIndexOf('/')), adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    await adapter.write(path, JSON.stringify({ schema: 1, threadId }));
  }
}
