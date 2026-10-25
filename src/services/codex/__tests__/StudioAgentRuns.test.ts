import { requireApiVersion } from 'obsidian';
import { MAX_LOADED_AGENT_RUNS, STALE_AGENT_RUN_MS, StudioAgentRuns } from '../StudioAgentRuns';
import { createStudioWorkflow } from '../StudioWorkflow';
import { agentRunFolder } from '../StudioAgentRunStore';
import { runLocalCodex } from '../LocalCodexClient';
import { codexActivity } from '../CodexActivity';
import { answerCodexRequest } from '../CodexRequestModal';
jest.mock('../LocalCodexClient', () => ({ runLocalCodex: jest.fn() }));
jest.mock('../CodexRequestModal', () => ({ answerCodexRequest: jest.fn(async () => ({ decision: 'decline' })) }));
let mockHostname = 'test-machine';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { os: async () => ({ hostname: () => mockHostname }) } }));
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: () => true }));
jest.mock('../CodexExecutionSettings', () => ({ codexWorkingDirectory: (_app: unknown, path: string) => path }));
const turn = jest.mocked(runLocalCodex);
const spec = (projectId = 'project', nodeId = 'worker') => ({ projectId, projectPath: `${projectId}.systemsculpt`, nodeId, title: 'Worker', request: { prompt: 'Test task', workingDirectory: '/tmp' } });
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
/** `storage` stands in for vault-scoped local storage, where the machine's stable ID lives. */
function fixture(files = new Map<string, string>(), storage?: Map<string, unknown>) {
  const adapter = { exists: jest.fn(async (path: string) => files.has(path) || !path.endsWith('.json')), mkdir: jest.fn(), write: jest.fn(async (path: string, content: string) => { files.set(path, content); }), read: jest.fn(async (path: string) => files.get(path)), stat: jest.fn(async (path: string) => ({ size: files.get(path)?.length || 0 })), list: jest.fn(async (folder: string) => ({ files: [...files.keys()].filter(path => path.startsWith(folder + '/')) })) };
  const localStorage = storage ? { loadLocalStorage: (key: string) => storage.get(key) ?? null, saveLocalStorage: (key: string, value: unknown) => { storage.set(key, value); } } : {};
  const runs = new StudioAgentRuns({ app: { vault: { adapter }, ...localStorage }, getLogger: () => ({ error: jest.fn() }) } as any, { templates: async () => [{ id: 'worker', title: 'Worker' }], startPeer: jest.fn() });
  return { runs, files, adapter };
}
let sessions: { cb: any; resolve: () => void; send: jest.Mock; threadId: string }[];
beforeEach(() => {
  jest.useFakeTimers(); sessions = []; turn.mockReset();
  turn.mockImplementation((request, signal, cb) => new Promise((resolve, reject) => {
    const threadId = request.threadId || `thread-${sessions.length}`;
    const session = { cb, threadId, send: jest.fn(async () => {}), resolve: () => resolve({ threadId, turnId: `turn-${sessions.length}`, text: 'Done', status: 'completed' }) };
    sessions.push(session);
    void Promise.resolve(cb.thread(threadId)).then(() => cb.ready?.({ turnId: `turn-${sessions.length}`, send: session.send }));
    signal?.addEventListener('abort', () => reject(new Error('Canceled')), { once: true });
  }));
});
afterEach(() => jest.useRealTimers());
it('starts two instances of one role concurrently and stops only the chosen instance', async () => {
  const { runs } = fixture(); const [a, b] = await Promise.all([runs.start(spec()), runs.start(spec())]); await tick();
  expect(a.id).not.toBe(b.id); expect(sessions).toHaveLength(2); expect(a.threadId).not.toBe(b.threadId);
  runs.stop(a.id); await tick(); expect(a.status).toBe('stopped'); expect(b.status).toBe('running');
  sessions[1].resolve(); await tick(); expect(b.status).toBe('completed'); await runs.dispose();
});
it('records delivery only after native steering acknowledges, and deduplicates a tool call', async () => {
  const { runs } = fixture(); const a = await runs.start(spec()), b = await runs.start(spec()); await tick();
  let accepted!: () => void; sessions[1].send.mockImplementation(() => new Promise<void>(resolve => { accepted = resolve; }));
  const result = runs.send(b.id, 'Evidence', a.id, 'call-1'); await tick();
  expect(b.messages[0].status).toBe('pending'); expect(sessions[1].send).toHaveBeenCalledTimes(1);
  const duplicate = runs.send(b.id, 'Evidence', a.id, 'call-1'); accepted();
  expect((await result).status).toBe('delivered'); expect(await duplicate).toBe(await result); expect(a.messages[0].status).toBe('delivered');
  await runs.dispose();
});
it('rejects cross-project handoffs and records rejected native delivery', async () => {
  const { runs } = fixture(); const a = await runs.start(spec()), b = await runs.start(spec('other')); await tick();
  await expect(runs.send(b.id, 'No', a.id)).rejects.toThrow('same project');
  sessions[0].send.mockRejectedValue(new Error('Native turn ended'));
  expect(await runs.send(a.id, 'Owner message')).toMatchObject({ status: 'failed', error: 'Native turn ended' }); await runs.dispose();
});
it('resumes a finished native thread for one explicit message without scheduling another turn', async () => {
  const { runs, files } = fixture(); const a = await runs.start(spec()); await tick(); sessions[0].resolve(); await tick();
  expect(a.status).toBe('completed'); const message = await runs.send(a.id, 'Follow-up'); await tick();
  expect(turn.mock.calls[1][0].threadId).toBe('thread-0'); expect(message.status).toBe('delivered');
  const saved = [...files.values()].map(content => JSON.parse(content)).find(record => record.id === a.id);
  expect(saved.messages[0].status).toBe('delivered'); expect(saved.turnId).toBe(a.turnId);
  sessions[1].resolve(); await tick(); jest.advanceTimersByTime(10_000); await tick(); expect(sessions).toHaveLength(2); await runs.dispose();
});
it('saves streamed text after a few seconds and state changes promptly', async () => {
  const { runs, adapter } = fixture(); const a = await runs.start(spec()); await tick();
  const saves = () => adapter.write.mock.calls.filter(([path]) => String(path).endsWith(`${a.id}.json`)).length;
  const settled = saves();
  for (const text of ['D', 'Do', 'Doing', 'Doing work']) { sessions[0].cb.text(text); jest.advanceTimersByTime(400); await tick(); }
  expect(saves()).toBe(settled);
  jest.advanceTimersByTime(5_000); await tick();
  expect(saves()).toBe(settled + 1);
  expect(a.result).toBe('Doing work');

  // A state change while streamed text waits is saved on the short delay, once.
  sessions[0].cb.text('Doing more work');
  sessions[0].cb.log('Connected to Codex');
  jest.advanceTimersByTime(400); await tick();
  expect(saves()).toBe(settled + 2);
  jest.advanceTimersByTime(10_000); await tick();
  expect(saves()).toBe(settled + 2);
  sessions[0].resolve(); await tick(); await runs.dispose();
});
it('caps concurrent native turns and delivers queued messages once the target is ready', async () => {
  const { runs } = fixture(); const records = await Promise.all(Array.from({ length: 9 }, () => runs.start(spec()))); await tick();
  expect(sessions).toHaveLength(8); const message = await runs.send(records[8].id, 'Queued handoff'); expect(message.status).toBe('pending');
  sessions[0].resolve(); await tick(); expect(sessions).toHaveLength(9); expect(sessions[8].send).toHaveBeenCalledTimes(1); expect(message.status).toBe('delivered'); await runs.dispose();
});
it('exposes native approval as a review action and keeps the request pending until opened', async () => {
  const { runs } = fixture(); const a = await runs.start(spec()); await tick();
  const approval = sessions[0].cb.request('item/commandExecution/requestApproval', { threadId: a.threadId }, new AbortController().signal);
  expect(a.status).toBe('waiting'); expect(runs.hasRequest(a.id)).toBe(true);
  await runs.review(a.id); expect(await approval).toEqual({ decision: 'decline' }); expect(a.status).toBe('running'); await runs.dispose();
});
it('reviews concurrent native requests in order without losing either decision', async () => {
  const { runs } = fixture(); const a = await runs.start(spec()); await tick();
  let firstResolved = false, secondResolved = false;
  const first = sessions[0].cb.request('item/commandExecution/requestApproval', { threadId: a.threadId, itemId: 'first' }, new AbortController().signal).then(() => { firstResolved = true; });
  const second = sessions[0].cb.request('item/tool/requestUserInput', { threadId: a.threadId, itemId: 'second' }, new AbortController().signal).then(() => { secondResolved = true; });
  await runs.review(a.id);
  expect(firstResolved).toBe(true); expect(secondResolved).toBe(false);
  expect(a.status).toBe('waiting'); expect(a.currentActivity).toBe('Waiting for your answer'); expect(runs.hasRequest(a.id)).toBe(true);
  await runs.review(a.id); await Promise.all([first, second]);
  expect(a.status).toBe('running'); expect(runs.hasRequest(a.id)).toBe(false); await runs.dispose();
});
it('keeps a stopped run stopped when an open native review finishes late', async () => {
  const { runs } = fixture(); const a = await runs.start(spec()); await tick();
  let finishReview!: () => void;
  jest.mocked(answerCodexRequest).mockImplementationOnce(() => new Promise(resolve => { finishReview = () => resolve({ decision: 'decline' }); }));
  const approval = sessions[0].cb.request('item/commandExecution/requestApproval', { threadId: a.threadId }, new AbortController().signal);
  void approval.catch(() => {});
  const review = runs.review(a.id); runs.stop(a.id); await tick();
  expect(a.status).toBe('stopped'); finishReview(); await review;
  expect(a.status).toBe('stopped'); expect(runs.hasRequest(a.id)).toBe(false); await runs.dispose();
});
it('cancels one queued native request without discarding the next review', async () => {
  const { runs } = fixture(); const a = await runs.start(spec()); await tick();
  const canceled = new AbortController();
  const first = sessions[0].cb.request('item/commandExecution/requestApproval', { threadId: a.threadId }, canceled.signal);
  void first.catch(() => {});
  const second = sessions[0].cb.request('item/fileChange/requestApproval', { threadId: a.threadId }, new AbortController().signal);
  canceled.abort(); await expect(first).rejects.toThrow('Run stopped');
  expect(runs.hasRequest(a.id)).toBe(true); expect(a.status).toBe('waiting');
  await runs.review(a.id); await expect(second).resolves.toEqual({ decision: 'decline' });
  expect(runs.hasRequest(a.id)).toBe(false); await runs.dispose();
});
it('does not admit a native turn when the initial run record cannot be saved', async () => {
  const { runs, adapter } = fixture(); adapter.write.mockRejectedValue(new Error('Disk full'));
  await expect(runs.start(spec())).rejects.toThrow('Disk full'); expect(turn).not.toHaveBeenCalled(); await runs.dispose();
});
function savedRun(index: number, overrides: Record<string, unknown> = {}) {
  const id = `agent_${1_700_000_000_000 + index}_${index.toString(16).padStart(8, '0')}`;
  const at = new Date(1_700_000_000_000 + index).toISOString();
  return { id, content: JSON.stringify({ schema: 'studio.agent-run.v1', id, projectId: 'project', projectPath: 'project.systemsculpt', nodeId: 'worker', title: 'Worker', owner: 'old', machine: 'test-machine', status: 'completed', createdAt: at, updatedAt: at, threadId: `thread-${index}`, turnId: '', request: { prompt: 'Task', workingDirectory: '/tmp' }, result: 'Done', error: '', currentActivity: 'Completed', activity: [], messages: [], ...overrides }) };
}
it('opens the board with one page of saved runs and shows every older page it loads', async () => {
  const { runs, files } = fixture();
  const folder = agentRunFolder('project.systemsculpt');
  for (let index = 0; index < 260; index++) { const run = savedRun(index); files.set(`${folder}/${run.id}.json`, run.content); }
  await runs.load('project.systemsculpt', 'project');
  expect(runs.list('project')).toHaveLength(50);
  expect(runs.hasOlder('project.systemsculpt')).toBe(true);

  for (let page = 0; page < 4; page++) await runs.loadOlder('project.systemsculpt', 'project');
  // More than 200 loaded runs all reach the board.
  expect(runs.list('project')).toHaveLength(250);
  await runs.loadOlder('project.systemsculpt', 'project');
  expect(runs.list('project')).toHaveLength(260);
  expect(runs.hasOlder('project.systemsculpt')).toBe(false);
  await runs.dispose();

  // The first session indexed every record; the next one reads a single page.
  const next = fixture(); for (const [path, content] of files) next.files.set(path, content);
  await next.runs.load('project.systemsculpt', 'project');
  expect(next.adapter.read.mock.calls.filter(([path]) => !String(path).endsWith('index.json'))).toHaveLength(50);
  await next.runs.dispose();
});
it('projects commands and public plans but excludes reasoning internals', () => {
  expect(codexActivity('item/started', { item: { id: 'c', type: 'commandExecution', command: 'pwd', status: 'inProgress' } })).toMatchObject({ kind: 'command', title: 'pwd' });
  expect(codexActivity('item/completed', { item: { id: 'r', type: 'reasoning', summary: 'private' } })).toBeNull();
});

