import { describeCollectionAge, readStudioCollectionSource, selectStudioCollectionData } from '../StudioCollectionSource';
const now = Date.parse('2026-09-08T12:00:00Z');
const source = (changes = {}) => ({ observedAt: '2026-09-08T11:59:00Z', source: { schema: 'studio.source.v1', mode: 'automatic', observedAt: '2026-09-08T11:59:00Z', checkedAt: '2026-09-08T11:59:30Z', maxAgeSeconds: 300, ...changes } });
describe('Studio source freshness', () => {
  it('uses actual instants across offsets and ignores invalid cached output times', () => {
    const value = { observedAt: '2026-09-08T05:00:00-07:00' };
    expect(selectStudioCollectionData({ value }, { json: { observedAt: '2026-09-08T11:00:00Z' } })).toBe(value);
    expect(selectStudioCollectionData({ value }, { json: { observedAt: 'invalid' } })).toBe(value);
  });
  it('always uses source-managed snapshots over cached runs', () => {
    const value = source();
    expect(selectStudioCollectionData({ value }, { json: { observedAt: '2027-01-01', items: [] } })).toBe(value);
  });
  it('separates successful polling from old evidence and reports unavailable sources', () => {
    expect(readStudioCollectionSource(source(), {}, now).status).toBe('current');
    expect(readStudioCollectionSource(source({ observedAt: '2026-09-07T12:00:00Z' }), {}, now).status).toBe('stale');
    expect(readStudioCollectionSource(source({ checkedAt: '2026-09-07T12:00:00Z' }), {}, now).status).toBe('stale');
    expect(readStudioCollectionSource(source({ status: 'error' }), {}, now).status).toBe('unavailable');
    expect(readStudioCollectionSource(source({ status: 'partial' }), {}, now).status).toBe('partial');
    expect(readStudioCollectionSource(source({ observedAt: '2027-01-01T00:00:00Z' }), {}, now).status).toBe('unknown');
    expect(readStudioCollectionSource(source({ observedAt: 'bad' }), {}, now).status).toBe('unknown');
    expect(describeCollectionAge('2026-09-08T11:00:00Z', now)).toBe('1h ago');
  });
});
