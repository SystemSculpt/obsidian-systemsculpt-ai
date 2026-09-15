import { StudioAgentRuns } from '../StudioAgentRuns';
import { runLocalCodex } from '../LocalCodexClient';
import { codexActivity } from '../CodexActivity';
jest.mock('../LocalCodexClient', () => ({ runLocalCodex: jest.fn() }));
jest.mock('../CodexRequestModal', () => ({ answerCodexRequest: jest.fn(async () => ({ decision: 'decline' })) }));
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { os: async () => ({ hostname: () => 'test-machine' }) } }));
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: () => true }));
jest.mock('../CodexExecutionSettings', () => ({ codexWorkingDirectory: (_app: unknown, path: string) => path }));
const turn = jest.mocked(runLocalCodex);
const spec = (projectId = 'project', nodeId = 'worker') => ({ projectId, projectPath: `${projectId}.systemsculpt`, nodeId, title: 'Worker', request: { prompt: 'Test task', workingDirectory: '/tmp' } });
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function fixture() {
  const files = new Map<string, string>();
  const adapter = { exists: jest.fn(async (path: string) => files.has(path) || !path.endsWith('.json')), mkdir: jest.fn(), write: jest.fn(async (path: string, content: string) => { files.set(path, content); }), read: jest.fn(async (path: string) => files.get(path)), stat: jest.fn(async (path: string) => ({ size: files.get(path)?.length || 0 })), list: jest.fn(async (folder: string) => ({ files: [...files.keys()].filter(path => path.startsWith(folder + '/')) })) };
  const runs = new StudioAgentRuns({ app: { vault: { adapter } }, getLogger: () => ({ error: jest.fn() }) } as any, { templates: async () => [{ id: 'worker', title: 'Worker' }], startPeer: jest.fn() });
  return { runs, files, adapter };
}
let sessions: { cb: any; resolve: () => void; send: jest.Mock; threadId: string }[];
beforeEach(() => {
  jest.useFakeTimers(); sessions = []; turn.mockReset();
  turn.mockImplementation((request, signal, cb) => new Promise((resolve, reject) => {
    const threadId = request.threadId || `thread-${sessions.length}`;
    const session = { cb, threadId, send: jest.fn(async () => {}), resolve: () => resolve({ threadId, text: 'Done', status: 'completed' }) };
    sessions.push(session);
    void cb.thread(threadId).then(() => cb.ready?.({ turnId: `turn-${sessions.length}`, send: session.send }));
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
  const { runs } = fixture(); const a = await runs.start(spec()); await tick(); sessions[0].resolve(); await tick();
  expect(a.status).toBe('completed'); const message = await runs.send(a.id, 'Follow-up'); await tick();
  expect(turn.mock.calls[1][0].threadId).toBe('thread-0'); expect(message.status).toBe('delivered');
  sessions[1].resolve(); await tick(); jest.advanceTimersByTime(10_000); await tick(); expect(sessions).toHaveLength(2); await runs.dispose();
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
it('does not admit a native turn when the initial run record cannot be saved', async () => {
  const { runs, adapter } = fixture(); adapter.write.mockRejectedValue(new Error('Disk full'));
  await expect(runs.start(spec())).rejects.toThrow('Disk full'); expect(turn).not.toHaveBeenCalled(); await runs.dispose();
});
it('projects commands and public plans but excludes reasoning internals', () => {
  expect(codexActivity('item/started', { item: { id: 'c', type: 'commandExecution', command: 'pwd', status: 'inProgress' } })).toMatchObject({ kind: 'command', title: 'pwd' });
  expect(codexActivity('item/completed', { item: { id: 'r', type: 'reasoning', summary: 'private' } })).toBeNull();
});

function workflowFixture(files = new Map<string, string>()) {
  const adapter = { exists: async (path: string) => files.has(path) || !path.endsWith('.json'), mkdir: jest.fn(), write: async (path: string, content: string) => { files.set(path, content); }, read: async (path: string) => files.get(path), stat: async (path: string) => ({ size: files.get(path)?.length || 0 }), list: async (folder: string) => ({ files: [...files.keys()].filter(path => path.startsWith(folder + '/')) }) };
  const plugin = { app: { vault: { adapter } }, getLogger: () => ({ error: jest.fn() }) } as any;
  const runs = new StudioAgentRuns(plugin, {
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
  const { runs, files } = workflowFixture(); const root = await runs.startWorkflow('project.systemsculpt', 'center', 'Inspect fixture'); await tick();
  await call(0, 'studio_workflow_plan', { boundaries: 'Read only', steps });
  const args = { nodeId: 'worker', objective: 'Read fixture', assignmentId: 'inspect' };
  const original = await call(0, 'studio_start_run', args); await tick();
  await runs.dispose(); const reloaded = workflowFixture(files); await reloaded.runs.load('project.systemsculpt', 'project'); await tick();
  expect(sessions).toHaveLength(4); expect(sessions[2].threadId).toBe('thread-1'); expect(sessions[3].threadId).toBe('thread-0');
  expect((await call(3, 'studio_start_run', args)).contentItems).toEqual(original.contentItems);
  expect(reloaded.runs.list('project')).toHaveLength(2); expect(turn.mock.calls[2][0].recoverCompletedTurn).toBe(true);
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
