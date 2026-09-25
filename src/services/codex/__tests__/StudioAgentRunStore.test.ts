import {
  AGENT_RUN_PAGE_SIZE,
  AGENT_RUN_RETAINED_RECORDS,
  StudioAgentRunStore,
  agentRunFolder,
  type StudioAgentRun,
} from '../StudioAgentRunStore';
import { createStudioWorkflow } from '../StudioWorkflow';

const projectPath = 'Studio/Board.systemsculpt';
const folder = agentRunFolder(projectPath);
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Run IDs embed their creation time, so older runs sort first. */
function runId(sequence: number, createdDaysAgo = 1): string {
  return `agent_${NOW - createdDaysAgo * DAY + sequence * 1000}_${sequence.toString(16).padStart(8, '0')}`;
}

function record(sequence: number, overrides: Partial<StudioAgentRun> = {}, createdDaysAgo = 1): StudioAgentRun {
  const at = new Date(NOW - createdDaysAgo * DAY).toISOString();
  return {
    schema: 'studio.agent-run.v1', id: runId(sequence, createdDaysAgo), projectId: 'project', projectPath, nodeId: 'worker', title: 'Worker',
    owner: 'session', machine: 'desk', status: 'completed', createdAt: at, updatedAt: at,
    threadId: `thread-${sequence}`, turnId: '', request: { prompt: 'Task', workingDirectory: '/tmp' },
    result: '', error: '', currentActivity: 'Completed', activity: [], messages: [], ...overrides,
  };
}

function fixture(records: StudioAgentRun[], index?: unknown) {
  const files = new Map<string, string>();
  for (const run of records) files.set(`${folder}/${run.id}.json`, JSON.stringify(run));
  if (index !== undefined) files.set(`${folder}/index.json`, JSON.stringify(index));
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || !path.endsWith('.json')),
    mkdir: jest.fn(async () => {}),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
    read: jest.fn(async (path: string) => { const content = files.get(path); if (content === undefined) throw new Error('missing'); return content; }),
    stat: jest.fn(async (path: string) => ({ size: files.get(path)?.length ?? 0 })),
    remove: jest.fn(async (path: string) => { files.delete(path); }),
    list: jest.fn(async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] })),
  };
  const store = new StudioAgentRunStore({ vault: { adapter } } as any);
  const savedIndex = () => JSON.parse(files.get(`${folder}/index.json`) ?? 'null');
  const recordReads = () => adapter.read.mock.calls.filter(([path]) => !String(path).endsWith('index.json')).length;
  return { store, files, adapter, savedIndex, recordReads };
}

afterEach(() => jest.useRealTimers());

it('opens a board by reading one page plus the runs the index marks as live, even past 5,000 records', async () => {
  const runs = Array.from({ length: 5_100 }, (_, sequence) => record(sequence));
  runs[3] = record(3, { status: 'waiting', workflow: { ...createStudioWorkflow('Ship'), status: 'waiting' } });
  runs[4] = record(4, { status: 'interrupted', workflowId: runId(3), parentRunId: runId(3) });
  const index = { schema: 'studio.agent-run-index.v1', runs: {
    [runId(3)]: { status: 'waiting', day: '2026-09-24', workflowOpen: true },
    [runId(4)]: { status: 'interrupted', day: '2026-09-24', workflowId: runId(3), parentRunId: runId(3) },
  } };
  const { store, recordReads, adapter } = fixture(runs, index);

  const page = await store.list(projectPath, 'project');

  expect(page.records).toHaveLength(AGENT_RUN_PAGE_SIZE + 2);
  expect(page.records.map(run => run.id)).toEqual(expect.arrayContaining([runId(3), runId(4), runId(5_099)]));
  expect(page.before).toBe(runId(5_100 - AGENT_RUN_PAGE_SIZE));
  expect(page.olderRemaining).toBe(5_100 - AGENT_RUN_PAGE_SIZE);
  expect(recordReads()).toBe(AGENT_RUN_PAGE_SIZE + 2);
  expect(adapter.stat).toHaveBeenCalledTimes(AGENT_RUN_PAGE_SIZE + 2);
});

it('reads older pages from the cursor it returned', async () => {
  const { store } = fixture(Array.from({ length: 120 }, (_, sequence) => record(sequence)));
  const first = await store.list(projectPath, 'project');
  const second = await store.list(projectPath, 'project', { before: first.before! });
  const third = await store.list(projectPath, 'project', { before: second.before! });

  expect(second.records.map(run => run.id)).toEqual(Array.from({ length: 50 }, (_, index) => runId(20 + index)));
  expect(third.records.map(run => run.id)).toEqual(Array.from({ length: 20 }, (_, index) => runId(index)));
  expect(third.olderRemaining).toBe(0);
});

