import type { StudioPiProviderAuthRecord } from "./StudioPiAuthStorage";
import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

export type StudioPiProviderAuthRecordLike = Pick<
  StudioPiProviderAuthRecord,
  "provider" | "hasAnyAuth"
>;

export function normalizeStudioPiProviderId(value: unknown): string {
  return normalizeStudioPiProviderHint(value);
}

export function hasAuthenticatedStudioPiProvider(
  record: StudioPiProviderAuthRecordLike | null | undefined
): boolean {
  if (!record) {
    return false;
  }
  return record.hasAnyAuth === true;
}
