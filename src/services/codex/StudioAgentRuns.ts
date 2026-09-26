import type { StudioDocumentEdit } from "../../studio/document/StudioProjectDocument";
import { createStudioWorkflow, workflowOpen, readWorkflowSteps, studioWorkflowInstructions, studioWorkflowTools, type StudioWorkflow } from './StudioWorkflow';
import type SystemSculptPlugin from '../../main';
import { desktopHost } from '../../platform/desktopOnly';
import { hasHostCapability } from '../../platform/hostCapabilities';
import { isRecord, randomId } from '../../studio/utils';
import { codexWorkingDirectory } from './CodexExecutionSettings';
import { runLocalCodex, type CodexRequest, type CodexResult } from './LocalCodexClient';
import { answerCodexRequest } from './CodexRequestModal';
import { StudioAgentRunStore, isActiveAgentRun, type AgentRunPage, type StudioAgentRun, type AgentRunMessage, type StudioAgentRunView, type AgentRunMessageView } from './StudioAgentRunStore';
import type { CodexJson } from './CodexAppServer';

export type StudioAgentSpecification = { workflow?: StudioWorkflow; assignmentId?: string; projectId: string; projectPath: string; nodeId: string; title: string; request: CodexRequest; parentRunId?: string; prepare?: () => Promise<CodexRequest> };
type NativeReview = { label: string; open: () => Promise<void> };
type Control = { holdsSlot?: boolean; controller: AbortController; send?: (text: string) => Promise<void>; reviews: NativeReview[]; completion: Promise<CodexResult>; resolve: (result: CodexResult) => void; reject: (error: Error) => void };
type Callbacks = {
  readDocument?: (path: string) => Promise<unknown>;
  editDocument?: (path: string, heads: string[], edits: StudioDocumentEdit[]) => Promise<unknown>;
  startPeer: (projectPath: string, nodeId: string, objective: string, parentRunId: string, assignmentId?: string) => Promise<StudioAgentRunView>;
  workflowSpecification?: (projectPath: string, centerId: string, objective: string) => Promise<StudioAgentSpecification>;
  context?: (projectPath: string, nodeId?: string) => Promise<unknown>;
  prepare?: (record: StudioAgentRunView) => Promise<CodexRequest>;
  templates: (projectPath: string) => Promise<{ id: string; title: string }[]>;
};
const MAX_ACTIVE = 8, MAX_PENDING = 100;
/**
 * The presentation cache holds at most this many runs across projects. Paging
 * past it evicts the least recently changed runs that are not live, and the
 * board then says it shows only the newest runs.
 */
export const MAX_LOADED_AGENT_RUNS = 1000;
const tools: CodexJson[] = [
  {type: 'function', name: 'studio_read_document', description: 'Read this canvas and its revision for scoped concurrent edits. Use this and studio_edit_document instead of replacing the file.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {type: 'function', name: 'studio_edit_document', description: 'Apply a batch to this canvas using heads from studio_read_document. Edits use kind set/create/delete/restore, entityId, optional path string array, value, remove. Changes since that read merge by field; a batch that conflicts with a later change to the same field is rejected, so read again. Deletion prevents stale resurrection.', inputSchema: {type: 'object', properties: {heads: {type: 'array', items: {type: 'string'}}, edits: {type: 'array', items: {type: 'object', properties: {kind: {type: 'string', enum: ['set','create','delete','restore']}, entityId: {type: 'string'}, path: {type: 'array', items: {type: 'string'}}, value: {}, remove: {type: 'boolean'}}, required: ['kind','entityId'], additionalProperties: false}}}, required: ['heads','edits'], additionalProperties: false}},
  { type: 'function', name: 'studio_stop_run', description: 'Stop one of your own child assignments when it is no longer needed. This preserves its history.', inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false } },
  { type: 'function', name: 'studio_runs', description: 'List the available role definitions and recent run instances in this Studio project, including IDs, status and latest public activity. Use before choosing a peer.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'studio_send_message', description: 'Send a concrete handoff or finding to a run in this Studio project. An active run receives it through native turn steering; an idle run resumes its native thread. A delivery receipt means accepted by Codex, not completed work.', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, message: { type: 'string' } }, required: ['runId','message'], additionalProperties: false } },
  { type: 'function', name: 'studio_start_run', description: 'Start an independent instance of an existing role in this Studio project with a concrete objective. Use only within the owner-authorized task. Return and retain the new run ID; use messages for follow-up.', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, objective: { type: 'string' }, assignmentId: { type: 'string', description: 'Required in orchestrated workflows: stable plan step ID; repeated dispatch returns the original child.' } }, required: ['nodeId','objective'], additionalProperties: false } },
];

