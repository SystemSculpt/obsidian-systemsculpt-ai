import { boundedIncidentRenderCount, boundedIncidentRenderDuration, incidentMonotonicNow } from '../RenderIncidentMetrics';

describe('observational render metric policies', () => {
  it.each([NaN, Infinity, -Infinity, -1])('bounds invalid or negative values: %s', value => {
    expect(boundedIncidentRenderCount(value)).toBe(0);
    expect(boundedIncidentRenderDuration(value)).toBe(0);
  });
  it('preserves count flooring, duration rounding and diagnostic caps', () => {
    expect(boundedIncidentRenderCount(1.8)).toBe(1);
    expect(boundedIncidentRenderDuration(1.8)).toBe(2);
    expect(boundedIncidentRenderCount(2_000_000)).toBe(1_000_000);
    expect(boundedIncidentRenderDuration(100_000_000)).toBe(86_400_000);
  });
  it('uses the surface clock and never lets broken clocks affect rendering', () => {
    expect(incidentMonotonicNow(() => ({ performance: { now: () => 42 } }) as Window)).toBe(42);
    const now = jest.spyOn(Date, 'now').mockReturnValue(123);
    try {
      expect(incidentMonotonicNow(() => { throw new Error('unavailable'); })).toBe(123);
      now.mockReturnValue(NaN);
      expect(incidentMonotonicNow(() => null)).toBe(0);
      now.mockImplementation(() => { throw new Error('clock'); });
      expect(incidentMonotonicNow(() => undefined)).toBe(0);
    } finally { now.mockRestore(); }
  });
});