function workflowFixture(files = new Map<string, string>()) {
  const adapter = { exists: async (path: string) => files.has(path) || !path.endsWith('.json'), mkdir: jest.fn(), write: async (path: string, content: string) => { files.set(path, content); }, read: async (path: string) => files.get(path), stat: async (path: string) => ({ size: files.get(path)?.length || 0 }), list: async (folder: string) => ({ files: [...files.keys()].filter(path => path.startsWith(folder + '/')) }) };
  const plugin = { app: { vault: { adapter } }, getLogger: () => ({ error: jest.fn() }) } as any;
  const runs: StudioAgentRuns = new StudioAgentRuns(plugin, {
    templates: async () => [{ id: 'worker', title: 'Worker' }],
    workflowSpecification: async (_path, center, objective) => ({ ...spec('project', center), request: { prompt: objective, workingDirectory: '/tmp' } }),
    startPeer: (_path, nodeId, objective, parentRunId, assignmentId) => runs.start({ ...spec('project', nodeId), parentRunId, assignmentId, request: { prompt: objective, workingDirectory: '/tmp' } }),
  });
  return { runs, files };
}
const call = (session: number, tool: string, args: unknown = {}) => sessions[session].cb.request('item/tool/call', { threadId: sessions[session].threadId, callId: `${tool}-${session}`, tool, arguments: args }, new AbortController().signal);
const steps = [{ id: 'inspect', title: 'Inspect the fixture', status: 'running', detail: 'Read the fixture and return proof.', dependsOn: [] }];
it('waits for child evidence without polling or another parent turn, then requires explicit verified finish', async () => {
  const { runs } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  expect((await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps })).success).toBe(true);
  const dispatched = await call(0, 'studio_start_run', { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' }); await tick();
  const childId = JSON.parse(dispatched.contentItems[0].text).id;
  let returned = false; const waiting = call(0, 'studio_workflow_wait').then((value: unknown) => { returned = true; return value; }); await tick();
  expect(returned).toBe(false); expect(root.workflow?.status).toBe('waiting'); expect(sessions).toHaveLength(2);
  expect((await call(0, 'studio_workflow_finish', { status: 'completed', outcome: 'Premature' })).success).toBe(false);
  sessions[1].resolve(); await tick(); const evidence: any = await waiting;
  expect(JSON.parse(evidence.contentItems[0].text).results).toEqual([expect.objectContaining({ id: childId, result: 'Done' })]);
  expect(root.workflow?.status).toBe('active'); expect(sessions).toHaveLength(2);
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps: steps.map(step => ({ ...step, status: 'completed' })) });
  expect((await call(0, 'studio_workflow_finish', { status: 'completed', outcome: 'Verified fixture and child evidence.' })).success).toBe(true);
  sessions[0].resolve(); await tick(); expect(root.workflow?.status).toBe('completed'); await runs.dispose();
});
it('deduplicates concurrent and replayed assignment dispatches and preserves stop across reload', async () => {
  const { runs, files } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps });
  const args = { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' };
  const pair = await Promise.all([call(0, 'studio_start_run', args), call(0, 'studio_start_run', args)]); await tick();
  expect(pair[0]).toEqual(pair[1]); expect(sessions).toHaveLength(2);
  runs.stop(root.id); await tick(); expect(root.workflow?.status).toBe('stopped'); expect(runs.list('project').every(run => run.status === 'stopped')).toBe(true);
  await runs.dispose(); const reloaded = workflowFixture(files); await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  expect(sessions).toHaveLength(2); expect(reloaded.runs.get(root.id)?.workflow?.status).toBe('stopped'); await reloaded.runs.dispose();
});
it('recovers the same workflow and child thread after reload without a duplicate child', async () => {
  const { runs, files } = workflowFixture(); await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps });
  const args = { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' };
  const original = await call(0, 'studio_start_run', args); await tick();
  await runs.dispose(); const reloaded = workflowFixture(files); await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  expect(sessions).toHaveLength(4); expect(sessions[2].threadId).toBe('thread-1'); expect(sessions[3].threadId).toBe('thread-0');
  expect((await call(3, 'studio_start_run', args)).contentItems).toEqual(original.contentItems);
  expect(reloaded.runs.list('project')).toHaveLength(2); expect(turn.mock.calls[2][0].recoverCompletedTurn).toBe(true);
  await reloaded.runs.dispose();
});
it('recovers an open workflow after reload even when newer runs push it past the first page', async () => {
  const { runs, files } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await runs.dispose();
  const folder = agentRunFolder('project.systemsculpt');
  expect(JSON.parse(files.get(`${folder}/index.json`)!).runs[root.id]).toMatchObject({ workflowOpen: true });
  for (let index = 0; index < 60; index++) {
    const id = `agent_${Date.now() + 1_000 + index}_${index.toString(16).padStart(8, '0')}`, at = new Date().toISOString();
    files.set(`${folder}/${id}.json`, JSON.stringify({ schema: 'studio.agent-run.v1', id, projectId: 'project', projectPath: 'project.systemsculpt', nodeId: 'worker', title: 'Worker', owner: 'old', machine: 'test-machine', status: 'completed', createdAt: at, updatedAt: at, threadId: `thread-x${index}`, turnId: '', request: { prompt: 'Task', workingDirectory: '/tmp' }, result: 'Done', error: '', currentActivity: 'Completed', activity: [], messages: [] }));
  }
  const reloaded = workflowFixture(files); await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  expect(reloaded.runs.get(root.id)?.workflow?.status).toBe('active');
  expect(sessions).toHaveLength(2); expect(sessions[1].threadId).toBe(root.threadId);
  await reloaded.runs.dispose();
});
it('keeps the loaded runs bounded when the board pages past the cap, keeping live runs', async () => {
  const { runs, files } = fixture();
  const folder = agentRunFolder('project.systemsculpt');
  const total = MAX_LOADED_AGENT_RUNS + 200;
  for (let index = 1; index < total; index++) { const run = savedRun(index); files.set(`${folder}/${run.id}.json`, run.content); }
  const open = savedRun(0, { machine: 'laptop', status: 'waiting', workflow: { ...createStudioWorkflow('Long-running'), status: 'waiting' } });
  files.set(`${folder}/${open.id}.json`, open.content);
  const newest = savedRun(total - 1).id;

  await runs.load('project.systemsculpt', 'project');
  for (let page = 0; page < 40 && runs.hasOlder('project.systemsculpt'); page++) await runs.loadOlder('project.systemsculpt', 'project');

  const loaded = runs.list('project');
  expect(loaded).toHaveLength(MAX_LOADED_AGENT_RUNS);
  expect(runs.isCapped('project.systemsculpt')).toBe(true);
  expect(runs.hasOlder('project.systemsculpt')).toBe(false);
  expect(loaded.map(run => run.id)).toEqual(expect.arrayContaining([open.id, newest]));

  // Paging again is refused rather than growing the cache.
  await runs.loadOlder('project.systemsculpt', 'project');
  expect(runs.list('project')).toHaveLength(MAX_LOADED_AGENT_RUNS);

  await runs.refresh('project.systemsculpt', 'project');
  expect(runs.isCapped('project.systemsculpt')).toBe(false);
  expect(runs.list('project').length).toBeLessThanOrEqual(MAX_LOADED_AGENT_RUNS);
  await runs.dispose();
});
it('notifies every open board affected by the shared run cap', async () => {
  const { runs, files } = fixture();
  const firstFolder = agentRunFolder('project.systemsculpt');
  for (let index = 0; index < MAX_LOADED_AGENT_RUNS; index++) {
    const run = savedRun(index); files.set(`${firstFolder}/${run.id}.json`, run.content);
  }
  await runs.load('project.systemsculpt', 'project');
  while (runs.hasOlder('project.systemsculpt')) await runs.loadOlder('project.systemsculpt', 'project');
  expect(runs.list('project')).toHaveLength(MAX_LOADED_AGENT_RUNS);
  const updates: { projectId: string; count: number; capped: boolean }[] = [];
  runs.subscribe(projectId => updates.push({ projectId, count: runs.list(projectId).length, capped: runs.isCapped(`${projectId}.systemsculpt`) }));
  const secondFolder = agentRunFolder('other.systemsculpt');
  for (let index = MAX_LOADED_AGENT_RUNS; index < MAX_LOADED_AGENT_RUNS + 50; index++) {
    const run = savedRun(index, { projectId: 'other', projectPath: 'other.systemsculpt' });
    files.set(`${secondFolder}/${run.id}.json`, run.content);
  }
  await runs.load('other.systemsculpt', 'other');
  expect(updates).toEqual(expect.arrayContaining([
    { projectId: 'project', count: MAX_LOADED_AGENT_RUNS - 50, capped: true },
    { projectId: 'other', count: 50, capped: false },
  ]));
  expect(updates.filter(update => update.projectId === 'project')).toHaveLength(1);
  await runs.dispose();
});
it.each([160, MAX_LOADED_AGENT_RUNS + 200])('restarts paging immediately after the refreshed newest page (%i saved runs)', async total => {
  const { runs, files, adapter } = fixture();
  const folder = agentRunFolder('project.systemsculpt');
  for (let index = 0; index < total; index++) {
    const run = savedRun(index); files.set(`${folder}/${run.id}.json`, run.content);
  }
  await runs.load('project.systemsculpt', 'project');
  if (total > MAX_LOADED_AGENT_RUNS) {
    while (runs.hasOlder('project.systemsculpt')) await runs.loadOlder('project.systemsculpt', 'project');
    expect(runs.isCapped('project.systemsculpt')).toBe(true);
  } else await runs.loadOlder('project.systemsculpt', 'project');
  await runs.refresh('project.systemsculpt', 'project');
  adapter.read.mockClear();
  await runs.loadOlder('project.systemsculpt', 'project');
  const expected = Array.from({ length: 50 }, (_, offset) => `${folder}/${savedRun(total - 100 + offset).id}.json`);
  expect(adapter.read.mock.calls.map(([path]) => path)).toEqual(expected);
  await runs.dispose();
});
it.each([160, MAX_LOADED_AGENT_RUNS + 200])('ignores an older page that finishes after Refresh (%i saved runs)', async total => {
  const { runs, files, adapter } = fixture();
  const folder = agentRunFolder('project.systemsculpt');
  for (let index = 0; index < total; index++) {
    const run = savedRun(index); files.set(`${folder}/${run.id}.json`, run.content);
  }
  await runs.load('project.systemsculpt', 'project');
  await runs.loadOlder('project.systemsculpt', 'project');
  if (total > MAX_LOADED_AGENT_RUNS) {
    while (runs.list('project').length < MAX_LOADED_AGENT_RUNS) await runs.loadOlder('project.systemsculpt', 'project');
  }
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  adapter.read.mockImplementationOnce(async path => { blocked = true; await paused; return files.get(path); });
  const oldPage = runs.loadOlder('project.systemsculpt', 'project');
  await tick(); expect(blocked).toBe(true);
  await runs.refresh('project.systemsculpt', 'project');
  release(); await oldPage;
  expect(runs.isCapped('project.systemsculpt')).toBe(false);
  adapter.read.mockClear();
  await runs.loadOlder('project.systemsculpt', 'project');
  const expected = Array.from({ length: 50 }, (_, offset) => `${folder}/${savedRun(total - 100 + offset).id}.json`);
  expect(adapter.read.mock.calls.map(([path]) => path)).toEqual(expected);
  await runs.dispose();
});
it('recovers an old open workflow after reload when the run index is missing', async () => {
  const { runs, files } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await runs.dispose();
  const folder = agentRunFolder('project.systemsculpt');
  files.delete(`${folder}/index.json`);
  for (let index = 0; index < 60; index++) {
    const run = savedRun(index, { createdAt: new Date(Date.now() + 1_000 + index).toISOString() });
    files.set(`${folder}/agent_${Date.now() + 1_000 + index}_${index.toString(16).padStart(8, '0')}.json`, run.content.replace(run.id, `agent_${Date.now() + 1_000 + index}_${index.toString(16).padStart(8, '0')}`));
  }
  const reloaded = workflowFixture(files); await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  expect(reloaded.runs.get(root.id)?.workflow?.status).toBe('active');
  expect(sessions).toHaveLength(2); expect(sessions[1].threadId).toBe(root.threadId);
  await reloaded.runs.dispose();
});
it('pauses ambiguous delivery after a crash and resumes only the new owner follow-up', async () => {
  const { runs, files } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  sessions[0].resolve(); await tick();
  await runs.send(root.id, 'Perform the requested change'); await tick();
  expect(sessions).toHaveLength(2);
  // The native turn accepted the message, but the process crashed before its receipt was saved.
  const crashFiles = new Map(files);
  for (const [path, content] of crashFiles) {
    const saved = JSON.parse(content); if (saved.id !== root.id) continue;
    saved.status = 'running'; saved.workflow.status = 'active';
    saved.messages[0].status = 'pending'; crashFiles.set(path, JSON.stringify(saved));
  }
  await runs.dispose(); const reloaded = workflowFixture(crashFiles);
  await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  const restored = reloaded.runs.get(root.id)!;
  expect(sessions).toHaveLength(2);
  expect(restored.workflow?.status).toBe('needs_input');
  expect(restored.workflow?.outcome).toContain('could not be verified');
  expect(restored.messages[0]).toMatchObject({ status: 'failed', text: 'Perform the requested change' });
  expect(restored.messages[0].error).toContain('may already have accepted');
  expect([...crashFiles.values()].map(content => JSON.parse(content)).find(record => record.id === root.id).workflow.status).toBe('needs_input');
  await reloaded.runs.send(root.id, 'I checked native history. Verify the existing change; do not repeat it.'); await tick();
  expect(sessions).toHaveLength(3); expect(sessions[2].threadId).toBe(root.threadId);
  expect(turn.mock.calls[2][0].prompt).toContain('I checked native history');
  expect(sessions[2].send).not.toHaveBeenCalled();
  await reloaded.runs.dispose();
});
it('pauses the whole workflow when a child steering receipt is uncertain', async () => {
  const { runs, files } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps });
  await call(0, 'studio_start_run', { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' }); await tick();
  const child = runs.list('project').find(run => run.parentRunId === root.id)!;
  await runs.send(child.id, 'Check one more detail'); await tick();
  const crashFiles = new Map(files);
  for (const [path, content] of crashFiles) {
    const saved = JSON.parse(content); if (saved.id !== child.id) continue;
    saved.messages[0].status = 'pending'; crashFiles.set(path, JSON.stringify(saved));
  }
  await runs.dispose(); const reloaded = workflowFixture(crashFiles);
  await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  expect(sessions).toHaveLength(2); expect(reloaded.runs.get(root.id)?.workflow?.status).toBe('needs_input');
  expect(reloaded.runs.get(child.id)?.messages[0].status).toBe('failed');
  await reloaded.runs.dispose();
});
it('delivers child completion to the same parent thread when its native turn ended while waiting', async () => {
  const { runs } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps });
  await call(0, 'studio_start_run', { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' }); await tick();
  sessions[0].resolve(); await tick(); expect(root.workflow?.status).toBe('waiting'); expect(sessions).toHaveLength(2);
  sessions[1].resolve(); await tick(); expect(sessions).toHaveLength(3); expect(sessions[2].threadId).toBe('thread-0');
  expect(root.workflow?.status).toBe('active'); await runs.dispose();
});
it('does not allow nested child fanout, cross-workflow finishing, or cyclic plans', async () => {
  const { runs } = workflowFixture(); await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  expect((await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps: [{ ...steps[0], dependsOn: ['inspect'] }] })).success).toBe(false);
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps });
  await call(0, 'studio_start_run', { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' }); await tick();
  expect((await call(1, 'studio_start_run', { nodeId: 'worker', objective: 'Nested', assignmentId: 'nested' })).success).toBe(false);
  expect((await call(1, 'studio_workflow_finish', { status: 'completed', outcome: 'No' })).success).toBe(false);
  await runs.dispose();
});
it('releases execution capacity while coordinators wait, so queued children cannot deadlock', async () => {
  const { runs } = workflowFixture();
  const roots = await Promise.all(Array.from({ length: 8 }, (_, index) => runs.startWorkflow('project.systemsculpt', `center-${index}`, 'Inspect fixture'))); await tick();
  expect(sessions).toHaveLength(8);
  for (let index = 0; index < 8; index++) {
    await call(index, 'studio_workflow_plan', { boundaries: 'Read only', steps });
    await call(index, 'studio_start_run', { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' });
  }
  const waiting = roots.map((_, index) => call(index, 'studio_workflow_wait')); await tick();
  expect(sessions).toHaveLength(16); expect(roots.every(root => root.status === 'waiting')).toBe(true);
  for (const session of sessions.slice(8)) session.resolve(); await tick();
  expect((await Promise.all(waiting)).every(result => result.success)).toBe(true);
  expect(roots.every(root => root.status === 'running')).toBe(true);
  await runs.dispose();
});

describe('machine identity', () => {
  const folder = agentRunFolder('project.systemsculpt'), api = jest.mocked(requireApiVersion), hostApi = api.getMockImplementation()!;
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const saved = (files: Map<string, string>, id: string) => JSON.parse(files.get(`${folder}/${id}.json`)!);
  /** A run another machine with a stable ID is executing, or was when it last saved. */
  const elsewhere = (index: number, overrides: Record<string, unknown> = {}) => savedRun(index, { status: 'running', machine: 'laptop.local', machineId: 'a1b2c3d4e5f6', currentActivity: 'Codex is working', ...overrides });
  beforeEach(() => { api.mockImplementation(() => true); mockHostname = 'mac.local'; });
  afterEach(() => { api.mockImplementation(hostApi); mockHostname = 'test-machine'; });

  it('keeps its own runs across a hostname change and still owns older records saved under its current hostname', async () => {
    const storage = new Map<string, unknown>(), first = fixture(new Map(), storage);
    const run = await first.runs.start(spec()); await tick();
    const machineId = storage.get('systemsculpt-studio-device');
    expect(machineId).toMatch(/^[0-9a-f]{12}$/);
    expect(saved(first.files, run.id)).toMatchObject({ machine: 'mac.local', machineId, status: 'running' });

    // Obsidian ends without a clean shutdown, and macOS then renames the host after a name conflict.
    const crashed = new Map(first.files);
    const current = savedRun(1, { status: 'running', machine: 'mac-2.local' });
    const previous = savedRun(2, { status: 'running', machine: 'mac.local' });
    const sameName = elsewhere(3, { machine: 'mac-2.local' });
    for (const record of [current, previous, sameName]) crashed.set(`${folder}/${record.id}.json`, record.content);
    mockHostname = 'mac-2.local';
    const second = fixture(crashed, storage); await second.runs.load('project.systemsculpt', 'project');

    // Its stable ID still names this machine's run, so it is settled and controllable here.
    expect(second.runs.get(run.id)?.status).toBe('interrupted'); expect(second.runs.canControl(run.id)).toBe(true);
    // A record saved before machines had an ID belongs to whichever machine has its hostname now.
    expect(second.runs.get(current.id)?.status).toBe('interrupted'); expect(second.runs.canControl(current.id)).toBe(true);
    expect(second.runs.get(previous.id)?.status).toBe('running'); expect(second.runs.canControl(previous.id)).toBe(false);
    expect(second.runs.isStale(previous.id)).toBe(true); expect(second.runs.canMarkStopped(previous.id)).toBe(true);
    // Another machine with the same hostname but its own ID keeps its run.
    expect(second.runs.get(sameName.id)?.status).toBe('running'); expect(second.runs.canControl(sameName.id)).toBe(false);

    // Resuming the run records the new hostname under the same ID.
    await first.runs.dispose();
    const message = await second.runs.send(run.id, 'Continue'); await tick();
    expect(message.status).toBe('delivered');
    expect(saved(crashed, run.id)).toMatchObject({ machine: 'mac-2.local', machineId, status: 'running' });
    expect(turn.mock.calls.at(-1)?.[0].threadId).toBe(run.threadId);
    await second.runs.dispose();
  });

  it("shows another machine's active run as stale only once its saved record stops changing", async () => {
    const files = new Map<string, string>(), run = elsewhere(1, { updatedAt: minutesAgo(2) }), path = `${folder}/${run.id}.json`;
    files.set(path, run.content);
    const { runs, adapter } = fixture(files, new Map()), updates: string[] = [];
    runs.subscribe(projectId => updates.push(projectId));
    await runs.load('project.systemsculpt', 'project');
    expect(runs.get(run.id)?.status).toBe('running'); expect(runs.canControl(run.id)).toBe(false); expect(runs.isStale(run.id)).toBe(false);

    // The laptop saves again before the run would turn stale here, so it stays live.
    jest.advanceTimersByTime(5 * 60_000);
    files.set(path, elsewhere(1, { updatedAt: new Date().toISOString(), currentActivity: 'Running tests' }).content);
    adapter.read.mockClear();
    jest.advanceTimersByTime(3 * 60_000); await tick();
    expect(adapter.read).toHaveBeenCalledWith(path);
    expect(runs.get(run.id)?.currentActivity).toBe('Running tests'); expect(runs.isStale(run.id)).toBe(false);

    // Then it stops saving: ten minutes after its last change, the run is stale and open boards hear of it.
    updates.length = 0;
    jest.advanceTimersByTime(STALE_AGENT_RUN_MS); await tick();
    expect(runs.isStale(run.id)).toBe(true); expect(updates).toContain('project');
    // Presentation only: the record still says what the laptop last saved.
    expect(runs.get(run.id)?.status).toBe('running'); expect(saved(files, run.id).status).toBe('running');

    // Stale runs are read again every ten minutes, so one the laptop saves again comes back live.
    jest.advanceTimersByTime(2 * 60_000);
    files.set(path, elsewhere(1, { updatedAt: new Date().toISOString(), currentActivity: 'Approved' }).content);
    jest.advanceTimersByTime(6 * 60_000); await tick();
    expect(runs.isStale(run.id)).toBe(false); expect(runs.get(run.id)?.currentActivity).toBe('Approved');
    await runs.dispose();
  });

  it('counts a save dated in the future as now, without a busy timer', async () => {
    const files = new Map<string, string>(), run = elsewhere(1, { updatedAt: '2100-01-01T00:00:00.000Z' });
    files.set(`${folder}/${run.id}.json`, run.content);
    const { runs, adapter } = fixture(files, new Map()); await runs.load('project.systemsculpt', 'project');
    adapter.read.mockClear(); const timers = jest.spyOn(window, 'setTimeout');
    jest.advanceTimersByTime(60_000); await tick();
    expect(adapter.read).not.toHaveBeenCalled(); expect(timers).not.toHaveBeenCalled(); timers.mockRestore();
    jest.advanceTimersByTime(STALE_AGENT_RUN_MS); await tick();
    expect(adapter.read).toHaveBeenCalledTimes(1);
    await runs.dispose();
  });

  it('shows an open workflow between turns as stale once all its active assignments are', async () => {
    const files = new Map<string, string>();
    const root = elsewhere(1, { nodeId: 'center', status: 'completed', workflow: { ...createStudioWorkflow('Elsewhere'), status: 'waiting' } }), rootId = JSON.parse(root.content).id;
    const quiet = elsewhere(2, { workflowId: rootId, parentRunId: rootId, assignmentId: 'quiet' });
    const busy = elsewhere(3, { workflowId: rootId, parentRunId: rootId, assignmentId: 'busy', updatedAt: minutesAgo(1) });
    for (const record of [root, quiet, busy]) files.set(`${folder}/${record.id}.json`, record.content);
    const { runs } = fixture(files, new Map()); await runs.load('project.systemsculpt', 'project');
    expect(runs.isStale(quiet.id)).toBe(true); expect(runs.isStale(busy.id)).toBe(false); expect(runs.isStale(rootId)).toBe(false);
    jest.advanceTimersByTime(STALE_AGENT_RUN_MS); await tick();
    expect(runs.isStale(busy.id)).toBe(true); expect(runs.isStale(rootId)).toBe(true);
    await runs.dispose();
  });

  it('marks stopped only runs this machine cannot stop, saving the record and admitting nothing', async () => {
    const files = new Map<string, string>(), stale = elsewhere(1);
    const root = elsewhere(2, { nodeId: 'center', status: 'completed', workflow: { ...createStudioWorkflow('Elsewhere'), status: 'waiting' } });
    const rootId = JSON.parse(root.content).id;
    const child = elsewhere(3, { workflowId: rootId, parentRunId: rootId, assignmentId: 'inspect' });
    for (const record of [stale, root, child]) files.set(`${folder}/${record.id}.json`, record.content);
    const { runs } = fixture(files, new Map()); await runs.load('project.systemsculpt', 'project');
    const own = await runs.start(spec()); await tick();

    expect(runs.canMarkStopped(own.id)).toBe(false); await runs.markStopped(own.id); expect(own.status).toBe('running');
    // Agents see the same state through studio_runs.
    const listed = JSON.parse((await call(0, 'studio_runs')).contentItems[0].text).runs;
    expect(listed.find((run: { id: string }) => run.id === stale.id)).toMatchObject({ status: 'running', controllable: false, stale: true });
    expect(listed.find((run: { id: string }) => run.id === own.id)).toMatchObject({ controllable: true }); expect(listed.find((run: { id: string }) => run.id === own.id).stale).toBeUndefined();
    // Stop still refuses another machine's run; Mark stopped is the way to clear it.
    runs.stop(stale.id); expect(runs.get(stale.id)?.status).toBe('running');
    expect(runs.canMarkStopped(stale.id)).toBe(true);
    await runs.markStopped(stale.id);
    expect(runs.get(stale.id)).toMatchObject({ status: 'stopped', currentActivity: 'Marked stopped' });
    expect(runs.isStale(stale.id)).toBe(false); expect(runs.canMarkStopped(stale.id)).toBe(false);
    expect(saved(files, stale.id)).toMatchObject({ status: 'stopped', machine: 'laptop.local', machineId: 'a1b2c3d4e5f6' });

    // An open workflow settles with its active assignments.
    expect(runs.canMarkStopped(rootId)).toBe(true);
    await runs.markStopped(rootId);
    expect(runs.get(rootId)?.workflow?.status).toBe('stopped'); expect(runs.get(child.id)?.status).toBe('stopped');
    expect(saved(files, rootId).workflow.status).toBe('stopped'); expect(saved(files, child.id).status).toBe('stopped');
    expect(turn).toHaveBeenCalledTimes(1);

    // If the laptop saves the marked run again, it shows here again within ten minutes.
    files.set(`${folder}/${stale.id}.json`, elsewhere(1, { updatedAt: new Date(Date.now() + 1).toISOString(), currentActivity: 'Still working' }).content);
    jest.advanceTimersByTime(STALE_AGENT_RUN_MS); await tick();
    expect(runs.get(stale.id)).toMatchObject({ status: 'running', currentActivity: 'Still working' });
    await runs.dispose();
  });

  it('settles the latest saved copy, keeping what the other machine saved since', async () => {
    const files = new Map<string, string>(), finished = elsewhere(1, { status: 'waiting', currentActivity: 'Waiting for native approval' }), working = elsewhere(2);
    for (const record of [finished, working]) files.set(`${folder}/${record.id}.json`, record.content);
    const { runs } = fixture(files, new Map()); await runs.load('project.systemsculpt', 'project');
    // After this device last read them, the laptop finished one run and added a result to the other.
    const later = new Date().toISOString();
    files.set(`${folder}/${finished.id}.json`, elsewhere(1, { status: 'completed', result: 'FINAL ANSWER', currentActivity: 'Completed', updatedAt: later }).content);
    files.set(`${folder}/${working.id}.json`, elsewhere(2, { result: 'Partial answer', updatedAt: later }).content);

    await runs.markStopped(finished.id);
    expect(runs.get(finished.id)).toMatchObject({ status: 'completed', result: 'FINAL ANSWER' });
    expect(saved(files, finished.id)).toMatchObject({ status: 'completed', result: 'FINAL ANSWER', updatedAt: later });
    await runs.markStopped(working.id);
    expect(saved(files, working.id)).toMatchObject({ status: 'stopped', result: 'Partial answer', currentActivity: 'Marked stopped' });
    await runs.dispose();
  });

  it('adds no time limit to a run this machine is executing', async () => {
    const { runs } = fixture(new Map(), new Map()); const run = await runs.start(spec()); await tick();
    jest.advanceTimersByTime(6 * 60 * 60_000); await tick();
    expect(run.status).toBe('running'); expect(runs.isStale(run.id)).toBe(false); expect(runs.canMarkStopped(run.id)).toBe(false);
    sessions[0].resolve(); await tick(); expect(run.status).toBe('completed'); await runs.dispose();
  });
});