/** Native turns plus owner-started workflow handoffs. Codex decides the plan and completion. */
export class StudioAgentRuns {
  private readonly dispatches = new Map<string, Promise<StudioAgentRunView>>();
  private readonly workflowWaiters = new Map<string, () => void>();
  private readonly records = new Map<string, StudioAgentRun>();
  private readonly controls = new Map<string, Control>();
  private readonly listeners = new Set<(projectId: string) => void>();
  private readonly loaded = new Map<string, Promise<void>>();
  /** Per project: the oldest loaded run ID and how many older records remain on disk. */
  private readonly older = new Map<string, { before: string; remaining: number }>();
  /** Projects whose older loaded runs were evicted to keep the cache bounded. */
  private readonly capped = new Set<string>();
  private readonly timers = new Map<string, number>();
  private readonly delivering = new Set<string>();
  private readonly notificationTimers = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly receipts = new Map<string, Promise<AgentRunMessage>>();
  private readonly queue: { control: Control; start: () => void }[] = [];
  private readonly owner = randomId('session');
  private readonly store: StudioAgentRunStore;
  private active = 0;
  private admissions = 0;
  private disposed = false;
  private machine = '';

  constructor(private readonly plugin: Pick<SystemSculptPlugin, 'app' | 'getLogger'>, private readonly callbacks: Callbacks) { this.store = new StudioAgentRunStore(plugin.app); }
  get app() { return this.plugin.app; }
  subscribe(listener: (projectId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  list(projectId: string, nodeIds?: readonly string[]): readonly StudioAgentRunView[] {
    const allowed = nodeIds?.length ? new Set(nodeIds) : null;
    // Every loaded run, including older pages; pruneAndNotify() keeps the cache at MAX_LOADED_AGENT_RUNS.
    return [...this.records.values()].filter(run => run.projectId === projectId && (!allowed || allowed.has(run.nodeId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): StudioAgentRunView | undefined { return this.records.get(id); }
  canControl(id: string): boolean { const run = this.records.get(id); return !!run && hasHostCapability('local-cli') && run.machine === this.machine; }
  hasRequest(id: string): boolean { return !!this.controls.get(id)?.reviews.length; }
  private async identifyMachine(): Promise<void> {
    if (!this.machine && hasHostCapability('local-cli')) this.machine = (await desktopHost.os()).hostname();
  }
  async refresh(projectPath: string, projectId: string): Promise<void> {
    await this.loaded.get(projectPath); this.loaded.delete(projectPath); this.older.delete(projectPath); this.capped.delete(projectPath); await this.load(projectPath, projectId);
  }
  /** True once paging this project evicted older runs; older pages are then no longer offered. */
  isCapped(projectPath: string): boolean { return this.capped.has(projectPath); }
  /**
   * Keep the cache at MAX_LOADED_AGENT_RUNS by evicting the least recently
   * changed runs. Live runs stay: controlled runs and their ancestors, active
   * runs, open workflows and their assignments.
   */
  private pruneAndNotify(projectId: string): void {
    const affectedProjects = new Set([projectId]);
    if (this.records.size <= MAX_LOADED_AGENT_RUNS) { this.emit(projectId); return; }
    const protectedIds = new Set(this.controls.keys());
    for (const id of this.controls.keys()) {
      let parent = this.records.get(id)?.parentRunId;
      for (let depth = 0; parent && depth < 8; depth++) { protectedIds.add(parent); parent = this.records.get(parent)?.parentRunId; }
    }
    for (const run of [...this.records.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (this.records.size <= MAX_LOADED_AGENT_RUNS) break;
      if (protectedIds.has(run.id) || isActiveAgentRun(run.status) || workflowOpen(run.workflow) || (run.workflowId && workflowOpen(this.records.get(run.workflowId)?.workflow))) continue;
      this.records.delete(run.id); this.capped.add(run.projectPath); affectedProjects.add(run.projectId);
    }
    for (const affectedProjectId of affectedProjects) this.emit(affectedProjectId);
  }
  async load(projectPath: string, projectId: string): Promise<void> {
    if (!this.loaded.has(projectPath)) this.loaded.set(projectPath, (async () => {
      await this.identifyMachine();
      const page = await this.store.list(projectPath, projectId);
      this.adopt(page);
      // Repeated loads keep their cursor; an explicit Refresh clears it before loading.
      const cursor = this.older.get(projectPath);
      if (!cursor || !page.before || page.before <= cursor.before) this.older.set(projectPath, { before: page.before ?? '', remaining: page.olderRemaining });
      this.pruneAndNotify(projectId);
      await this.recoverWorkflows(projectId);
      this.retainOnDisk(projectPath, projectId);
    })().catch(error => { this.loaded.delete(projectPath); throw error; }));
    await this.loaded.get(projectPath);
  }
  hasOlder(projectPath: string): boolean { return !this.capped.has(projectPath) && (this.older.get(projectPath)?.remaining ?? 0) > 0; }
  /** Read the next page of older records for the run board. */
  async loadOlder(projectPath: string, projectId: string): Promise<void> {
    await this.load(projectPath, projectId);
    const cursor = this.older.get(projectPath);
    if (!cursor || cursor.remaining <= 0 || this.capped.has(projectPath) || this.disposed) return;
    const page = await this.store.list(projectPath, projectId, { before: cursor.before });
    this.adopt(page);
    this.older.set(projectPath, page.before ? { before: page.before, remaining: page.olderRemaining } : { ...cursor, remaining: 0 });
    this.pruneAndNotify(projectId);
  }
  private adopt(page: AgentRunPage): void {
    for (const run of page.records) {
      if (this.controls.has(run.id) || (this.records.has(run.id) && run.machine === this.machine)) continue;
      if (run.machine === this.machine && isActiveAgentRun(run.status)) {
        run.status = 'interrupted'; run.currentActivity = 'Previous Obsidian session ended';
      }
      this.records.set(run.id, run);
    }
  }
  /** Bound the on-disk records once per project per session, without delaying the board. */
  private retainOnDisk(projectPath: string, projectId: string): void {
    if (this.disposed) return;
    const pass = this.store.prune(projectPath, projectId, new Set(this.records.keys())).then(() => {});
    this.tasks.add(pass); void pass.finally(() => this.tasks.delete(pass));
  }
  async startWorkflow(projectPath: string, centerId: string, objective: string): Promise<StudioAgentRunView> {
    if (!objective.trim() || objective.length > 16000) throw new Error('Describe an objective of at most 16,000 characters.');
    if (!this.callbacks.workflowSpecification) throw new Error('Workflow launch is unavailable.');
    return this.start({ ...await this.callbacks.workflowSpecification(projectPath, centerId, objective.trim()), workflow: createStudioWorkflow(objective.trim()) });
  }
  async start(specification: StudioAgentSpecification): Promise<StudioAgentRunView> {
    if (this.disposed || !hasHostCapability('local-cli')) throw new Error('Start this run in Obsidian Desktop on the execution machine.');
    if (this.controls.size + this.admissions >= MAX_PENDING) throw new Error('There are already 100 active or queued runs. Stop or finish a run first.');
    if (new TextEncoder().encode(JSON.stringify(specification.request)).byteLength > 64_000) throw new Error('This run input exceeds 64 KB. Link large context files instead.');
    this.admissions++;
    try {
    await this.load(specification.projectPath, specification.projectId);
    if (this.disposed) throw new Error('Obsidian session ended.');
    if (specification.parentRunId) {
      const parent = this.records.get(specification.parentRunId);
      if (parent?.workflow && !workflowOpen(parent.workflow)) throw new Error('The parent workflow has stopped or paused.');
      if (!parent || parent.projectId !== specification.projectId) throw new Error('The parent run is not in this project.');
      let depth = 0, ancestor: StudioAgentRun | undefined = parent;
      while (ancestor) { if (++depth > 8) throw new Error('The run handoff depth limit is eight.'); ancestor = ancestor.parentRunId ? this.records.get(ancestor.parentRunId) : undefined; }
      if ([...this.records.values()].filter(run => run.parentRunId === parent.id).length >= 16) throw new Error('This run has already started 16 child instances.');
    }
    const now = new Date().toISOString();
    const record: StudioAgentRun = { schema: 'studio.agent-run.v1', id: randomId(`agent_${Date.now()}`), projectId: specification.projectId, projectPath: specification.projectPath, nodeId: specification.nodeId,
      title: specification.title, workflow: specification.workflow, assignmentId: specification.assignmentId, preparationPending: !!specification.prepare, workflowId: specification.parentRunId ? (this.records.get(specification.parentRunId)?.workflow ? specification.parentRunId : this.records.get(specification.parentRunId)?.workflowId) : undefined, parentRunId: specification.parentRunId, owner: this.owner, machine: this.machine, status: 'queued', createdAt: now, updatedAt: now,
      threadId: specification.request.threadId || '', turnId: '', request: { ...specification.request }, result: '', error: '', currentActivity: 'Queued', activity: [], messages: [] };
    this.records.set(record.id, record);
    try { await this.store.write(record); }
    catch (error) { this.records.delete(record.id); throw error; }
    if (this.disposed) { record.status = 'interrupted'; await this.persist(record); throw new Error('Obsidian session ended.'); }
    const workflow = record.workflowId ? this.records.get(record.workflowId)?.workflow : undefined;
    if (record.status === 'stopped' || (workflow && !workflowOpen(workflow))) { record.status = 'stopped'; record.finishedAt = new Date().toISOString(); await this.persist(record); return record; }
    this.admit(record, record.request.prompt, specification.prepare);
    return record;
    } finally { this.admissions--; }
  }
  async run(specification: StudioAgentSpecification, signal?: AbortSignal): Promise<CodexResult> {
    const record = await this.start(specification), control = this.controls.get(record.id)!;
    const abort = () => this.stop(record.id); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await control.completion; } finally { signal?.removeEventListener('abort', abort); }
  }
  private admit(record: StudioAgentRun, message: string, prepare?: () => Promise<CodexRequest>, initialMessage?: AgentRunMessage, recover = false): void {
    let resolve!: Control['resolve'], reject!: Control['reject'];
    const completion = new Promise<CodexResult>((yes, no) => { resolve = yes; reject = no; }); void completion.catch(() => {});
    const control: Control = { controller: new AbortController(), reviews: [], completion, resolve, reject };
    this.controls.set(record.id, control); record.owner = this.owner; record.status = 'queued'; record.error = ''; record.result = ''; record.currentActivity = 'Queued'; delete record.finishedAt;
    this.changed(record);
    const task = async () => {
      try {
        if (control.controller.signal.aborted) throw new Error('Run stopped.');
        if (prepare) { record.currentActivity = 'Preparing connected inputs'; this.changed(record); record.request = await prepare(); message = record.request.prompt; record.preparationPending = false; await this.persist(record); if (new TextEncoder().encode(JSON.stringify(record.request)).byteLength > 64_000) throw new Error('Connected run input exceeds 64 KB.'); }
        if (control.controller.signal.aborted) throw new Error('Run stopped.');
        record.status = 'running'; record.currentActivity = 'Connecting to Codex'; this.changed(record);
        const context = `\n\nStudio run ID: ${record.id}. This is an independent instance of ${record.title}. Use studio_runs to discover other instances and available roles. Use studio_send_message for concrete handoffs; use studio_start_run only for owner-authorized independent work. A delivered message is not proof of task completion. Send brief public progress updates before substantial work. Do not repeatedly poll other runs. Native Codex owns execution and permissions.`;
        const result = await runLocalCodex({ ...record.request, prompt: message + context + (record.workflow ? `\n\n${studioWorkflowInstructions}\nSaved workflow: ${JSON.stringify(record.workflow)}` : record.workflowId ? `\nThis is a workflow assignment. Return evidence to the orchestrator; do not delegate further or message the orchestrator to wake it. Studio delivers your final result automatically.` : ''), threadId: record.threadId || undefined, recoverCompletedTurn: recover, dynamicTools: record.workflow ? [...tools, ...studioWorkflowTools] : tools,
          workingDirectory: codexWorkingDirectory(this.plugin.app, record.request.workingDirectory) }, control.controller.signal, {
          thread: async id => { record.threadId = id; await this.persist(record); },
          ready: native => {
            record.turnId = native.turnId; control.send = native.send; record.currentActivity = 'Codex is working';
            if (initialMessage) { initialMessage.status = 'delivered'; this.messageChanged(initialMessage); }
            this.changed(record);
            // Native acceptance is a delivery receipt, not ordinary debounced presentation.
            void this.persist(record).catch(() => {});
            for (const pending of record.messages.filter(item => item.to === record.id && item.status === 'pending')) void this.deliver(record, pending).catch(() => {});
          },
          log: text => { if (text.startsWith('Connected to')) { record.currentActivity = 'Starting native turn'; this.changed(record); } },
          text: text => { record.result = text.slice(-64_000); this.changed(record); },
          activity: activity => {
            const existing = record.activity.findIndex(item => item.id === activity.id);
            const projected = { ...activity, detail: activity.detail.slice(-2000) };
            if (existing >= 0) record.activity[existing] = projected; else record.activity.push(projected);
            record.activity = record.activity.slice(-40);
            if (activity.kind !== 'message' || activity.detail) record.currentActivity = activity.kind === 'message' ? activity.detail.replace(/\s+/g, ' ').slice(0, 180) : activity.title;
            this.changed(record);
          },
          request: (method, params, signal) => method === 'item/tool/call' ? this.tool(record, params, control.controller.signal) : this.waitForReview(record, control, method, params, signal),
        });
        record.status = 'completed'; record.result = result.text.slice(-64_000); record.currentActivity = 'Completed'; record.finishedAt = new Date().toISOString();
        await this.persist(record); control.resolve(result);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        record.status = control.controller.signal.aborted ? (this.disposed ? 'interrupted' : 'stopped') : 'failed';
        record.error = control.controller.signal.aborted ? '' : error.message; record.currentActivity = record.error || (this.disposed ? 'Obsidian session ended' : 'Stopped'); record.finishedAt = new Date().toISOString();
        await this.persist(record).catch(() => {}); control.reject(error);
      } finally {
        this.controls.delete(record.id); this.pruneAndNotify(record.projectId);
        for (const pending of record.messages.filter(item => item.to === record.id && item.status === 'pending')) { pending.status = 'failed'; pending.error = 'The run ended before Codex accepted this message.'; this.messageChanged(pending); }
        this.changed(record);
        this.workflowTurnEnded(record);
      }
    };
    this.queue.push({ control, start: () => {
      const running = task().finally(() => { this.tasks.delete(running); this.releaseSlot(control); });
      this.tasks.add(running);
    } });
    this.drain();
  }
  private drain(): void {
    while (!this.disposed && this.active < MAX_ACTIVE && this.queue.length) {
      const next = this.queue.shift()!; this.active++; next.control.holdsSlot = true; next.start();
    }
  }
  private releaseSlot(control: Control): void {
    if (control.holdsSlot) { control.holdsSlot = false; this.active--; }
    this.drain();
  }
  private acquireSlot(control: Control, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const pending = { control, start: () => { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { const index = this.queue.indexOf(pending); if (index >= 0) this.queue.splice(index, 1); reject(new Error('Workflow stopped.')); };
      if (signal.aborted || this.disposed) { reject(new Error('Workflow stopped.')); return; }
      signal.addEventListener('abort', abort, { once: true }); this.queue.push(pending); this.drain();
    });
  }
  stop(id: string): void {
    const record = this.records.get(id), control = this.controls.get(id);
    if (!record || !this.canControl(id)) return;
    if (record.workflow) { record.workflow.status = 'stopped'; record.currentActivity = 'Workflow stopped'; this.changed(record); void this.persist(record).catch(() => {}); for (const child of this.children(record)) this.stop(child.id); this.workflowWaiters.get(id)?.(); }
    if (!control) { if (record.status === 'interrupted' || record.status === 'queued' || record.workflow) { record.status = 'stopped'; record.finishedAt = new Date().toISOString(); this.changed(record); this.workflowTurnEnded(record); } return; }
    control.controller.abort();
    if (record.status === 'queued') { record.status = 'stopped'; record.currentActivity = 'Stopped'; this.changed(record); }
  }
  async review(id: string): Promise<void> { await this.controls.get(id)?.reviews[0]?.open(); }
  private presentReview(record: StudioAgentRun, control: Control): void {
    if (control.controller.signal.aborted || this.controls.get(record.id) !== control) return;
    record.status = control.reviews.length ? 'waiting' : 'running';
    record.currentActivity = control.reviews[0]?.label || 'Codex is working';
    this.changed(record);
  }
  private waitForReview(record: StudioAgentRun, control: Control, method: string, params: CodexJson, signal: AbortSignal): Promise<unknown> {
    if (!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'].includes(method)) return Promise.reject(new Error(`Unsupported native request: ${method}`));
    if (signal.aborted || control.controller.signal.aborted) return Promise.reject(new Error('Run stopped.'));
    if (control.reviews.length >= 16) return Promise.reject(new Error('Too many native requests are awaiting review.'));
    return new Promise((resolve, reject) => {
      let reviewing = false, settled = false;
      const cleanup = () => {
        settled = true;
        signal.removeEventListener('abort', abort); control.controller.signal.removeEventListener('abort', abort);
        const index = control.reviews.indexOf(review); if (index >= 0) control.reviews.splice(index, 1);
        this.presentReview(record, control);
      };
      const abort = () => { if (!settled) { cleanup(); reject(new Error('Run stopped.')); } };
      const review: NativeReview = {
        label: method === 'item/tool/requestUserInput' ? 'Waiting for your answer' : 'Waiting for native approval',
        open: async () => {
          if (reviewing || settled) return; reviewing = true;
          try { const answer = await answerCodexRequest(this.plugin.app, method, params, signal); if (!settled) resolve(answer); }
          catch (error) { if (!settled) reject(error instanceof Error ? error : new Error(String(error))); }
          finally { if (!settled) cleanup(); }
        },
      };
      control.reviews.push(review);
      signal.addEventListener('abort', abort, { once: true }); control.controller.signal.addEventListener('abort', abort, { once: true });
      this.presentReview(record, control);
    });
  }
  async send(targetId: string, text: string, fromId = 'you', requestId = randomId('message')): Promise<AgentRunMessageView> {
    if (this.disposed) throw new Error('Obsidian session ended.');
    if (!text.trim() || text.length > 16_000) throw new Error('A message must contain 1–16,000 characters.');
    const target = this.records.get(targetId), sender = fromId === 'you' ? null : this.records.get(fromId);
    if (!target || !this.canControl(targetId)) throw new Error('Open this run on its execution machine to send a message.');
    if (fromId !== 'you' && (!sender || sender.projectId !== target.projectId)) throw new Error('Runs may only message peers in the same project.');
    if (sender?.workflowId && sender.workflowId === target.id) throw new Error('Return your result normally; the workflow delivers it automatically.');
    if (sender?.id === target.id) throw new Error('Choose another run for a handoff.');
    const key = `${fromId}:${requestId}`;
    if (this.receipts.has(key)) return this.receipts.get(key)!;
    if (sender && sender.messages.filter(message => message.from === fromId).length >= 100) throw new Error('This run has reached its message limit.');
    if (target.messages.filter(message => message.status === 'pending').length >= 3) throw new Error('This run already has three pending messages. Wait for delivery.');
    if (!this.controls.has(target.id) && this.controls.size + this.admissions >= MAX_PENDING) throw new Error('The run queue is full.');
    const operation = (async () => {
      const message: AgentRunMessage = { id: randomId('message'), from: fromId, to: target.id, text, at: new Date().toISOString(), status: 'pending' };
      target.messages.push(message); if (sender) sender.messages.push(message);
      this.changed(target); if (sender) this.changed(sender);
      try { await this.persist(target); if (sender) await this.persist(sender); } catch (error) { message.status = 'failed'; message.error = 'Message could not be saved before delivery.'; this.messageChanged(message); throw error; }
      if (target.workflow && fromId === 'you') { target.workflow.status = 'active'; target.workflow.outcome = ''; this.workflowWaiters.get(target.id)?.(); }
      if (!this.controls.has(target.id)) {
        if (!target.threadId) { message.status = 'failed'; message.error = 'This run has no native thread to resume.'; this.messageChanged(message); return message; }
        if (this.disposed || this.controls.size + this.admissions >= MAX_PENDING) { message.status = 'failed'; message.error = 'The run queue is unavailable.'; this.messageChanged(message); return message; }
        // The explicit message starts one native turn; no completion heuristic schedules another.
        this.admit(target, `Message from ${sender?.title || 'the owner'} (${fromId}):\n${text}`, undefined, message);
      } else await this.deliver(target, message);
      return message;
    })();
    this.receipts.set(key, operation);
    while (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value!);
    return operation;
  }
  private async deliver(target: StudioAgentRun, message: AgentRunMessage): Promise<void> {
    const send = this.controls.get(target.id)?.send;
    if (!send || message.status !== 'pending' || this.delivering.has(message.id)) return;
    // Prevent a readiness notification and the sender from delivering the same message twice.
    this.delivering.add(message.id);
    try { await send(`Studio message from ${message.from}:\n${message.text}`); message.status = 'delivered'; }
    catch (error) { message.status = 'failed'; message.error = error instanceof Error ? error.message : 'Codex did not accept the message.'; }
    finally { this.delivering.delete(message.id); }
    this.messageChanged(message);
    await this.persist(target); const sender = this.records.get(message.from); if (sender) await this.persist(sender);
  }
  private messageChanged(message: AgentRunMessage): void {
    for (const id of [message.from, message.to]) {
      const run = this.records.get(id); if (!run) continue;
      const copy = run.messages.find(item => item.id === message.id); if (copy) Object.assign(copy, message);
      this.changed(run);
    }
  }
  private async tool(record: StudioAgentRun, params: CodexJson, signal: AbortSignal): Promise<unknown> {
    try {
      if (params.threadId !== record.threadId || !isRecord(params.arguments)) throw new Error('Invalid run tool request.');
      const args = params.arguments;
      let result: unknown;
      if (params.tool === 'studio_read_document' && this.callbacks.readDocument) result = await this.callbacks.readDocument(record.projectPath);
      else if (params.tool === 'studio_edit_document' && this.callbacks.editDocument) result = await this.callbacks.editDocument(record.projectPath, args.heads as string[], args.edits as StudioDocumentEdit[]);
      else if (String(params.tool).startsWith('studio_workflow_') || params.tool === 'studio_context') result = await this.workflowTool(record, String(params.tool), args, signal);
      else if (params.tool === 'studio_runs') result = { self: record.id, roles: await this.callbacks.templates(record.projectPath), runs: this.list(record.projectId).slice(0, 50).map(run => ({ id: run.id, role: run.title, nodeId: run.nodeId, status: run.status, activity: run.currentActivity, parentRunId: run.parentRunId, controllable: this.canControl(run.id) })) };
      else if (params.tool === 'studio_send_message') result = await this.send(String(args.runId || ''), String(args.message || ''), record.id, String(params.callId || randomId('call')));
      else if (params.tool === 'studio_stop_run') { const child = this.get(String(args.runId || '')); if (!child || child.parentRunId !== record.id) throw new Error('Only your own child can be stopped.'); this.stop(child.id); result = { id: child.id, status: 'stop requested' }; }
      else if (params.tool === 'studio_start_run') {
        const objective = String(args.objective || '').trim(); if (!objective || objective.length > 16_000) throw new Error('Provide a concrete objective of at most 16,000 characters.');
        const child = await this.dispatch(record, String(args.nodeId || ''), objective, String(args.assignmentId || '')); 
        result = { id: child.id, role: child.title, status: child.status };
      } else throw new Error('Unknown Studio run tool.');
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Run tool failed.' }] }; }
  }
  private children(root: StudioAgentRun): StudioAgentRun[] {
    return [...this.records.values()].filter(run => run.workflowId === root.id);
  }
  private async dispatch(parent: StudioAgentRun, nodeId: string, objective: string, assignmentId: string): Promise<StudioAgentRunView> {
    if (parent.workflowId) throw new Error('Return this assignment to the orchestrator; only it dispatches workflow children.');
    if (!parent.workflow) return this.callbacks.startPeer(parent.projectPath, nodeId, objective, parent.id);
    if (!workflowOpen(parent.workflow)) throw new Error('This workflow is paused or finished.');
    const step = parent.workflow.steps.find(step => step.id === assignmentId);
    if (!step) throw new Error('Publish a plan step and use its stable ID as assignmentId.');
    const existing = this.children(parent).find(child => child.assignmentId === assignmentId);
    if (existing) return existing;
    if (step.dependsOn.some(id => !['completed','skipped'].includes(parent.workflow!.steps.find(item => item.id === id)!.status))) throw new Error('Complete this step’s dependencies before dispatching it.');
    const key = `${parent.id}:${assignmentId}`;
    if (!this.dispatches.has(key)) {
      const task = this.callbacks.startPeer(parent.projectPath, nodeId, `${objective}\n\nOwner objective: ${parent.workflow.objective}\nStopping conditions: ${parent.workflow.boundaries}`, parent.id, assignmentId);
      this.dispatches.set(key, task);
      void task.finally(() => this.dispatches.delete(key)).catch(() => {});
    }
    return this.dispatches.get(key)!;
  }
  private unseenChildren(root: StudioAgentRun): StudioAgentRun[] {
    return this.children(root).filter(child => !isActiveAgentRun(child.status) && child.status !== 'interrupted' && root.workflow?.received[child.id] !== `${child.turnId}:${child.finishedAt}`);
  }
  private async workflowTool(root: StudioAgentRun, tool: string, args: CodexJson, signal: AbortSignal): Promise<unknown> {
    const workflow = root.workflow;
    if (!workflow) throw new Error('This tool belongs to an owner-started orchestrator.');
    if (tool === 'studio_context') {
      if (typeof args.runId === 'string') { const run = this.get(args.runId); if (!run || run.projectId !== root.projectId) throw new Error('Run not found in this Studio.'); return { id: run.id, title: run.title, status: run.status, result: run.result, error: run.error, threadId: run.threadId }; }
      return this.callbacks.context?.(root.projectPath, typeof args.nodeId === 'string' ? args.nodeId : undefined);
    }
    if (!workflowOpen(workflow)) throw new Error('This workflow is paused or finished.');
    if (tool === 'studio_workflow_plan') {
      if (typeof args.boundaries !== 'string' || !args.boundaries.trim() || args.boundaries.length > 8000) throw new Error('Include owner stopping conditions of at most 8,000 characters.');
      const steps = readWorkflowSteps(args.steps);
      if (this.children(root).some(child => !steps.some(step => step.id === child.assignmentId))) throw new Error('Keep dispatched step IDs in the plan; mark abandoned steps skipped.');
      workflow.steps = steps; workflow.boundaries = args.boundaries; this.changed(root); await this.persist(root);
      return workflow;
    }
    if (tool === 'studio_workflow_finish') {
      if (!['completed','needs_input'].includes(String(args.status)) || typeof args.outcome !== 'string' || !args.outcome.trim() || args.outcome.length > 16000) throw new Error('Provide completed or needs_input and a concrete outcome of at most 16,000 characters.');
      if (this.children(root).some(child => isActiveAgentRun(child.status) || child.status === 'interrupted')) throw new Error('Wait for or stop outstanding children before finishing.');
      if (args.status === 'completed' && workflow.steps.some(step => !['completed','skipped'].includes(step.status))) throw new Error('Resolve the remaining plan steps before marking the objective complete.');
      workflow.status = args.status as 'completed' | 'needs_input'; workflow.outcome = args.outcome;
      this.changed(root); await this.persist(root); return { status: workflow.status, outcome: workflow.outcome };
    }
    if (tool === 'studio_workflow_wait') {
      if (this.workflowWaiters.has(root.id)) throw new Error('A workflow wait is already pending.');
      if (!this.unseenChildren(root).length && this.children(root).some(child => isActiveAgentRun(child.status))) {
        workflow.status = 'waiting'; root.status = 'waiting'; root.currentActivity = 'Waiting for child results'; this.changed(root); await this.persist(root);
        const control = this.controls.get(root.id)!;
        this.releaseSlot(control); // An idle coordinator must not prevent its queued children from running.
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { this.workflowWaiters.delete(root.id); signal.removeEventListener('abort', abort); };
          const wake = () => { cleanup(); resolve(); };
          const abort = () => { cleanup(); reject(new Error('Workflow wait interrupted.')); };
          this.workflowWaiters.set(root.id, wake); signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort(); else if (this.unseenChildren(root).length || !this.children(root).some(child => isActiveAgentRun(child.status))) wake();
        });
        await this.acquireSlot(control, signal);
      }
      if (workflow.status === 'stopped' || signal.aborted) throw new Error('Workflow stopped.');
      workflow.status = 'active'; root.status = 'running'; root.currentActivity = 'Reviewing child results';
      const children = this.unseenChildren(root);
      const results = children.map(child => ({ id: child.id, assignmentId: child.assignmentId, title: child.title, status: child.status, result: child.result.slice(-12000), resultTruncated: child.result.length > 12000, error: child.error, threadId: child.threadId }));
      for (const child of children) workflow.received[child.id] = `${child.turnId}:${child.finishedAt}`;
      this.changed(root); await this.persist(root);
      return { results, remaining: this.children(root).filter(child => isActiveAgentRun(child.status)).map(child => child.id), instruction: results.length ? 'Review this evidence and continue the objective.' : 'No new child results. Handle owner steering or continue your work; do not poll.' };
    }
    throw new Error('Unknown workflow tool.');
  }
  private workflowTurnEnded(record: StudioAgentRun): void {
    if (this.disposed) return;
    if (record.workflow && workflowOpen(record.workflow)) {
      if (record.status === 'failed' || record.status === 'stopped') {
        record.workflow.status = record.status === 'stopped' ? 'stopped' : 'needs_input'; record.workflow.outcome = record.error || 'Workflow stopped.';
        for (const child of this.children(record)) this.stop(child.id);
      } else if (this.children(record).some(child => isActiveAgentRun(child.status)) || this.unseenChildren(record).length) {
        record.workflow.status = 'waiting'; record.currentActivity = 'Waiting for child results';
      } else {
        record.workflow.status = 'needs_input'; record.workflow.outcome = record.result || 'The native turn ended without a verified workflow outcome. Send a follow-up to continue.';
      }
      this.changed(record); void this.persist(record).catch(() => {});
      this.wakeWorkflow(record);
    }
    if (record.workflowId) {
      const parent = this.records.get(record.workflowId);
      if (parent) this.wakeWorkflow(parent);
    }
  }
  private wakeWorkflow(root: StudioAgentRun): void {
    if (this.disposed || !workflowOpen(root.workflow)) return;
    if (this.workflowWaiters.has(root.id)) { this.workflowWaiters.get(root.id)!(); return; }
    if (!this.controls.has(root.id) && this.unseenChildren(root).length) {
      root.workflow!.status = 'active';
      this.admit(root, 'Child results are ready. Call studio_workflow_wait to receive them, then continue the owner objective using the saved plan.');
    }
  }
  private async recoverWorkflows(projectId: string): Promise<void> {
    if (this.disposed) return;
    const uncertain = new Set<string>();
    const changed = new Set<StudioAgentRun>();
    const deliveryError = 'Message delivery could not be verified after Obsidian reloaded. Codex may already have accepted it. Review native thread history before sending a new follow-up; this message will not be replayed.';
    for (const run of this.records.values()) {
      if (run.projectId !== projectId || run.machine !== this.machine || !run.threadId || this.controls.has(run.id)) continue;
      for (const message of run.messages.filter(message => message.to === run.id && message.status === 'pending')) {
        // A pending local receipt cannot prove that native turn/start or turn/steer failed.
        message.status = 'failed'; message.error = deliveryError; this.messageChanged(message);
        uncertain.add(run.id); changed.add(run);
        const sender = this.records.get(message.from); if (sender) changed.add(sender);
      }
      if (uncertain.has(run.id)) { run.currentActivity = deliveryError; this.changed(run); }
    }
    const roots = [...this.records.values()].filter(run => run.projectId === projectId && run.machine === this.machine && workflowOpen(run.workflow));
    for (const root of roots) {
      if (![root, ...this.children(root)].some(run => uncertain.has(run.id))) continue;
      root.workflow!.status = 'needs_input'; root.workflow!.outcome = deliveryError;
      root.currentActivity = deliveryError; this.changed(root); changed.add(root);
    }
    // Save the pause and uncertain receipts before admitting any recovery turn.
    await Promise.all([...changed].map(record => this.persist(record)));
    if (this.disposed) return;
    for (const root of roots.filter(root => workflowOpen(root.workflow))) {
      for (const run of [...this.children(root), root]) {
        if (run.machine !== this.machine || this.controls.has(run.id) || run.status !== 'interrupted') continue;
        if (run.workflow) run.workflow.received = {}; // Replaying evidence is safe; assignment IDs prevent repeated dispatch.
        this.admit(run, run.threadId ? `Obsidian reloaded during this owner-authorized workflow. Resume the existing assignment from native thread history. Inspect existing work before taking further action; do not repeat completed operations or create duplicate assignments.\n${run.workflow ? 'Use studio_workflow_wait for outstanding child results.' : run.request.prompt}` : run.request.prompt,
          run.preparationPending && this.callbacks.prepare ? () => this.callbacks.prepare!(run) : undefined, undefined, !!run.threadId);
      }
      this.wakeWorkflow(root);
    }
  }
  private emit(projectId: string): void { for (const listener of this.listeners) { try { listener(projectId); } catch (error) { this.plugin.getLogger().error('Run presentation failed', error); } } }
  private changed(record: StudioAgentRun): void {
    record.updatedAt = new Date().toISOString();
    while (record.messages.length > 100 || record.messages.reduce((total, item) => total + item.text.length, 0) > 48_000) {
      const removable = record.messages.findIndex(item => item.status !== 'pending'); if (removable < 0) break; record.messages.splice(removable, 1);
    }
    if (this.disposed) return;
    if (!this.notificationTimers.has(record.projectId)) this.notificationTimers.set(record.projectId, window.setTimeout(() => { this.notificationTimers.delete(record.projectId); this.emit(record.projectId); }, 80));
    if (!this.timers.has(record.id)) this.timers.set(record.id, window.setTimeout(() => { this.timers.delete(record.id); void this.persist(record).catch(() => {}); }, 400));
  }
  private async persist(record: StudioAgentRun): Promise<void> {
    try { await this.store.write(record); delete record.persistenceError; }
    catch (error) { record.persistenceError = error instanceof Error ? error.message : 'Could not save this run.'; this.emit(record.projectId); throw error; }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) window.clearTimeout(timer); this.timers.clear();
    for (const [id, control] of this.controls) {
      control.controller.abort(); const record = this.records.get(id)!; record.status = 'interrupted'; record.currentActivity = 'Obsidian session ended';
      control.reject(new Error('Obsidian session ended.')); await this.persist(record).catch(() => {});
    }
    this.queue.length = 0;
    for (const timer of this.notificationTimers.values()) window.clearTimeout(timer); this.notificationTimers.clear();
    this.listeners.clear(); await this.store.close(); await Promise.all([...this.tasks]); await this.store.flush();
  }
}
