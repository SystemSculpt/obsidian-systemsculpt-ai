import type { StudioJsonValue, StudioNodeOutputMap } from './types';
import { isRecord } from './utils';
import { readCollectionField } from './StudioCollection';

export type StudioCollectionSourceState = {
  status: 'current' | 'stale' | 'unavailable' | 'partial' | 'unknown' | 'snapshot';
  label: string;
  message: string;
  observedAt: string;
  checkedAt: string;
  automatic: boolean;
};

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown, limit = 500): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** Source-owned snapshots always outrank an old run's cached outputs. */
export function selectStudioCollectionData(config: Record<string, StudioJsonValue>, outputs: StudioNodeOutputMap): unknown {
  if (readCollectionField(config.value, 'source.schema') === 'studio.source.v1') return config.value;
  if (outputs.json === undefined) return config.value ?? { items: [] };
  const savedAt = timestamp(readCollectionField(config.value, 'observedAt'));
  const outputAt = timestamp(readCollectionField(outputs.json, 'observedAt'));
  return savedAt !== null && (outputAt === null || outputAt < savedAt) ? config.value : outputs.json;
}

/** Checked time is transport health; observed time is the age of the actual evidence. */
export function readStudioCollectionSource(data: unknown, config: Record<string, StudioJsonValue>, now = Date.now()): StudioCollectionSourceState {
  const raw = readCollectionField(data, 'source');
  const source = isRecord(raw) && raw.schema === 'studio.source.v1' ? raw : {};
  const observedAt = text(source.observedAt ?? readCollectionField(data, 'observedAt'));
  const checkedAt = text(source.checkedAt);
  const observed = timestamp(observedAt), checked = timestamp(checkedAt);
  const automatic = source.mode === 'automatic';
  const limit = Number(source.maxAgeSeconds ?? config.freshnessSeconds ?? 300);
  const maxAge = Number.isFinite(limit) ? Math.max(30, Math.min(604800, limit)) * 1000 : 300000;
  const result: StudioCollectionSourceState = {
    status: automatic ? 'current' : 'snapshot', label: text(source.label) || 'Source',
    message: text(source.message), observedAt, checkedAt, automatic,
  };
  if (source.status === 'error' || source.status === 'unavailable') {
    result.status = 'unavailable';
    result.message ||= 'Source refresh failed. Showing the last complete snapshot.';
  } else if (source.status === 'partial') {
    result.status = 'partial';
    result.message ||= 'Some sources could not be refreshed. Previous evidence is retained.';
  } else if (observed === null || observed > now + 60000 || (checked !== null && checked > now + 60000)) {
    result.status = 'unknown';
    result.message ||= 'The source has no valid observation time.';
  } else if (now - observed > maxAge || (automatic && (checked === null || now - checked > maxAge))) {
    result.status = 'stale';
    result.message ||= 'The source has not supplied fresh evidence. Showing the last complete snapshot.';
  }
  return result;
}

export function describeCollectionAge(value: string, now = Date.now()): string {
  const time = timestamp(value);
  if (time === null || time > now + 60000) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
