import { ClientContinuationDeliveries } from '../ClientContinuationDeliveries';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(kind: 'approval' | 'result') {
  const owner = new ClientContinuationDeliveries();
  owner.opened();
  const delivery = kind === 'approval'
    ? owner.retainApproval({ approvalId: 'approval-1', approved: true, source: 'manual', requestId: 'request-1', callId: 'call-1' })
    : owner.retainResult({ requestId: 'request-1', call: { callId: 'call-1', name: 'write', input: { path: 'note.md' } }, state: 'output-available', output: { success: true } });
  const receipt = (requestId = 'request-1') => kind === 'approval'
    ? owner.acknowledgeApproval('call-1', requestId) : owner.acknowledgeResult('call-1', requestId);
  const retained = () => (kind === 'approval' ? owner.approvals : owner.results).has('call-1');
  const exactProjection = { matches: false };
  const reconcile = () => owner.reconcile('request-1', { result: () => exactProjection.matches, approval: () => exactProjection.matches });
  const context = {
    isActive: () => true, reconcile, publish: jest.fn(), markUnsynchronized: jest.fn(), reportError: jest.fn(),
    streamCompleted: jest.fn(), streamFailed: jest.fn(),
  };
  return { owner, delivery, receipt, retained, exactProjection, context };
}

describe.each(['approval', 'result'] as const)('retained managed %s delivery', kind => {
  it('clears both delivery kinds and prevents an in-flight continuation from being replayed', async () => {
    const h = harness(kind);
    h.owner.retainApproval({ approvalId: 'other-approval', approved: false, source: 'manual', requestId: 'request-1', callId: 'other-call' });
    h.owner.retainResult({ requestId: 'request-1', call: { callId: 'other-call', name: 'write', input: {} }, state: 'output-error', errorText: 'Failed' });
    const stream = deferred();
    const send = jest.fn(() => stream.promise);
    const task = h.owner.deliver(h.delivery, { ...h.context, prepare: () => send });
    h.owner.clear();
    expect(h.owner.results.size).toBe(0);
    expect(h.owner.approvals.size).toBe(0);
    expect(h.receipt()).toBeNull();
    h.owner.opened();
    stream.resolve();
    await task;
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.context.markUnsynchronized).not.toHaveBeenCalled();
    expect(h.context.reportError).not.toHaveBeenCalled();
  });

  it('requires a current in-flight ACK and exact projection before retirement', async () => {
    const h = harness(kind);
    const stream = deferred();
    const send = jest.fn(() => stream.promise);
    expect(h.receipt()).toBeNull();
    const task = h.owner.deliver(h.delivery, { ...h.context, prepare: () => send });
    expect(h.delivery.inFlight).toBe(true);
    expect(h.receipt('wrong-request')).toBeNull();
    expect(h.receipt()?.first).toBe(true);
    expect(h.receipt()?.first).toBe(false);
    h.context.reconcile();
    expect(h.retained()).toBe(true);
    h.exactProjection.matches = true;
    h.context.reconcile();
    expect(h.retained()).toBe(false);
    stream.resolve();
    await task;
    expect(h.context.markUnsynchronized).not.toHaveBeenCalled();
    expect(h.delivery.inFlight).toBe(false);
  });

  it('retains ACK-only EOF and replays exact data only after a fresh authority preflight', async () => {
    const h = harness(kind);
    const send = jest.fn(async () => { h.receipt(); });
    const prepare = jest.fn(() => send);
    await h.owner.deliver(h.delivery, { ...h.context, prepare });
    expect(h.retained()).toBe(true);
    expect(h.context.markUnsynchronized).toHaveBeenCalledTimes(1);
    expect(h.delivery.attemptedOpenEpoch).toBeNull();
    h.owner.opened();
    await h.owner.deliver(h.delivery, { ...h.context, prepare });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.receipt()).toBeNull();
    expect(h.retained()).toBe(true);
  });

  it('does not interpret old-epoch reader completion as current success or skip reauthorization', async () => {
    const h = harness(kind);
    const stream = deferred();
    const send = jest.fn(() => stream.promise);
    let allowed = true;
    const prepare = jest.fn(() => allowed ? send : undefined);
    const attempt = { ...h.context, prepare };
    const task = h.owner.deliver(h.delivery, attempt);
    h.owner.opened();
    expect(h.receipt()).toBeNull();
    await h.owner.deliver(h.delivery, attempt);
    expect(send).toHaveBeenCalledTimes(1);
    allowed = false;
    stream.resolve();
    await task;
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.context.streamCompleted).not.toHaveBeenCalled();
    expect(h.context.markUnsynchronized).not.toHaveBeenCalled();
    expect(h.retained()).toBe(true);
  });

  it('keeps ACK diagnostics once-only across failed continuation streams and retries', async () => {
    const h = harness(kind);
    const first: boolean[] = [];
    const send = jest.fn(async () => {
      first.push(h.receipt()!.first);
      throw new Error('stream failed after ACK');
    });
    const attempt = { ...h.context, prepare: () => send };
    await h.owner.deliver(h.delivery, attempt);
    expect(h.retained()).toBe(true);
    expect(h.context.reportError).toHaveBeenCalledTimes(1);
    h.owner.opened();
    await h.owner.deliver(h.delivery, attempt);
    expect(first).toEqual([true, false]);
    expect(h.context.streamFailed).toHaveBeenCalledTimes(2);
    expect(h.delivery.inFlight).toBe(false);
  });
});
