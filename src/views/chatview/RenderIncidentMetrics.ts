const INCIDENT_RENDER_COUNT_LIMIT = 1_000_000;
const INCIDENT_RENDER_DURATION_LIMIT_MS = 86_400_000;

export function boundedIncidentRenderCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(INCIDENT_RENDER_COUNT_LIMIT, Math.max(0, Math.floor(value)));
}

export function boundedIncidentRenderDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(INCIDENT_RENDER_DURATION_LIMIT_MS, Math.max(0, Math.round(value)));
}

export function incidentMonotonicNow(ownerWindow: () => Window | null | undefined): number {
  try {
    const value = ownerWindow()?.performance?.now?.();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  } catch {
    // Incident measurement must never affect rendering.
  }
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
