import { validStudioWorkflow, type StudioWorkflow } from './StudioWorkflow';
import type { App } from 'obsidian';
import { deriveStudioAssetsDir } from '../../studio/paths';
import { isRecord } from '../../studio/utils';
import type { CodexActivity } from './CodexActivity';
import type { CodexRequest } from './LocalCodexClient';

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type AgentRunMessage = { id: string; from: string; to: string; text: string; at: string; status: 'pending' | 'delivered' | 'failed'; error?: string };
export type StudioAgentRun = {
  schema: 'studio.agent-run.v1'; id: string; projectId: string; projectPath: string; nodeId: string; title: string;
  workflow?: StudioWorkflow; workflowId?: string; assignmentId?: string; preparationPending?: boolean;
  parentRunId?: string; owner: string; machine: string; status: AgentRunStatus; createdAt: string; updatedAt: string; finishedAt?: string;
  threadId: string; turnId: string; request: CodexRequest; result: string; error: string; currentActivity: string;
  activity: CodexActivity[]; messages: AgentRunMessage[]; persistenceError?: string;
};
export const isActiveAgentRun = (status: AgentRunStatus): boolean => ['queued', 'running', 'waiting'].includes(status);
export const agentRunFolder = (projectPath: string): string => `${deriveStudioAssetsDir(projectPath)}/agent-runs`;

/** Vault-side presentation records. Codex remains the authoritative thread store. */
export class StudioAgentRunStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly app: App) {}
  async list(projectPath: string, projectId: string): Promise<StudioAgentRun[]> {
    const adapter = this.app.vault.adapter, folder = agentRunFolder(projectPath);
    if (!await adapter.exists(folder)) return [];
    const files = (await adapter.list(folder)).files;
    if (files.length > 5000) throw new Error('This run folder exceeds 5,000 records. Archive older records before loading this board.');
    const paths = files.filter(path => /\/agent_[0-9]+_[a-f0-9-]+\.json$/.test(path)).sort().slice(-200);
    const records: StudioAgentRun[] = [];
    for (let offset = 0; offset < paths.length; offset += 4) {
      const batch = await Promise.all(paths.slice(offset, offset + 4).map(async path => {
        const stat = await adapter.stat(path);
        if (!stat || stat.size > 2_000_000) throw new Error('A saved run record exceeds the supported size.');
        const record: unknown = JSON.parse(await adapter.read(path));
        if (!isRecord(record) || record.schema !== 'studio.agent-run.v1' || record.projectId !== projectId || record.projectPath !== projectPath || !/^agent_[0-9]+_[a-f0-9-]+$/.test(String(record.id)) || !isRecord(record.request) || typeof record.request.prompt !== 'string' || typeof record.request.workingDirectory !== 'string' || !Array.isArray(record.activity) || !Array.isArray(record.messages) || !['queued','running','waiting','completed','failed','stopped','interrupted'].includes(String(record.status))) throw new Error('A saved run record is invalid; it was left unchanged.');
        const stringFields = ['id','projectId','projectPath','nodeId','title','owner','machine','createdAt','updatedAt','threadId','turnId','result','error','currentActivity'];
        if (stringFields.some(key => typeof record[key] !== 'string') || record.activity.length > 40 || record.messages.length > 100
          || record.activity.some(item => !isRecord(item) || ['id','kind','title','detail','status','at'].some(key => typeof item[key] !== 'string') || !['command','file','tool','plan','message'].includes(String(item.kind)))
          || record.messages.some(item => !isRecord(item) || ['id','from','to','text','at','status'].some(key => typeof item[key] !== 'string') || !['pending','delivered','failed'].includes(String(item.status)))) throw new Error('A saved run has invalid presentation fields; it was left unchanged.');
        if ((record.workflow !== undefined && !validStudioWorkflow(record.workflow)) || ['workflowId','assignmentId'].some(key => record[key] !== undefined && typeof record[key] !== 'string')) throw new Error('Saved workflow state is invalid; it was left unchanged.');
        return record as StudioAgentRun;
      }));
      records.push(...batch);
    }
    return records;
  }
  write(record: StudioAgentRun): Promise<void> {
    const snapshot = JSON.stringify(record);
    if (new TextEncoder().encode(snapshot).byteLength > 2_000_000) return Promise.reject(new Error('The run presentation record exceeds 2 MB.'));
    const path = `${agentRunFolder(record.projectPath)}/${record.id}.json`;
    const previous = this.writes.get(path) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const adapter = this.app.vault.adapter, parts = agentRunFolder(record.projectPath).split('/');
      for (let index = 1; index <= parts.length; index++) {
        const folder = parts.slice(0, index).join('/');
        if (!await adapter.exists(folder)) {
          try { await adapter.mkdir(folder); } catch (error) { if (!await adapter.exists(folder)) throw error; }
        }
      }
      await adapter.write(path, snapshot);
    });
    this.writes.set(path, pending);
    void pending.finally(() => { if (this.writes.get(path) === pending) this.writes.delete(path); }).catch(() => {});
    return pending;
  }
  async flush(): Promise<void> { await Promise.all([...this.writes.values()]); }
}