it('indexes status and workflow changes once, not every activity update', async () => {
  jest.useFakeTimers();
  const { store, adapter, savedIndex } = fixture([]);
  const run = record(1, { status: 'running', updatedAt: '2026-09-25T10:00:00.000Z' });
  await store.write(run);
  await store.write({ ...run, currentActivity: 'Reading', updatedAt: '2026-09-25T10:00:05.000Z' });
  jest.advanceTimersByTime(1_000);
  await store.flush();
  expect(savedIndex()).toEqual({ schema: 'studio.agent-run-index.v1', runs: { [run.id]: { status: 'running', day: '2026-09-25' } } });
  const indexWrites = () => adapter.write.mock.calls.filter(([path]) => String(path).endsWith('index.json')).length;
  expect(indexWrites()).toBe(1);

  await store.write({ ...run, currentActivity: 'Still reading', updatedAt: '2026-09-25T10:01:00.000Z' });
  jest.advanceTimersByTime(1_000);
  await store.flush();
  expect(indexWrites()).toBe(1);

  await store.write({ ...run, status: 'completed', updatedAt: '2026-09-25T10:02:00.000Z' });
  await store.flush();
  expect(indexWrites()).toBe(2);
  expect(savedIndex().runs[run.id].status).toBe('completed');
});

it('rebuilds a damaged index from the records it reads', async () => {
  jest.useFakeTimers();
  const { store, files, savedIndex } = fixture([record(1), record(2, { status: 'running' })]);
  files.set(`${folder}/index.json`, '{not json');

  await store.list(projectPath, 'project');
  await store.flush();

  expect(Object.keys(savedIndex().runs)).toEqual([runId(1), runId(2)]);
  expect(savedIndex().runs[runId(2)].status).toBe('running');
});

describe('on-disk retention', () => {
  const oldDay = new Date(NOW - 120 * DAY).toISOString();

  it('removes records beyond the newest 1,000, keeping live runs, their assignments and loaded runs', async () => {
    const runs = Array.from({ length: AGENT_RUN_RETAINED_RECORDS + 5 }, (_, sequence) => record(sequence));
    runs[0] = record(0, { status: 'running' });
    runs[1] = record(1, { workflow: { ...createStudioWorkflow('Open'), status: 'active' } });
    runs[2] = record(2, { workflowId: runId(1), parentRunId: runId(1) });
    const { store, files, recordReads } = fixture(runs);

    const removed = await store.prune(projectPath, 'project', new Set([runId(4)]), NOW);

    const kept = (sequence: number) => files.has(`${folder}/${runId(sequence)}.json`);
    expect([0, 1, 2, 3, 4, 5].map(kept)).toEqual([true, true, true, false, true, true]);
    expect(removed).toBe(1);
    // Only the four runs beyond the newest 1,000 are read, never the retained ones.
    expect(recordReads()).toBe(4);
  });

  it('removes records unchanged for 90 days and keeps an old run that changed recently', async () => {
    jest.useFakeTimers();
    const runs = [
      record(0, { updatedAt: oldDay }, 120),
      record(1, { updatedAt: new Date(NOW - 2 * DAY).toISOString() }, 120),
      record(2),
    ];
    const { store, files, savedIndex, recordReads } = fixture(runs);

    expect(await store.prune(projectPath, 'project', new Set(), NOW)).toBe(1);
    await store.flush();

    expect(files.has(`${folder}/${runs[0].id}.json`)).toBe(false);
    expect(files.has(`${folder}/${runs[1].id}.json`)).toBe(true);
    expect(files.has(`${folder}/${runs[2].id}.json`)).toBe(true);
    expect(recordReads()).toBe(2);
    expect(savedIndex().runs).toEqual({ [runs[1].id]: { status: 'completed', day: runs[1].updatedAt.slice(0, 10) } });
  });

  it('re-reads a candidate first and keeps a run another machine reopened', async () => {
    const reopened = record(1, { status: 'running', machine: 'laptop', updatedAt: oldDay }, 120);
    const stale = record(2, { updatedAt: oldDay }, 120);
    const index = { schema: 'studio.agent-run-index.v1', runs: { [reopened.id]: { status: 'completed', day: oldDay.slice(0, 10) } } };
    const { store, files } = fixture([reopened, stale], index);

    await store.prune(projectPath, 'project', new Set(), NOW);

    expect(files.has(`${folder}/${reopened.id}.json`)).toBe(true);
    expect(files.has(`${folder}/${stale.id}.json`)).toBe(false);
  });

  it('leaves unreadable records and the assignments of an unverifiable root unchanged', async () => {
    const root = record(1, { updatedAt: oldDay }, 120);
    const child = record(2, { updatedAt: oldDay, workflowId: root.id, parentRunId: root.id }, 120);
    const { store, files } = fixture([root, child]);
    files.set(`${folder}/${root.id}.json`, '{"schema":"damaged"');

    expect(await store.prune(projectPath, 'project', new Set(), NOW)).toBe(0);

    expect(files.has(`${folder}/${root.id}.json`)).toBe(true);
    expect(files.has(`${folder}/${child.id}.json`)).toBe(true);
  });

  it('runs once per project per session and not after the store closes', async () => {
    const runs = [record(0, { updatedAt: oldDay }, 120), record(1, { updatedAt: oldDay }, 120)];
    const first = fixture(runs);
    expect(await first.store.prune(projectPath, 'project', new Set(), NOW)).toBe(2);
    first.files.set(`${folder}/${runs[0].id}.json`, JSON.stringify(runs[0]));
    expect(await first.store.prune(projectPath, 'project', new Set(), NOW)).toBe(2);
    expect(first.files.has(`${folder}/${runs[0].id}.json`)).toBe(true);

    const closed = fixture(runs);
    await closed.store.close();
    expect(await closed.store.prune(projectPath, 'project', new Set(), NOW)).toBe(0);
    expect(closed.adapter.remove).not.toHaveBeenCalled();
  });
});
